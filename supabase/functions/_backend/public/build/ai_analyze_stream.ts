// supabase/functions/_backend/public/build/ai_analyze_stream.ts
import type { Context } from 'hono'
import type { Database } from '../../utils/supabase.types.ts'
import { quickError, simpleError } from '../../utils/hono.ts'
import { cloudlogErr, serializeError } from '../../utils/logging.ts'
import { checkPermission } from '../../utils/rbac.ts'
import { supabaseAdmin, supabaseApikey } from '../../utils/supabase.ts'
import { sendEventToTracking } from '../../utils/tracking.ts'
import { getEnv } from '../../utils/utils.ts'
import { emitAiAnalysisResult } from './ai_analyze_telemetry.ts'

// Liveness watchdogs replace the old fixed 60s wall-clock timeout. The CLI's
// values (120s/45s) are deliberately larger so this inner layer fires first.
export const FIRST_BYTE_TIMEOUT_MS = 90_000
export const IDLE_TIMEOUT_MS = 30_000

// 10 MB logs cap (spec §3.1) — mirrors the CLI's HARD_LOG_SIZE_LIMIT pre-flight
// and the builder's own limit, so the documented 413 is emitted at this layer.
export const MAX_LOGS_BYTES = 10 * 1024 * 1024

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

export async function aiAnalyzeStreamBuild(
  c: Context,
  jobId: string,
  appId: string,
  apikey: Database['public']['Tables']['apikeys']['Row'],
  logs: string,
): Promise<Response> {
  // Byte-accurate size: logs.length counts UTF-16 code units, which undercounts
  // multi-byte UTF-8 — a payload could pass a .length check while exceeding the
  // 10 MB wire limit. Encode once and use real bytes for both the guard and telemetry.
  const logsBytes = logs ? new TextEncoder().encode(logs).length : 0

  // 0. Size guard — spec §3.1: a body over the 10 MB limit is a 413 logs_too_big.
  // Checked BEFORE any DB work so the slot is never claimed for an oversized payload.
  if (logsBytes > MAX_LOGS_BYTES) {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'logs_too_big', userId: apikey.user_id, logsBytes })
    throw quickError(413, 'logs_too_big', 'Build logs exceed the 10 MB limit')
  }

  // 1. Permission check
  if (!(await checkPermission(c, 'app.build_native', { appId }))) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Unauthorized AI analyze (stream)', job_id: jobId, app_id: appId, user_id: apikey.user_id })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'unauthorized', userId: apikey.user_id, logsBytes })
    throw simpleError('unauthorized', 'You do not have permission to analyze this build')
  }

  // 2. Ownership + state check (user context). Idempotency is NOT checked here —
  // the atomic claim below is the only gate, so there is no SELECT-then-flip race.
  const supabase = supabaseApikey(c, apikey.key)
  const { data: row, error: selectErr } = await supabase
    .from('build_requests')
    .select('app_id, status, owner_org')
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .maybeSingle()

  if (selectErr) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to fetch build_request for AI analyze (stream)', job_id: jobId, error: selectErr.message })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', userId: apikey.user_id, logsBytes })
    throw simpleError('internal_error', 'Failed to fetch build request')
  }
  if (!row) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Unauthorized AI analyze (job/app mismatch or missing)', job_id: jobId, app_id: appId, user_id: apikey.user_id })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'unauthorized', userId: apikey.user_id, logsBytes })
    throw simpleError('unauthorized', 'You do not have permission to analyze this build')
  }
  const ownerOrg = row.owner_org
  if (row.status !== 'failed') {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'invalid_state', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('invalid_state', 'AI analysis only available for failed builds')
  }

  // 3. Config check BEFORE claiming — a missing env var must not consume the slot.
  const builderUrl = getEnv(c, 'BUILDER_URL')
  const builderApiKey = getEnv(c, 'BUILDER_API_KEY')
  if (!builderUrl || !builderApiKey) {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'config_error', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('config_error', 'Builder service not configured')
  }

  // 4. CLAIM — atomic conditional flip, service-role client (RLS grants UPDATE to
  // service role only; user-context UPDATE would silently match 0 rows). Claiming
  // BEFORE the builder call is the abuse barrier: Workers AI bills input tokens at
  // prompt submission, so the flag must flip when cost commits, not on delivery.
  const admin = supabaseAdmin(c)
  const { data: claimed, error: claimErr } = await admin
    .from('build_requests')
    .update({ ai_analyzed: true })
    .eq('builder_job_id', jobId)
    .eq('app_id', appId)
    .eq('ai_analyzed', false)
    .select('builder_job_id')

  if (claimErr) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze claim failed', job_id: jobId, error: claimErr.message })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes })
    throw simpleError('internal_error', 'Failed to claim analysis slot')
  }
  if (!claimed || claimed.length === 0) {
    await emitAiAnalysisResult(c, { appId, jobId, result: 'already_analyzed', ownerOrg, userId: apikey.user_id, logsBytes })
    // 409 — the CLI branches on res.status === 409 for this case
    throw quickError(409, 'already_analyzed', 'AI analysis already requested for this job')
  }

  // Refund — ONLY for provably-pre-AI failures. Never on disconnects/timeouts.
  const refund = async (reason: string): Promise<void> => {
    const { error: refundErr } = await admin
      .from('build_requests')
      .update({ ai_analyzed: false })
      .eq('builder_job_id', jobId)
      .eq('app_id', appId)
      .select('builder_job_id')
    if (refundErr) {
      // Fail closed: slot stays consumed. Log loudly — this should be rare.
      cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze refund failed — slot stays consumed', job_id: jobId, reason, error: refundErr.message })
    }
  }

  // Requested telemetry — after the claim so it means "a billable attempt starts".
  try {
    await sendEventToTracking(c, {
      event: 'AI Build Analysis Requested',
      channel: 'build-lifecycle',
      user_id: apikey.user_id,
      groups: { organization: ownerOrg },
      tags: { app_id: appId, org_id: ownerOrg, job_id: jobId, logs_bytes: String(logsBytes) },
    })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'AI Build Analysis Requested telemetry failed', error: serializeError(error) })
  }

  // 5. Call the builder (streaming). One AbortController serves both watchdog
  // phases: armed for first-byte now, re-armed per chunk in the pump below.
  const startedAt = Date.now()
  const controller = new AbortController()
  let watchdog: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), FIRST_BYTE_TIMEOUT_MS)

  let builderResp: Response
  try {
    builderResp = await fetch(`${builderUrl}/jobs/${jobId}/ai-analyze`, {
      method: 'POST',
      headers: { 'x-api-key': builderApiKey, 'content-type': 'application/json', 'accept': 'text/event-stream' },
      body: JSON.stringify({ logs }),
      signal: controller.signal,
    })
  }
  catch (err) {
    clearTimeout(watchdog)
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    if (!aborted) {
      // Request never reached the builder — provably zero AI cost. Refund.
      await refund('connection_failure')
      await emitAiAnalysisResult(c, { appId, jobId, result: 'refunded', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
      throw simpleError('builder_error', 'AI analysis request failed — please retry')
    }
    // Watchdog fired pre-headers: ambiguous (AI may be ingesting). Fail closed.
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis timed out')
  }

  if (!builderResp.ok) {
    clearTimeout(watchdog)
    const errBody = await builderResp.json().catch(() => null) as { error?: string, aiStarted?: boolean } | null
    if (errBody?.aiStarted === false) {
      // Builder rejected before invoking env.AI.run — provably zero AI cost. Refund.
      await refund(`builder_${errBody.error ?? 'error'}`)
      await emitAiAnalysisResult(c, { appId, jobId, result: 'refunded', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
      throw simpleError('builder_error', 'AI analysis failed before starting — please retry')
    }
    // aiStarted true / missing / malformed — billing unknown. Fail closed.
    cloudlogErr({ requestId: c.get('requestId'), message: 'Builder AI analyze failed (stream)', job_id: jobId, status: builderResp.status, error: errBody?.error ?? '<unparsable>' })
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis failed')
  }

  if (!builderResp.body) {
    clearTimeout(watchdog)
    await emitAiAnalysisResult(c, { appId, jobId, result: 'builder_error', ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    throw simpleError('builder_error', 'AI analysis returned no stream')
  }

  // 6. Pump the builder stream to the client, resetting the idle watchdog per
  // chunk. Upstream failure (watchdog abort or builder stream error) becomes an
  // in-band `event: error` — the HTTP status is already committed. The pump runs
  // under waitUntil so the telemetry write survives client disconnects.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const pump = (async () => {
    const reader = builderResp.body!.getReader()
    let result: 'success' | 'mid_stream_error' = 'success'
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done)
          break
        clearTimeout(watchdog)
        watchdog = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS)
        await writer.write(value)
      }
    }
    catch (err) {
      // No refund here ever: the AI run was in progress. Slot stays consumed.
      result = 'mid_stream_error'
      const code = controller.signal.aborted ? 'idle_timeout' : 'ai_error'
      cloudlogErr({ requestId: c.get('requestId'), message: 'AI analyze stream interrupted', job_id: jobId, code, error: serializeError(err) })
      await writer.write(encoder.encode(`event: error\ndata: {"code":"${code}"}\n\n`)).catch(() => {})
    }
    finally {
      clearTimeout(watchdog)
      await writer.close().catch(() => {})
      await emitAiAnalysisResult(c, { appId, jobId, result, ownerOrg, userId: apikey.user_id, logsBytes, durationMs: Date.now() - startedAt })
    }
  })()

  try {
    c.executionCtx.waitUntil(pump)
  }
  catch {
    // executionCtx unavailable (tests) — pump still runs as a floating promise.
  }

  return new Response(readable, { headers: SSE_HEADERS })
}
