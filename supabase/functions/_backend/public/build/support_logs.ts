import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import type { Database } from '../../utils/supabase.types.ts'
import { sql } from 'drizzle-orm'
import { CacheHelper } from '../../utils/cache.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlogErr } from '../../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../../utils/pg.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin } from '../../utils/supabase.ts'
import { getEnv } from '../../utils/utils.ts'

// Proxy for the CLI's "Email Capgo support" logs upload — forwards gzipped text
// logs to the capgo_builder worker, which stores them content-addressed in R2
// (sha256 key, 30-day lifecycle). Spec:
// docs/superpowers/specs/2026-06-05-builder-support-logs-upload-design.md

// 10 MB gzipped cap (the builder worker enforces it too); base64 inflates ~4/3.
const MAX_GZ_B64_LENGTH = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 4

// Account-keyed rate limit: 1/min + 10/day. Backed by the Cloudflare Cache API
// (per-colo, fails open) — a speed bump, not a guarantee. The load-bearing
// defenses are the size cap, the builder's text-only check, the bucket's
// 30-day lifecycle, and account bans (spec §5).
const MINUTE_PATH = '/rate-limit/support-logs-minute'
const MINUTE_LIMIT = 1
const MINUTE_TTL_SECONDS = 60
const DAY_PATH = '/rate-limit/support-logs-day'
const DAY_LIMIT = 10
const DAY_TTL_SECONDS = 24 * 60 * 60

interface RateWindow {
  count: number
  resetAt: number
}

export type SupportLogPlatform = 'ios' | 'android'

export interface SupportLogsBody {
  appId?: string
  jobId?: string
  platform?: SupportLogPlatform
  gzB64: string
}

function parseSupportLogPlatform(platform: unknown): SupportLogPlatform | undefined {
  if (typeof platform !== 'string')
    return undefined
  const normalized = platform.trim().toLowerCase()
  if (normalized === 'ios' || normalized === 'android')
    return normalized
  return undefined
}

// Returns false when the window is exhausted. Fails open on cache errors,
// matching the behavior of the rest of utils/rate_limit.ts.
async function bumpWindow(c: Context, path: string, userId: string, limit: number, ttlSeconds: number): Promise<boolean> {
  try {
    const helper = new CacheHelper(c)
    const key = helper.buildRequest(path, { user_id: userId })
    const existing = await helper.matchJson<RateWindow>(key)
    const count = (existing?.count ?? 0) + 1
    if (count > limit)
      return false
    const resetAt = existing?.resetAt ?? (Date.now() + ttlSeconds * 1000)
    const remainingSeconds = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
    await helper.putJson(key, { count, resetAt }, remainingSeconds)
    return true
  }
  catch {
    return true
  }
}

async function appExists(c: Context, appId: string): Promise<boolean> {
  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(
      sql`SELECT EXISTS (
        SELECT 1
        FROM public.apps
        WHERE app_id = ${appId}
      ) AS exists`,
    )
    return (result.rows[0] as any)?.exists === true
  }
  catch (err) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'support-logs app existence check failed',
      error: err instanceof Error ? err.message : String(err),
    })
    return true
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

async function hasCurrentWriteCapableOrgBinding(c: Context, apikey: Database['public']['Tables']['apikeys']['Row']): Promise<boolean> {
  if (!apikey.rbac_id)
    return false

  let pgClient
  try {
    pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient)
    const result = await drizzleClient.execute(
      sql`SELECT public.apikey_has_current_org_create_capability(${apikey.rbac_id}::uuid) AS allowed`,
    )
    return (result.rows[0] as any)?.allowed === true
  }
  catch (err) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'support-logs org write capability check failed',
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
  finally {
    if (pgClient)
      closeClient(c, pgClient)
  }
}

export async function hasSupportLogUploadPermission(
  c: Context,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  appId?: string,
): Promise<boolean> {
  const targetAppId = appId?.trim()
  if (targetAppId) {
    if (await checkPermission(c as Context<MiddlewareKeyVariables>, 'app.build_native', { appId: targetAppId }))
      return true
    if (await appExists(c, targetAppId))
      return false
  }

  return hasCurrentWriteCapableOrgBinding(c, apikey)
}

async function getSupportUploadEmail(c: Context, userId: string): Promise<string | undefined> {
  const { data, error } = await supabaseAdmin(c)
    .from('users')
    .select('email')
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'support-logs user email lookup failed', userId, error })
    return undefined
  }

  return data?.email?.trim() || undefined
}

async function getSupportUploadPlatform(c: Context, body: SupportLogsBody, userId: string): Promise<SupportLogPlatform | undefined> {
  const requestPlatform = parseSupportLogPlatform(body.platform)
  if (requestPlatform)
    return requestPlatform
  if (!body.jobId)
    return undefined

  const buildRequestQuery = supabaseAdmin(c)
    .from('build_requests')
    .select('platform')
    .eq('builder_job_id', body.jobId)
    .eq('requested_by', userId)

  if (body.appId)
    buildRequestQuery.eq('app_id', body.appId)

  const { data, error } = await buildRequestQuery.maybeSingle()

  if (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'support-logs platform lookup failed',
      jobId: body.jobId,
      appId: body.appId,
      userId,
      error,
    })
    return undefined
  }

  return parseSupportLogPlatform(data?.platform)
}

export async function uploadSupportLogs(
  c: Context,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  body: SupportLogsBody,
): Promise<Response> {
  if (!await hasSupportLogUploadPermission(c, apikey, body.appId))
    throw simpleError('unauthorized', 'You do not have permission to upload support logs')
  if (body.gzB64.length > MAX_GZ_B64_LENGTH)
    throw quickError(413, 'too_big', 'Logs exceed the 10 MB gzipped limit')

  const userId = apikey.user_id
  const minuteOk = await bumpWindow(c, MINUTE_PATH, userId, MINUTE_LIMIT, MINUTE_TTL_SECONDS)
  const dayOk = minuteOk && await bumpWindow(c, DAY_PATH, userId, DAY_LIMIT, DAY_TTL_SECONDS)
  if (!minuteOk || !dayOk)
    throw quickError(429, 'rate_limited', 'Too many support log uploads — try again later')

  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey)
    throw simpleError('config_error', 'Builder service not configured')

  const [email, platform] = await Promise.all([
    getSupportUploadEmail(c, userId),
    getSupportUploadPlatform(c, body, userId),
  ])

  let builderResp: Response
  try {
    builderResp = await fetch(`${builderUrl}/support-logs`, {
      method: 'POST',
      headers: {
        'x-api-key': builderApiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ gzB64: body.gzB64, appId: body.appId, jobId: body.jobId, userId, email, platform }),
      signal: AbortSignal.timeout(60_000),
    })
  }
  catch (err) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'support-logs upload to builder failed',
      error: err instanceof Error ? err.message : String(err),
    })
    throw simpleError('builder_error', 'Support logs upload failed')
  }

  if (builderResp.status === 413)
    throw quickError(413, 'too_big', 'Logs exceed the 10 MB gzipped limit')
  if (builderResp.status === 415)
    throw quickError(415, 'not_text', 'Only gzipped text logs are accepted')
  if (!builderResp.ok) {
    const errText = await builderResp.text().catch(() => '<no body>')
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'support-logs builder error',
      status: builderResp.status,
      error: errText,
    })
    throw simpleError('builder_error', 'Support logs upload failed')
  }

  const result = await builderResp.json() as { id?: string, url?: string }
  if (typeof result.id !== 'string' || typeof result.url !== 'string')
    throw simpleError('builder_error', 'Malformed builder response')
  return c.json({ id: result.id, url: result.url }, 200)
}
