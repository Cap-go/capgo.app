import type { Context } from 'hono'
import type { RlsPrincipal } from '../../utils/pg_rls.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { recordBuildTime } from '../../utils/supabase.ts'
import { backgroundTask } from '../../utils/utils.ts'
import { expireSimulatorSessions, reserveSimulatorSlot, SIMULATOR_IDLE_TIMEOUT_MINUTES, SIMULATOR_MAX_DURATION_MINUTES } from './concurrency.ts'

export { SIMULATOR_IDLE_TIMEOUT_MINUTES, SIMULATOR_MAX_DURATION_MINUTES } from './concurrency.ts'
import { savedOutputsForJobs } from './outputs.ts'
import { ensureBuildPermission, ensureBuildTimePlanAllowed, getBuildOwnerOrg } from './request.ts'
import type { EmulatorSessionData } from './simulator_host.ts'
import {
  postEmulator,
  queryRead,
  queryWrite,
  rememberDeviceStop,
  SIMULATOR_HOST_TIMEOUT_MS,
  SimulatorHostError,
  simulatorConfig,
} from './simulator_host.ts'

export type { EmulatorSessionData } from './simulator_host.ts'

export interface SimulatorBody {
  app_id?: string
  platform?: string
  name?: string
  build_job_id?: string
  command?: string
  x?: number
  y?: number
  bundle_id?: string
}

const HOST_TERMINAL_SESSION_STATUSES = new Set(['stopped', 'errored'])

export function hostEmulatorSessionTerminal(status: string | undefined): boolean {
  return status !== undefined && HOST_TERMINAL_SESSION_STATUSES.has(status)
}

export const SIMULATOR_DEVICE_COMMANDS = ['devices', 'screenshot', 'snapshot', 'home', 'lock', 'tap', 'open'] as const
const SIMULATOR_SCREENSHOT_MAX_BYTES = 1_500_000

export function simulatorDeviceUrl(sessionUrl: string, path: string): string {
  const base = sessionUrl.endsWith('/') ? sessionUrl : `${sessionUrl}/`
  return new URL(path.replace(/^\//, ''), base).href
}

export async function wakeSimulatorAndRecordActivity(c: Context, sessionId: string, sessionUrl: string, accessKey: string) {
  await wakeSimulatorDevice(sessionUrl, accessKey)
  await touchSimulatorActivity(c, sessionId)
}

async function wakeSimulatorDevice(sessionUrl: string, accessKey: string) {
  try {
    const response = await fetch(simulatorDeviceUrl(sessionUrl, 'api/status'), {
      headers: { Authorization: `Bearer ${accessKey}` },
      signal: AbortSignal.timeout(120_000),
    })
    await response.body?.cancel()
  }
  catch {
    // The container keeps booting after the request that started it.
  }
}

export function simulatorCommandRpc(input: { command: string, x?: number, y?: number, bundleId?: string }) {
  if (!(SIMULATOR_DEVICE_COMMANDS as readonly string[]).includes(input.command))
    throw simpleError('invalid_request', 'command must be devices, screenshot, snapshot, home, lock, tap, or open.')
  if (input.command === 'tap' && (!Number.isFinite(input.x) || !Number.isFinite(input.y)))
    throw simpleError('invalid_request', 'tap requires x and y.')
  if (input.command === 'open' && !input.bundleId)
    throw simpleError('invalid_request', 'open requires bundle_id.')
  const flags: Record<string, unknown> = {}
  const body: Record<string, unknown> = {}
  if (input.command === 'tap') {
    flags.x = input.x
    flags.y = input.y
    body.x = input.x
    body.y = input.y
  }
  if (input.command === 'open') {
    flags.bundleId = input.bundleId
    body.app = input.bundleId
  }
  const positionals: unknown[] = input.command === 'tap' ? [String(input.x), String(input.y)] : []
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'agent_device.command' as const,
    params: { command: input.command, positionals, flags, input: body },
  }
}

export async function readCappedBytes(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let tooLarge = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      if (!value)
        continue
      if (total + value.byteLength > maxBytes) {
        tooLarge = true
        break
      }
      chunks.push(value)
      total += value.byteLength
    }
    if (tooLarge)
      await reader.cancel()
  }
  finally {
    reader.releaseLock()
  }
  if (tooLarge)
    throw new Error('too-large')
  if (total === 0)
    throw new Error('empty')
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export { SIMULATOR_HOST_TIMEOUT_MS } from './simulator_host.ts'
export const SIMULATOR_ORG_HOST_SYNC_BUDGET_MS = 5_000
export const SIMULATOR_ORG_HOST_SYNC_TIMEOUT_MS = 2_500
export const SIMULATOR_ORG_HOST_SYNC_CONCURRENCY = 4
const SIMULATOR_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const SAVED_IPA_MAX_BYTES = 512 * 1024 * 1024
const SAVED_IPA_TRANSFER_MS = 60_000
const SAVED_IPA_INSTALL_MS = 180_000

export function savedIpaContentLength(header: string | null): number | undefined {
  if (!header)
    return undefined
  const length = Number(header)
  if (!Number.isFinite(length) || length < 0)
    return undefined
  return length
}

