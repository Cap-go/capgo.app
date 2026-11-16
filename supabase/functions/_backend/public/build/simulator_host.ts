import type { Context } from 'hono'
import type { PgQueryClient } from '../../utils/pg.ts'
import { quickError } from '../../utils/hono.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { beginWriteTransaction, checkoutPgClient, closeClient, getPgClient, releasePgClient } from '../../utils/pg.ts'
import { getEnv, trimTrailingSlashes } from '../../utils/utils.ts'

// A simulator stops on its own after SIMULATOR_IDLE_MINUTES without input (taps, typing,
// installs, agent commands), and after SIMULATOR_MAX_MINUTES in any case.
export const SIMULATOR_MAX_MINUTES = 40
export const SIMULATOR_IDLE_MINUTES = 5

export interface EmulatorSessionData {
  id: string
  url: string
  status?: string
  remoteConfig?: unknown
  finishedAt?: string | null
}

const DEFAULT_SIMULATOR_ORIGIN = 'https://ios-emulator.capgo.app'
export const SIMULATOR_HOST_TIMEOUT_MS = 30_000
// Checking for stopped devices runs before a build or simulator takes a slot: keep it short.
const DEVICE_CHECK_TIMEOUT_MS = 5_000

export class SimulatorHostError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'SimulatorHostError'
  }
}

export function simulatorConfig(c: Context) {
  const accessKey = getEnv(c, 'SIMULATOR_ACCESS_KEY')
  if (!accessKey)
    throw quickError(503, 'simulator_not_configured', 'Simulator is not configured.', {}, undefined, { alert: false })
  const origin = trimTrailingSlashes(getEnv(c, 'SIMULATOR_ORIGIN') || DEFAULT_SIMULATOR_ORIGIN)
  return { accessKey, origin }
}

export async function postEmulator(origin: string, accessKey: string, path: string, method: string, body?: unknown, timeoutMs = SIMULATOR_HOST_TIMEOUT_MS): Promise<{ status: number, data?: EmulatorSessionData }> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const payload = await response.json().catch(() => undefined) as { data?: EmulatorSessionData, error?: string } | undefined
  if (!response.ok)
    throw new SimulatorHostError(payload?.error || `Simulator request failed (${response.status})`, response.status)
  return { status: response.status, data: payload?.data }
}

// When the device host already ended the session (no input for a while, or its maximum
// duration), the moment it stopped. Undefined while the device still runs.
export function deviceStopTime(device: EmulatorSessionData | undefined, now = Date.now()): string | undefined {
  if (device?.status !== 'stopped' && device?.status !== 'errored')
    return undefined
  const finished = Date.parse(device.finishedAt ?? '')
  return new Date(Number.isFinite(finished) ? Math.min(finished, now) : now).toISOString()
}

export async function queryWrite<T extends object>(c: Context, sql: string, params: unknown[]): Promise<T[]> {
  let pgPool: Awaited<ReturnType<typeof getPgClient>> | null = null
  let client: PgQueryClient | null = null
  try {
    pgPool = await getPgClient(c)
    client = await checkoutPgClient(pgPool)
    await beginWriteTransaction(client)
    const result = await client.query(sql, params)
    await client.query('COMMIT')
    return result.rows as T[]
  }
  catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK')
      }
      catch {
        // Preserve the original error.
      }
    }
    throw error
  }
  finally {
    releasePgClient(pgPool, client)
    if (pgPool)
      await closeClient(c, pgPool)
  }
}

export async function queryRead<T extends object>(c: Context, sql: string, params: unknown[]): Promise<T[]> {
  let pgPool: Awaited<ReturnType<typeof getPgClient>> | null = null
  let client: PgQueryClient | null = null
  try {
    pgPool = await getPgClient(c, true)
    client = await checkoutPgClient(pgPool)
    const result = await client.query(sql, params)
    return result.rows as T[]
  }
  finally {
    releasePgClient(pgPool, client)
    if (pgPool)
      await closeClient(c, pgPool)
  }
}

export async function rememberDeviceStop(c: Context, id: string, stoppedAt: string) {
  const rows = await queryWrite<{ device_stopped_at: string }>(c, `
    UPDATE public.simulator_sessions
    SET device_stopped_at = COALESCE(device_stopped_at, $2::timestamptz),
        updated_at = now()
    WHERE id = $1::uuid
    RETURNING device_stopped_at
  `, [id, stoppedAt])
  return rows[0]?.device_stopped_at ?? stoppedAt
}

// The device host stops an unused session by itself. Copy its stop time here, so
// expire_simulator_sessions frees the builder slot now and bills only up to that stop,
// not up to the maximum duration. Never throws: a slow or unreachable host must not block
// a build, and the maximum-duration sweep still settles the session later.
export async function recordStoppedSimulatorDevices(c: Context, orgId: string): Promise<void> {
  const accessKey = getEnv(c, 'SIMULATOR_ACCESS_KEY')
  if (!accessKey)
    return
  const origin = trimTrailingSlashes(getEnv(c, 'SIMULATOR_ORIGIN') || DEFAULT_SIMULATOR_ORIGIN)
  try {
    // Bounded by simulator_sessions_owner_active_idx: at most the org's builder slots.
    const running = await queryWrite<{ id: string, emulator_id: string }>(c, `
      SELECT id, emulator_id
      FROM public.simulator_sessions
      WHERE owner_org = $1
        AND status IN ('new', 'queued', 'starting', 'in-progress')
        AND emulator_id IS NOT NULL
        AND device_stopped_at IS NULL
    `, [orgId])
    await Promise.all(running.map(async (row) => {
      try {
        const found = await postEmulator(origin, accessKey, `/v2/device-run-sessions/${encodeURIComponent(row.emulator_id)}`, 'GET', undefined, DEVICE_CHECK_TIMEOUT_MS)
        const stoppedAt = deviceStopTime(found.data)
        if (stoppedAt)
          await rememberDeviceStop(c, row.id, stoppedAt)
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator device check failed', sessionId: row.id, error })
      }
    }))
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator device checks failed', orgId, error })
  }
}
