import type { Context } from 'hono'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import type { PgQueryClient } from '../../utils/pg.ts'
import { beginWriteTransaction, checkoutPgClient, closeClient, getPgClient, releasePgClient } from '../../utils/pg.ts'
import { recordBuildTime } from '../../utils/supabase.ts'
import { getEnv, trimTrailingSlashes } from '../../utils/utils.ts'
import { reserveSimulatorSlot } from './concurrency.ts'
import { ensureBuildPermission, ensureBuildTimePlanAllowed, getBuildOwnerOrg } from './request.ts'

export interface SimulatorBody {
  app_id?: string
  platform?: string
  name?: string
}

export interface EmulatorSessionData {
  id: string
  url: string
  status?: string
  remoteConfig?: unknown
}

const DEFAULT_SIMULATOR_ORIGIN = 'https://ios-emulator.capgo.app'

export function emulatorSessionCreateBody(input: { appId: string, platform: 'ios' | 'android', orgId: string, name?: string }) {
  return {
    appId: input.appId,
    platform: input.platform,
    orgId: input.orgId,
    name: input.name,
    type: 'agent-device',
    maxDurationMinutes: 40,
  }
}

export function simulatorBillableSeconds(startedAt: string | null, now = Date.now()): number {
  if (!startedAt)
    return 0
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started))
    return 0
  return Math.max(1, Math.round((now - started) / 1000))
}

function requirePlatform(value: string | undefined): 'ios' | 'android' {
  if (value === 'ios' || value === 'android')
    return value
  throw simpleError('invalid_request', 'platform must be ios or android.')
}

function requireAppId(value: string | undefined): string {
  const appId = value?.trim()
  if (!appId)
    throw simpleError('invalid_request', 'app_id is required.')
  return appId
}

async function queryWrite<T extends object>(c: Context, sql: string, params: unknown[]): Promise<T[]> {
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

async function queryRead<T extends object>(c: Context, sql: string, params: unknown[]): Promise<T[]> {
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

interface SimulatorRow {
  id: string
  app_id: string
  platform: 'ios' | 'android'
  status: string
  url: string | null
  emulator_id: string | null
  started_at: string | null
  requested_by: string
}

async function markSession(c: Context, id: string, status: 'in-progress' | 'stopped' | 'errored', extra?: { url?: string, emulatorId?: string }) {
  await queryWrite(c, `
    UPDATE public.simulator_sessions
    SET status = $2,
        url = COALESCE($3, url),
        emulator_id = COALESCE($4, emulator_id),
        started_at = CASE WHEN $2 = 'in-progress' THEN now() ELSE started_at END,
        finished_at = CASE WHEN $2 IN ('stopped', 'errored') THEN now() ELSE finished_at END,
        updated_at = now()
    WHERE id = $1::uuid
  `, [id, status, extra?.url ?? null, extra?.emulatorId ?? null])
}

async function postEmulator(origin: string, accessKey: string, path: string, method: string, body?: unknown): Promise<EmulatorSessionData | undefined> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${accessKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => undefined) as { data?: EmulatorSessionData, error?: string } | undefined
  if (!response.ok)
    throw new Error(payload?.error || `Simulator request failed (${response.status})`)
  return payload?.data
}

function simulatorConfig(c: Context) {
  const accessKey = getEnv(c, 'SIMULATOR_ACCESS_KEY')
  if (!accessKey)
    throw quickError(503, 'simulator_not_configured', 'Simulator is not configured.', {}, undefined, { alert: false })
  const origin = trimTrailingSlashes(getEnv(c, 'SIMULATOR_ORIGIN') || DEFAULT_SIMULATOR_ORIGIN)
  return { accessKey, origin }
}

async function ownedSession(c: Context, principal: RlsPrincipal, userId: string, appId: string, sessionId: string) {
  await ensureBuildPermission(c, appId, userId)
  const orgId = await getBuildOwnerOrg(c, principal, appId)
  const rows = await queryRead<SimulatorRow>(c, `
    SELECT id, app_id, platform, status, url, emulator_id, started_at, requested_by
    FROM public.simulator_sessions
    WHERE id = $1::uuid AND owner_org = $2 AND app_id = $3
  `, [sessionId, orgId, appId])
  const row = rows[0]
  if (!row)
    throw simpleError('not_found', 'Simulator session not found.')
  return { orgId, row }
}

export async function startSimulator(c: Context, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const platform = requirePlatform(body.platform)
  const name = body.name?.trim() || undefined
  await ensureBuildPermission(c, appId, userId)
  const orgId = await getBuildOwnerOrg(c, principal, appId)
  await ensureBuildTimePlanAllowed(c, principal, orgId, appId)
  const slot = await reserveSimulatorSlot(c, { orgId, appId, userId, platform, name })
  let emulatorId = ''
  try {
    const { accessKey, origin } = simulatorConfig(c)
    const device = await postEmulator(origin, accessKey, '/v2/device-run-sessions', 'POST', emulatorSessionCreateBody({ appId, platform, orgId, name }))
    if (!device?.id || !device.url)
      throw new Error('Simulator did not return a session URL.')
    emulatorId = device.id
    await markSession(c, slot.id, 'in-progress', { url: device.url, emulatorId: device.id })
    return c.json({
      data: {
        id: slot.id,
        url: device.url,
        status: 'in-progress',
        platform,
        kind: 'simulator',
        remoteConfig: device.remoteConfig ?? null,
      },
    })
  }
  catch (error) {
    try {
      if (emulatorId) {
        const { accessKey, origin } = simulatorConfig(c)
        await postEmulator(origin, accessKey, `/v2/device-run-sessions/${emulatorId}/stop`, 'POST', {})
      }
    }
    catch {
      // The slot is released below even when the device host is already gone.
    }
    try {
      await markSession(c, slot.id, 'errored')
    }
    catch (markError) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to release simulator slot', error: markError })
    }
    if (error instanceof Error && error.name === 'HTTPException')
      throw error
    throw quickError(502, 'simulator_unavailable', error instanceof Error ? error.message : 'Simulator did not start.', { app_id: appId }, error, { alert: false })
  }
}

export async function readSimulator(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const { row } = await ownedSession(c, principal, userId, appId, sessionId)
  return c.json({
    data: {
      id: row.id,
      url: row.url,
      status: row.status,
      platform: row.platform,
      kind: 'simulator',
    },
  })
}

export async function stopSimulator(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const { orgId, row } = await ownedSession(c, principal, userId, appId, sessionId)
  if (row.status === 'stopped' || row.status === 'errored') {
    return c.json({ data: { id: row.id, url: row.url, status: row.status, platform: row.platform, kind: 'simulator' } })
  }
  const { accessKey, origin } = simulatorConfig(c)
  if (row.emulator_id) {
    try {
      await postEmulator(origin, accessKey, `/v2/device-run-sessions/${row.emulator_id}/stop`, 'POST', {})
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator stop failed', sessionId, error })
    }
  }
  await markSession(c, row.id, 'stopped')
  const seconds = simulatorBillableSeconds(row.started_at)
  if (seconds > 0)
    await recordBuildTime(c, orgId, row.requested_by || userId, row.id, row.platform, seconds, Date.now(), appId)
  return c.json({ data: { id: row.id, url: row.url, status: 'stopped', platform: row.platform, kind: 'simulator', build_time_seconds: seconds } })
}