// The saved IPA as the raw request body, capped at maxBytes. The simulator host's firewall answers
// large multipart uploads with a challenge page instead of passing them on; a raw body passes.
export function ipaUploadStream(body: ReadableStream<Uint8Array>, maxBytes = SAVED_IPA_MAX_BYTES): ReadableStream<Uint8Array> {
  let sent = 0
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sent += chunk.byteLength
      if (sent > maxBytes)
        throw new Error('The saved build is too large to install.')
      controller.enqueue(chunk)
    },
  }))
}

export function emulatorSessionCreateBody(input: { id?: string, appId: string, platform: 'ios' | 'android', orgId: string, name?: string }) {
  return {
    ...(input.id ? { id: input.id } : {}),
    appId: input.appId,
    platform: input.platform,
    orgId: input.orgId,
    name: input.name,
    type: 'agent-device',
    maxDurationMinutes: SIMULATOR_MAX_DURATION_MINUTES,
    maxIdleTimeMinutes: SIMULATOR_IDLE_TIMEOUT_MINUTES,
  }
}

export function simulatorUsageEnd(deviceStoppedAt: string | Date | null, now = Date.now()): number {
  if (!deviceStoppedAt)
    return now
  const parsed = deviceStoppedAt instanceof Date ? deviceStoppedAt.getTime() : Date.parse(deviceStoppedAt)
  return Number.isFinite(parsed) ? parsed : now
}

export function simulatorBillingInstant(startedAt: string | null, stoppedAt: number, maxDurationMinutes = SIMULATOR_MAX_DURATION_MINUTES): number {
  if (!startedAt)
    return stoppedAt
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started))
    return stoppedAt
  return Math.min(stoppedAt, started + Math.max(1, maxDurationMinutes) * 60_000)
}

export function simulatorBillableSeconds(startedAt: string | null, now = Date.now(), maxDurationMinutes = SIMULATOR_MAX_DURATION_MINUTES): number {
  if (!startedAt)
    return 0
  const started = Date.parse(startedAt)
  if (!Number.isFinite(started))
    return 0
  const elapsed = Math.max(1, Math.round((now - started) / 1000))
  const cap = Math.max(1, maxDurationMinutes) * 60
  return Math.min(elapsed, cap)
}

export function simulatorBillingEndInstant(
  startedAt: string | null,
  lastActivityAt: string | null,
  stoppedAt: number,
  maxDurationMinutes = SIMULATOR_MAX_DURATION_MINUTES,
  idleTimeoutMinutes = SIMULATOR_IDLE_TIMEOUT_MINUTES,
): number {
  if (!startedAt)
    return stoppedAt
  const opened = Date.parse(startedAt)
  if (!Number.isFinite(opened))
    return stoppedAt
  const activitySource = lastActivityAt ?? startedAt
  const activity = Date.parse(activitySource)
  const activityAt = Number.isFinite(activity) ? activity : opened
  const maxEnd = opened + Math.max(1, maxDurationMinutes) * 60_000
  const idleEnd = activityAt + Math.max(1, idleTimeoutMinutes) * 60_000
  return Math.min(stoppedAt, maxEnd, idleEnd)
}

export function simulatorBillableSecondsWithIdle(
  startedAt: string | null,
  lastActivityAt: string | null,
  now = Date.now(),
  maxDurationMinutes = SIMULATOR_MAX_DURATION_MINUTES,
  idleTimeoutMinutes = SIMULATOR_IDLE_TIMEOUT_MINUTES,
): number {
  const end = simulatorBillingEndInstant(startedAt, lastActivityAt, now, maxDurationMinutes, idleTimeoutMinutes)
  return simulatorBillableSeconds(startedAt, end, maxDurationMinutes)
}

async function bestEffortStopSimulatorDevice(c: Context, row: Pick<SimulatorRow, 'id' | 'emulator_id' | 'device_stopped_at'>): Promise<string | null> {
  if (row.device_stopped_at)
    return row.device_stopped_at
  if (!row.emulator_id)
    return null
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const remoteStatus = await stopRemoteDevice(c, row.emulator_id, row.id, row.id)
      if (!simulatorHostStopIsFinal(remoteStatus))
        return null
      try {
        return await rememberDeviceStop(c, row.id, new Date().toISOString())
      }
      catch (rememberError) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Idle expiry could not record device stop time', sessionId: row.id, error: rememberError })
        return null
      }
    }
    catch (error) {
      lastError = error
      if (attempt === 0)
        continue
    }
  }
  cloudlogErr({ requestId: c.get('requestId'), message: 'Idle expiry could not stop the simulator device', sessionId: row.id, error: lastError })
  return null
}

async function finalizeExpiredSimulatorSession(
  c: Context,
  input: { orgId: string, userId: string, appId: string, row: SimulatorRow },
) {
  const now = Date.now()
  const deviceStoppedAt = await bestEffortStopSimulatorDevice(c, input.row)
  if (input.row.emulator_id && !deviceStoppedAt)
    return
  const usageEnd = simulatorUsageEnd(deviceStoppedAt, now)
  const maxMinutes = Number(input.row.max_duration_minutes) || SIMULATOR_MAX_DURATION_MINUTES
  const billEnd = simulatorBillingEndInstant(input.row.started_at, input.row.last_activity_at, usageEnd, maxMinutes)
  const seconds = simulatorBillableSeconds(input.row.started_at, billEnd, maxMinutes)
  const platform = input.row.platform === 'android' ? 'android' : 'ios'
  let billingRecorded = seconds === 0
  if (seconds > 0) {
    const billingId = await recordBuildTime(c, input.orgId, input.row.requested_by || input.userId, input.row.id, platform, seconds, billEnd, input.appId)
    billingRecorded = billingId !== null
  }
  if (!billingRecorded)
    return
  const finishedAt = deviceStoppedAt ?? new Date(billEnd).toISOString()
  await markSession(c, input.row.id, 'stopped', { finishedAt })
}

export async function stopOrphanedSimulatorDevices(c: Context, limit = 50): Promise<number> {
  const rows = await queryWrite<Pick<SimulatorRow, 'id' | 'emulator_id' | 'device_stopped_at'>>(c, `
    SELECT id, emulator_id, device_stopped_at
    FROM public.simulator_sessions
    WHERE status = 'stopped'
      AND emulator_id IS NOT NULL
      AND device_stopped_at IS NULL
    ORDER BY updated_at ASC
    LIMIT $1
  `, [limit])
  for (const row of rows) {
    if (!row.emulator_id || row.device_stopped_at)
      continue
    try {
      const stoppedAt = await bestEffortStopSimulatorDevice(c, row)
      if (!stoppedAt)
        await queryWrite(c, `UPDATE public.simulator_sessions SET updated_at = now() WHERE id = $1::uuid`, [row.id])
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to stop orphaned simulator device', sessionId: row.id, error })
      await queryWrite(c, `UPDATE public.simulator_sessions SET updated_at = now() WHERE id = $1::uuid`, [row.id])
    }
  }
  return rows.length
}

export async function stopDevicesForDueSimulatorExpiry(
  c: Context,
  sessions: Array<Pick<SimulatorRow, 'id' | 'emulator_id' | 'device_stopped_at'>>,
): Promise<void> {
  for (const row of sessions) {
    if (!row.emulator_id || row.device_stopped_at)
      continue
    try {
      await bestEffortStopSimulatorDevice(c, row)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to stop simulator device after expiry', sessionId: row.id, error })
    }
  }
}

export const simulatorActivityBumpSql = () => `
        SELECT public.bump_simulator_session_activity($1::uuid) AS bumped
      `

export async function bumpSimulatorSessionActivity(c: Context, sessionId: string): Promise<boolean> {
  const rows = await queryWrite<{ bumped: number }>(c, simulatorActivityBumpSql(), [sessionId])
  return Number(rows[0]?.bumped) === 1
}

type SimulatorActivityTouch = { bump?: boolean }

export async function touchSimulatorActivity(
  c: Context,
  sessionId: string,
  context?: { orgId: string, userId: string, appId: string, row: SimulatorRow },
  options?: SimulatorActivityTouch,
): Promise<'bumped' | 'expired' | 'skipped'> {
  const bump = options?.bump !== false
  if (!bump) {
    if (context?.row.status === 'in-progress' && simulatorSessionPastExpiry(context.row)) {
      await finalizeExpiredSimulatorSession(c, context)
      return 'expired'
    }
    return 'skipped'
  }
  try {
    const rows = await queryWrite<{ bumped: number }>(c, simulatorActivityBumpSql(), [sessionId])
    if (Number(rows[0]?.bumped) === 1)
      return 'bumped'
    if (!context || context.row.status !== 'in-progress' || !simulatorSessionPastExpiry(context.row))
      return 'skipped'
    await finalizeExpiredSimulatorSession(c, context)
    return 'expired'
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to record simulator activity', sessionId, error })
    if (context?.row.status === 'in-progress' && simulatorSessionPastExpiry(context.row)) {
      await finalizeExpiredSimulatorSession(c, context)
      return 'expired'
    }
    return 'skipped'
  }
}

function requirePlatform(value: unknown): 'ios' | 'android' {
  if (value === 'ios' || value === 'android')
    return value
  throw simpleError('invalid_request', 'platform must be ios or android.')
}

function requireAppId(value: unknown): string {
  if (typeof value !== 'string')
    throw simpleError('invalid_request', 'app_id is required.')
  const appId = value.trim()
  if (!appId)
    throw simpleError('invalid_request', 'app_id is required.')
  return appId
}

export function simulatorRequestFields(body: { app_id?: unknown, platform?: unknown, name?: unknown }) {
  return {
    appId: requireAppId(body.app_id),
    platform: requirePlatform(body.platform),
    name: simulatorSessionName(body.name),
  }
}

function simulatorSessionName(value: unknown) {
  if (value == null)
    return undefined
  if (typeof value !== 'string')
    throw simpleError('invalid_request', 'name must be a string.')
  const name = value.trim()
  return name || undefined
}

export function isSimulatorSessionId(value: string) {
  return SIMULATOR_SESSION_ID.test(value)
}

interface SimulatorRow {
  id: string
  app_id: string
  platform: 'ios' | 'android'
  status: string
  url: string | null
  emulator_id: string | null
  started_at: string | null
  last_activity_at: string | null
  device_stopped_at: string | null
  requested_by: string
  max_duration_minutes: number
}

export function simulatorSessionPastExpiry(
  row: Pick<SimulatorRow, 'started_at' | 'last_activity_at' | 'max_duration_minutes'>,
  now = Date.now(),
): boolean {
  if (!row.started_at)
    return false
  const maxMinutes = Number(row.max_duration_minutes) || SIMULATOR_MAX_DURATION_MINUTES
  const opened = Date.parse(row.started_at)
  if (!Number.isFinite(opened))
    return false
  if (now >= opened + maxMinutes * 60_000)
    return true
  const activitySource = row.last_activity_at ?? row.started_at
  const activity = Date.parse(activitySource)
  if (!Number.isFinite(activity))
    return false
  return now >= activity + SIMULATOR_IDLE_TIMEOUT_MINUTES * 60_000
}

export async function markSession(c: Context, id: string, status: 'in-progress' | 'stopped' | 'errored', extra?: { url?: string, emulatorId?: string, finishedAt?: string }) {
  const rows = await queryWrite<{ id: string }>(c, `
    UPDATE public.simulator_sessions
    SET status = $2,
        url = COALESCE($3, url),
        emulator_id = COALESCE($4, emulator_id),
        started_at = CASE WHEN $2 = 'in-progress' AND started_at IS NULL THEN now() ELSE started_at END,
        last_activity_at = CASE WHEN $2 = 'in-progress' THEN now() ELSE last_activity_at END,
        finished_at = CASE WHEN $2 IN ('stopped', 'errored') THEN COALESCE($5::timestamptz, now()) ELSE finished_at END,
        updated_at = now()
    WHERE id = $1::uuid
    RETURNING id
  `, [id, status, extra?.url ?? null, extra?.emulatorId ?? null, extra?.finishedAt ?? null])
  if (rows.length !== 1)
    throw simpleError('not_found', 'Simulator session not found.')
}

export function simulatorHostStopIsFinal(status: number): boolean {
  return status === 200 || status === 204 || status === 404 || status === 409
}

export function startupFailureKeepsSlot(emulatorId: string, deviceStopped: boolean): boolean {
  return emulatorId !== '' && !deviceStopped
}

export function simulatorCreateWasInterrupted(error: unknown): boolean {
  if (error instanceof SimulatorHostError)
    return false
  if (error instanceof Error && error.name === 'HTTPException')
    return false
  if (error instanceof Error && error.message === 'Simulator did not return a session URL.')
    return false
  return true
}

export function canFinishSimulatorStop(input: { remoteStatus: number | null, billingRecorded: boolean, seconds: number }): boolean {
  const remoteDone = input.remoteStatus === null || simulatorHostStopIsFinal(input.remoteStatus)
  if (!remoteDone)
    return false
  if (input.seconds > 0 && !input.billingRecorded)
    return false
  return true
}

export const SIMULATOR_STOPPED_MESSAGE = `This simulator is not running. A simulator stops after ${SIMULATOR_IDLE_TIMEOUT_MINUTES} minutes without input, and after ${SIMULATOR_MAX_DURATION_MINUTES} minutes at most. Start a new one.`

export type SimulatorHostSyncOptions = { hostTimeoutMs?: number }

async function fetchRemoteEmulatorSession(c: Context, emulatorId: string, hostTimeoutMs = SIMULATOR_HOST_TIMEOUT_MS): Promise<EmulatorSessionData | null> {
  try {
    const { accessKey, origin } = simulatorConfig(c)
    const found = await postEmulator(origin, accessKey, `/v2/device-run-sessions/${emulatorId}`, 'GET', undefined, hostTimeoutMs)
    return found.data ?? null
  }
  catch (error) {
    // GET /v2/device-run-sessions/:id returns 404 when the session is gone (ios_linux_emulator cloud/worker.ts lines 136-138); it does not return 409.
    if (error instanceof SimulatorHostError && error.status === 404) {
      return {
        id: emulatorId,
        url: '',
        status: 'stopped',
        finishedAt: new Date().toISOString(),
      }
    }
    return null
  }
}

export async function syncSimulatorSessionFromHost(
  c: Context,
  row: SimulatorRow,
  context: { orgId: string, userId: string },
  options?: SimulatorHostSyncOptions,
): Promise<'synced' | 'finalized' | 'skipped'> {
  if (row.status !== 'in-progress' || !row.emulator_id)
    return 'skipped'
  const host = await fetchRemoteEmulatorSession(c, row.emulator_id, options?.hostTimeoutMs)
  if (!host)
    return 'skipped'
  const working: SimulatorRow = { ...row }
  if (host.lastActivityAt) {
    const updated = await queryWrite<{ last_activity_at: string }>(c, `
      UPDATE public.simulator_sessions
      SET last_activity_at = $2::timestamptz,
          updated_at = now()
      WHERE id = $1::uuid
        AND status = 'in-progress'
        AND (last_activity_at IS NULL OR last_activity_at < $2::timestamptz)
      RETURNING last_activity_at
    `, [row.id, host.lastActivityAt])
    working.last_activity_at = updated[0]?.last_activity_at ?? host.lastActivityAt
  }
  if (hostEmulatorSessionTerminal(host.status)) {
    const stoppedAt = host.finishedAt ?? new Date().toISOString()
    working.device_stopped_at = await rememberDeviceStop(c, row.id, stoppedAt)
    await finalizeExpiredSimulatorSession(c, { orgId: context.orgId, userId: context.userId, appId: row.app_id, row: working })
    return 'finalized'
  }
  if (!host.lastActivityAt)
    return 'skipped'
  if (simulatorSessionPastExpiry(working)) {
    await finalizeExpiredSimulatorSession(c, { orgId: context.orgId, userId: context.userId, appId: row.app_id, row: working })
    return 'finalized'
  }
  return 'synced'
}

export const SIMULATOR_HOST_SYNC_BATCH_LIMIT = 300
export const SIMULATOR_HOST_SYNC_BUDGET_MS = 30_000

export async function syncInProgressSimulatorSessionsFromHost(
  c: Context,
  limit = SIMULATOR_HOST_SYNC_BATCH_LIMIT,
): Promise<number> {
  const rows = await queryRead<SimulatorRow & { owner_org: string }>(c, `
    SELECT id, owner_org, app_id, platform, status, url, emulator_id, started_at, last_activity_at,
           device_stopped_at, requested_by, max_duration_minutes
    FROM public.simulator_sessions
    WHERE status = 'in-progress'
      AND emulator_id IS NOT NULL
      AND device_stopped_at IS NULL
    ORDER BY updated_at ASC
    LIMIT $1
  `, [limit])
  const deadline = Date.now() + SIMULATOR_HOST_SYNC_BUDGET_MS
  let synced = 0
  for (const row of rows) {
    if (Date.now() >= deadline)
      break
    try {
      await syncSimulatorSessionFromHost(c, row, { orgId: row.owner_org, userId: row.requested_by })
      synced++
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'Simulator host sync failed for one session',
        sessionId: row.id,
        error,
      })
    }
  }
  return synced
}

export type OrgHostSyncFromHostResult = { synced: number, hostUnreachableSessionIds: string[] }

export async function syncInProgressSimulatorSessionsForOrgFromHost(c: Context, orgId: string): Promise<OrgHostSyncFromHostResult> {
  const rows = await queryRead<SimulatorRow & { owner_org: string }>(c, `
    SELECT id, owner_org, app_id, platform, status, url, emulator_id, started_at, last_activity_at,
           device_stopped_at, requested_by, max_duration_minutes
    FROM public.simulator_sessions
    WHERE owner_org = $1::uuid
      AND status = 'in-progress'
      AND emulator_id IS NOT NULL
      AND device_stopped_at IS NULL
  `, [orgId])
  const deadline = Date.now() + SIMULATOR_ORG_HOST_SYNC_BUDGET_MS
  const hostUnreachableSessionIds: string[] = []
  let synced = 0
  const syncOptions: SimulatorHostSyncOptions = { hostTimeoutMs: SIMULATOR_ORG_HOST_SYNC_TIMEOUT_MS }
  for (let offset = 0; offset < rows.length; offset += SIMULATOR_ORG_HOST_SYNC_CONCURRENCY) {
    if (Date.now() >= deadline) {
      for (let pending = offset; pending < rows.length; pending++)
        hostUnreachableSessionIds.push(rows[pending]!.id)
      break
    }
    const chunk = rows.slice(offset, offset + SIMULATOR_ORG_HOST_SYNC_CONCURRENCY)
    const outcomes = await Promise.all(chunk.map(async (row) => {
      try {
        const result = await syncSimulatorSessionFromHost(c, row, { orgId: row.owner_org, userId: row.requested_by }, syncOptions)
        return { row, result, error: null as Error | null }
      }
      catch (error) {
        return { row, result: null as 'synced' | 'finalized' | 'skipped' | null, error: error as Error }
      }
    }))
    for (const outcome of outcomes) {
      if (outcome.error) {
        cloudlogErr({
          requestId: c.get('requestId'),
          message: 'Simulator host sync failed for one session',
          sessionId: outcome.row.id,
          error: outcome.error,
        })
        hostUnreachableSessionIds.push(outcome.row.id)
        continue
      }
      if (outcome.result === 'skipped')
        hostUnreachableSessionIds.push(outcome.row.id)
      else if (outcome.result)
        synced++
    }
  }
  return { synced, hostUnreachableSessionIds }
}

export async function installSavedIpa(c: Context, principal: RlsPrincipal, appId: string, ownerOrg: string, jobId: string, sessionUrl: string, accessKey: string, sessionId: string) {
  const saved = (await savedOutputsForJobs(c, principal, appId, ownerOrg, [jobId]))[jobId]
  if (saved?.kind !== 'ios_ipa')
    throw new Error('This build has no saved iOS app.')
  const file = await fetch(saved.url, { signal: AbortSignal.timeout(SAVED_IPA_TRANSFER_MS) })
  if (!file.ok || !file.body) {
    await file.body?.cancel()
    throw new Error('The saved build could not be downloaded.')
  }
  const length = savedIpaContentLength(file.headers.get('content-length'))
  if (length !== undefined && length > SAVED_IPA_MAX_BYTES) {
    await file.body.cancel()
    throw new Error('The saved build is too large to install.')
  }
  const installUrl = new URL('api/install', sessionUrl.endsWith('/') ? sessionUrl : `${sessionUrl}/`)
  const init: RequestInit & { duplex?: 'half' } = {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${accessKey}`,
      'content-type': 'application/octet-stream',
    },
    body: ipaUploadStream(file.body),
    duplex: 'half',
    signal: AbortSignal.timeout(SAVED_IPA_INSTALL_MS),
  }
  const response = await fetch(installUrl, init)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const reason = (() => {
      try {
        return (JSON.parse(text) as { error?: string }).error
      }
      catch {
        return undefined
      }
    })()
    throw new Error((reason || text).slice(0, 300) || 'The simulator could not install the build.')
  }
  await touchSimulatorActivity(c, sessionId)
}

async function ownedSession(c: Context, principal: RlsPrincipal, userId: string, appId: string, sessionId: string) {
  if (!isSimulatorSessionId(sessionId))
    throw simpleError('not_found', 'Simulator session not found.')
  await ensureBuildPermission(c, appId, userId)
  const orgId = await getBuildOwnerOrg(c, principal, appId)
  const rows = await queryRead<SimulatorRow>(c, `
    SELECT id, app_id, platform, status, url, emulator_id, started_at, last_activity_at, device_stopped_at, requested_by, max_duration_minutes
    FROM public.simulator_sessions
    WHERE id = $1::uuid AND owner_org = $2 AND app_id = $3
  `, [sessionId, orgId, appId])
  const row = rows[0]
  if (!row)
    throw simpleError('not_found', 'Simulator session not found.')
  return { orgId, row }
}

async function savedBuildInstallError(input: {
  c: Context
  principal: RlsPrincipal
  appId: string
  ownerOrg: string
  jobId: string | undefined
  platform: string
  sessionUrl: string
  accessKey: string
  sessionId: string
}) {
  if (!input.jobId || input.platform !== 'ios')
    return null
  try {
    await installSavedIpa(input.c, input.principal, input.appId, input.ownerOrg, input.jobId, input.sessionUrl, input.accessKey, input.sessionId)
    return null
  }
  catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
      return 'The saved build took too long to install.'
    return error instanceof Error ? error.message : 'The saved build could not be installed.'
  }
}

function openedSimulator(device: EmulatorSessionData | undefined) {
  if (!device?.id || !device.url)
    throw new Error('Simulator did not return a session URL.')
  return device
}

async function failSimulatorStartup(c: Context, slotId: string, emulatorId: string, error: unknown, appId: string): Promise<never> {
  const interrupted = emulatorId === '' && simulatorCreateWasInterrupted(error)
  const deviceId = emulatorId || (interrupted ? slotId : '')
  const deviceStopped = deviceId === '' || await createdDeviceStopped(c, deviceId, interrupted)
  await recordStartupFailure(c, slotId, deviceStopped ? '' : deviceId, deviceStopped)
  if (error instanceof Error && error.name === 'HTTPException')
    throw error
  throw quickError(502, 'simulator_unavailable', error instanceof Error ? error.message : 'Simulator did not start.', { app_id: appId }, error, { alert: false })
}

export async function startSimulator(c: Context, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const { appId, platform, name } = simulatorRequestFields(body)
  await ensureBuildPermission(c, appId, userId)
  const orgId = await getBuildOwnerOrg(c, principal, appId)
  await ensureBuildTimePlanAllowed(c, principal, orgId, appId)
  const slot = await reserveSimulatorSlot(c, { orgId, appId, userId, platform, name })
  let emulatorId = ''
  try {
    const { accessKey, origin } = simulatorConfig(c)
    const created = await postEmulator(origin, accessKey, '/v2/device-run-sessions', 'POST', emulatorSessionCreateBody({ id: slot.id, appId, platform, orgId, name }))
    if (created.data?.id)
      emulatorId = created.data.id
    const device = openedSimulator(created.data)
    await markSession(c, slot.id, 'in-progress', { url: device.url, emulatorId: device.id })
    if (platform === 'ios')
      await backgroundTask(c, wakeSimulatorAndRecordActivity(c, slot.id, device.url, accessKey))
    const installError = await savedBuildInstallError({ c, principal, appId, ownerOrg: orgId, jobId: body.build_job_id, platform, sessionUrl: device.url, accessKey, sessionId: slot.id })
    return c.json({
      data: {
        id: slot.id,
        url: device.url,
        status: 'in-progress',
        platform,
        kind: 'simulator',
        remoteConfig: device.remoteConfig ?? null,
        install_error: installError,
      },
    })
  }
  catch (error) {
    return failSimulatorStartup(c, slot.id, emulatorId, error, appId)
  }
}

async function createdDeviceStopped(c: Context, emulatorId: string, interrupted = false) {
  try {
    const { accessKey, origin } = simulatorConfig(c)
    await postEmulator(origin, accessKey, `/v2/device-run-sessions/${emulatorId}/stop`, 'POST', {})
    return true
  }
  catch (stopError) {
    const status = stopError instanceof SimulatorHostError ? stopError.status : 0
    // A lost create can 404 on a host that stored the device under another id.
    const stopped = interrupted ? status === 200 || status === 204 || status === 409 : simulatorHostStopIsFinal(status)
    if (!stopped)
      cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator startup cleanup could not stop the device', emulatorId, error: stopError })
    return stopped
  }
}

async function recordStartupFailure(c: Context, slotId: string, emulatorId: string, deviceStopped: boolean) {
  try {
    if (startupFailureKeepsSlot(emulatorId, deviceStopped))
      await markSession(c, slotId, 'in-progress', { emulatorId })
    else
      await markSession(c, slotId, 'errored')
  }
  catch (markError) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to record simulator startup failure', error: markError })
  }
}

export async function readSimulator(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  let { orgId, row } = await ownedSession(c, principal, userId, appId, sessionId)
  await syncSimulatorSessionFromHost(c, row, { orgId, userId })
  ;({ orgId, row } = await ownedSession(c, principal, userId, appId, sessionId))
  const touch = await touchSimulatorActivity(c, sessionId, { orgId, userId, appId, row }, { bump: false })
  if (touch === 'expired') {
    return c.json({
      data: {
        id: row.id,
        url: row.url,
        status: 'stopped',
        platform: row.platform,
        kind: 'simulator',
      },
    })
  }
  const remoteConfig = await simulatorRemoteConfig(c, row)
  return c.json({
    data: {
      id: row.id,
      url: row.url,
      status: row.status,
      platform: row.platform,
      kind: 'simulator',
      ...(remoteConfig ? { remoteConfig } : {}),
    },
  })
}

async function simulatorRemoteConfig(c: Context, row: SimulatorRow) {
  if (row.status !== 'in-progress' || !row.emulator_id)
    return null
  try {
    const { accessKey, origin } = simulatorConfig(c)
    const found = await postEmulator(origin, accessKey, `/v2/device-run-sessions/${row.emulator_id}`, 'GET')
    return found.data?.remoteConfig ?? null
  }
  catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCodePoint(...bytes.subarray(index, index + 0x8000))
  return btoa(binary)
}

export async function commandSimulator(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const rpc = simulatorCommandRpc({
    command: typeof body.command === 'string' ? body.command : '',
    x: body.x,
    y: body.y,
    bundleId: typeof body.bundle_id === 'string' ? body.bundle_id.trim() : undefined,
  })
  const { orgId, row } = await ownedSession(c, principal, userId, appId, sessionId)
  const sync = await syncSimulatorSessionFromHost(c, row, { orgId, userId }, { hostTimeoutMs: SIMULATOR_ORG_HOST_SYNC_TIMEOUT_MS })
  if (sync === 'finalized')
    throw simpleError('invalid_request', SIMULATOR_STOPPED_MESSAGE)
  const { row: liveRow } = await ownedSession(c, principal, userId, appId, sessionId)
  if (liveRow.status !== 'in-progress' || !liveRow.url)
    throw simpleError('invalid_request', SIMULATOR_STOPPED_MESSAGE)
  await bumpSimulatorSessionActivity(c, sessionId)
  const { accessKey } = simulatorConfig(c)
  const response = await fetch(simulatorDeviceUrl(liveRow.url, 'agent-device/rpc'), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(rpc),
    signal: AbortSignal.timeout(SIMULATOR_HOST_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => undefined) as { result?: { data?: unknown }, error?: { message?: string } } | undefined
  if (!response.ok || !payload || payload.error || !('result' in payload)) {
    throw quickError(502, 'simulator_unavailable', payload?.error?.message || `Simulator request failed (${response.status})`, { app_id: appId }, undefined, { alert: false })
  }
  let image: string | undefined
  if (rpc.params.command === 'screenshot') {
    image = await simulatorScreenshot(liveRow.url, accessKey, appId)
    await bumpSimulatorSessionActivity(c, sessionId)
  }
  return c.json({
    data: {
      id: row.id,
      command: rpc.params.command,
      result: payload?.result?.data ?? null,
      ...(image ? { image_base64: image, image_media_type: 'image/jpeg' } : {}),
    },
  })
}

export async function pingSimulatorActivity(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const { orgId, row } = await ownedSession(c, principal, userId, appId, sessionId)
  const sync = await syncSimulatorSessionFromHost(c, row, { orgId, userId })
  if (sync === 'finalized')
    throw simpleError('invalid_request', SIMULATOR_STOPPED_MESSAGE)
  const fresh = await ownedSession(c, principal, userId, appId, sessionId)
  if (fresh.row.status !== 'in-progress')
    throw simpleError('invalid_request', SIMULATOR_STOPPED_MESSAGE)
  return c.json({ status: 'ok' })
}

async function simulatorScreenshot(sessionUrl: string, accessKey: string, appId: string) {
  const shot = await fetch(simulatorDeviceUrl(sessionUrl, 'agent-device/artifacts/screen.jpg'), {
    headers: { Authorization: `Bearer ${accessKey}` },
    signal: AbortSignal.timeout(SIMULATOR_HOST_TIMEOUT_MS),
  })
  const length = Number(shot.headers.get('content-length'))
  if (!shot.ok || !shot.body) {
    await shot.body?.cancel()
    throw quickError(502, 'simulator_unavailable', 'The simulator did not return a screenshot.', { app_id: appId }, undefined, { alert: false })
  }
  if (Number.isFinite(length) && length > SIMULATOR_SCREENSHOT_MAX_BYTES) {
    await shot.body.cancel()
    throw quickError(502, 'simulator_unavailable', 'The screenshot is too large.', { app_id: appId }, undefined, { alert: false })
  }
  try {
    return bytesToBase64(await readCappedBytes(shot.body, SIMULATOR_SCREENSHOT_MAX_BYTES))
  }
  catch (error) {
    const tooLarge = error instanceof Error && error.message === 'too-large'
    throw quickError(502, 'simulator_unavailable', tooLarge ? 'The screenshot is too large.' : 'The simulator did not return a screenshot.', { app_id: appId }, error, { alert: false })
  }
}

async function stopRemoteDevice(c: Context, emulatorId: string, sessionId: string, rowId: string): Promise<number> {
  const { accessKey, origin } = simulatorConfig(c)
  try {
    const stopped = await postEmulator(origin, accessKey, `/v2/device-run-sessions/${emulatorId}/stop`, 'POST', {})
    return stopped.status
  }
  catch (error) {
    if (error instanceof SimulatorHostError && simulatorHostStopIsFinal(error.status))
      return error.status
    cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator stop failed', sessionId, error })
    throw quickError(502, 'simulator_stop_failed', 'The simulator is still running. Retry stop.', { id: rowId }, error, { alert: false })
  }
}

async function confirmDeviceStopped(c: Context, row: SimulatorRow, sessionId: string) {
  if (row.device_stopped_at)
    return { remoteStatus: 200, stoppedAt: row.device_stopped_at }
  const remoteStatus = row.emulator_id ? await stopRemoteDevice(c, row.emulator_id, sessionId, row.id) : null
  const stoppedAt = await rememberDeviceStop(c, row.id, new Date().toISOString())
  return { remoteStatus, stoppedAt }
}

export async function stopSimulator(c: Context, sessionId: string, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  const { orgId, row } = await ownedSession(c, principal, userId, appId, sessionId)
  if (row.status === 'stopped' || row.status === 'errored') {
    return c.json({ data: { id: row.id, url: row.url, status: row.status, platform: row.platform, kind: 'simulator' } })
  }
  const { remoteStatus, stoppedAt } = await confirmDeviceStopped(c, row, sessionId)
  const usageEnd = simulatorUsageEnd(stoppedAt)
  const maxMinutes = Number(row.max_duration_minutes) || SIMULATOR_MAX_DURATION_MINUTES
  const billedAt = simulatorBillingEndInstant(row.started_at, row.last_activity_at, usageEnd, maxMinutes)
  const seconds = simulatorBillableSeconds(row.started_at, billedAt, maxMinutes)
  const platform = row.platform === 'android' ? 'android' : 'ios'
  let billingRecorded = seconds === 0
  if (seconds > 0) {
    const billingId = await recordBuildTime(c, orgId, row.requested_by || userId, row.id, platform, seconds, billedAt, appId)
    billingRecorded = billingId !== null
  }
  if (!canFinishSimulatorStop({ remoteStatus, billingRecorded, seconds }))
    throw quickError(503, 'simulator_billing_failed', 'Build minutes were not recorded. Retry stop.', { id: row.id }, undefined, { alert: false })
  await markSession(c, row.id, 'stopped', { finishedAt: stoppedAt ?? new Date(billedAt).toISOString() })
  return c.json({ data: { id: row.id, url: row.url, status: 'stopped', platform, kind: 'simulator', build_time_seconds: seconds } })
}

interface SimulatorListRow {
  id: string
  platform: 'ios' | 'android'
  status: string
  url: string | null
  started_at: string | null
  finished_at: string | null
  build_time_unit: number | string | null
  billable_seconds: number | string | null
}

export function simulatorListItem(row: SimulatorListRow) {
  const running = row.status === 'in-progress'
  const seconds = (value: number | string | null) => value == null ? null : Number(value)
  return {
    id: row.id,
    platform: row.platform,
    status: row.status,
    url: running ? row.url : null,
    started_at: row.started_at,
    finished_at: running ? null : row.finished_at,
    build_time_seconds: seconds(row.build_time_unit),
    billable_seconds: seconds(row.billable_seconds),
  }
}

export async function listSimulators(c: Context, body: SimulatorBody, userId: string, principal: RlsPrincipal) {
  const appId = requireAppId(body.app_id)
  await ensureBuildPermission(c, appId, userId)
  const orgId = await getBuildOwnerOrg(c, principal, appId)
  try {
    await expireSimulatorSessions(c, orgId)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Simulator settlement failed before listing', appId, error })
  }
  const rows = await queryRead<SimulatorListRow>(c, `
    SELECT s.id, s.platform, s.status, s.url, s.started_at, s.finished_at,
           l.build_time_unit, l.billable_seconds
    FROM public.simulator_sessions s
    LEFT JOIN public.build_logs l ON l.build_id = s.id::varchar AND l.org_id = s.owner_org
    WHERE s.owner_org = $1 AND s.app_id = $2
    ORDER BY s.created_at DESC
    LIMIT 10
  `, [orgId, appId])
  return c.json({
    data: rows.map(simulatorListItem),
    idle_minutes: SIMULATOR_IDLE_TIMEOUT_MINUTES,
    max_minutes: SIMULATOR_MAX_DURATION_MINUTES,
  })
}
