import type { Context } from 'hono'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { drizzleErrorFingerprintSegment, readPgErrorCode } from './pg_errors.ts'
import { existInEnv, getEnv, trimTrailingSlashes } from './utils.ts'

const POSTHOG_CAPTURE_URL = 'https://eu.i.posthog.com/capture/'
const POSTHOG_EXCEPTION_URL = 'https://eu.i.posthog.com/i/v0/e/'
const POSTHOG_SNAPSHOT_URL = 'https://eu.i.posthog.com/s/'
const POSTHOG_DELIVERY_TIMEOUT_MS = 5000
const POSTHOG_IDENTIFY_TIMEOUT_MS = 250
const RRWEB_META_EVENT_TYPE = 4

export type PostHogGroups = Record<string, string>

interface PostHogCapturePayload {
  channel: string
  description?: string
  distinct_id?: string
  event: string
  event_id?: string
  groups?: PostHogGroups
  ip?: string
  personProperties?: Record<string, unknown>
  setPersonProperties?: boolean
  tags?: Record<string, unknown>
  nonPersonTags?: Record<string, unknown>
  timestamp?: string
  timeoutMs?: number
  user_id?: string
}

function captureProperties(payload: PostHogCapturePayload) {
  const hasGroups = payload.groups && Object.keys(payload.groups).length > 0
  return {
    ...(payload.nonPersonTags || {}),
    ...(payload.tags || {}),
    channel: payload.channel,
    description: payload.description,
    ...(payload.setPersonProperties === false ? {} : { $set: { ...payload.tags, ...payload.personProperties } }),
    ...(hasGroups ? { $groups: payload.groups } : {}),
    // Reserved identity must override caller tags and never become a person trait.
    ...(payload.event_id ? { $insert_id: payload.event_id } : {}),
  }
}

interface PostHogDeliveryDetails {
  duration_ms: number
  http_status: number | null
  // Preserve the existing boolean/strict contract while exposing richer outcomes.
  legacy_success: boolean
}

type PostHogDeliveryOutcome
  = | { outcome: 'delivered' }
    | { outcome: 'quota_limited' }
    | { outcome: 'retryable' }
    | { outcome: 'permanent_failure', reason: 'not_configured' | 'invalid_payload_or_host' | 'http_error' | 'rejected' }
    | { outcome: 'ambiguous', reason: 'timeout' | 'network' | 'invalid_response' }

export type PostHogDeliveryResult = PostHogDeliveryDetails & PostHogDeliveryOutcome

const POSTHOG_RESPONSE_MAX_BYTES = 16 * 1024
const POSTHOG_RESPONSE_TIMEOUT_MS = 1000

async function readCaptureResponse(res: Response, signal: AbortSignal) {
  const reader = res.body?.getReader()
  if (!reader)
    return ''
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done)
        break
      size += value.byteLength
      if (size > POSTHOG_RESPONSE_MAX_BYTES)
        throw new Error('PostHog response too large')
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  }
  finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
  }
}

export async function deliverPosthogEvent(c: Context, payload: PostHogCapturePayload): Promise<PostHogDeliveryResult> {
  const startedAt = Date.now()
  const finish = (result: Omit<PostHogDeliveryDetails, 'duration_ms'> & PostHogDeliveryOutcome): PostHogDeliveryResult => {
    const delivery = { ...result, duration_ms: Date.now() - startedAt } as PostHogDeliveryResult
    const log = delivery.outcome === 'delivered' ? cloudlog : cloudlogErr
    // Never include actor IDs, arbitrary event names, tags, provider bodies, or errors.
    log({
      requestId: c.get('requestId'),
      message: 'tracking_provider_delivery',
      provider: 'posthog',
      event_id: payload.event_id,
      outcome: delivery.outcome,
      duration_ms: delivery.duration_ms,
      http_status: delivery.http_status,
      ...('reason' in delivery ? { reason: delivery.reason } : {}),
    })
    return delivery
  }
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY'))
    return finish({ outcome: 'permanent_failure', reason: 'not_configured', http_status: null, legacy_success: false })

  let posthogUrl: string
  let body: string
  try {
    posthogUrl = getPostHogCaptureUrl(getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_CAPTURE_URL)
    body = JSON.stringify({
      api_key: apiKey,
      event: payload.event,
      distinct_id: payload.user_id || payload.distinct_id || 'anonymous',
      properties: captureProperties(payload),
      ...(payload.event_id ? { uuid: payload.event_id } : {}),
      ip: payload.ip,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    })
  }
  catch {
    return finish({ outcome: 'permanent_failure', reason: 'invalid_payload_or_host', http_status: null, legacy_success: false })
  }

  const controller = new AbortController()
  let timeoutId = payload.timeoutMs ? setTimeout(() => controller.abort(), payload.timeoutMs) : undefined
  let httpStatus: number | null = null
  let legacySuccess = false
  try {
    const res = await fetch(posthogUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    })
    httpStatus = res.status
    legacySuccess = res.ok
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      return finish(res.status === 429 || res.status >= 500
        ? { outcome: 'retryable', http_status: res.status, legacy_success: false }
        : { outcome: 'permanent_failure', reason: 'http_error', http_status: res.status, legacy_success: false })
    }

    // Only bound the newly added body inspection; retain callers' fetch deadlines.
    if (timeoutId)
      clearTimeout(timeoutId)
    timeoutId = setTimeout(() => controller.abort(), POSTHOG_RESPONSE_TIMEOUT_MS)
    const text = await readCaptureResponse(res, controller.signal)
    // Legacy capture endpoints may return an empty body or the literal 1.
    const response = text.trim() ? JSON.parse(text) : null
    if (response && typeof response === 'object') {
      const limited = response.quota_limited
      if (limited === true || (Array.isArray(limited) && limited.length > 0))
        return finish({ outcome: 'quota_limited', http_status: res.status, legacy_success: true })
      if (response.status === 0 || response.status === 'error')
        return finish({ outcome: 'permanent_failure', reason: 'rejected', http_status: res.status, legacy_success: true })
    }
    return finish({ outcome: 'delivered', http_status: res.status, legacy_success: true })
  }
  catch {
    return finish({
      outcome: 'ambiguous',
      reason: controller.signal.aborted ? 'timeout' : legacySuccess ? 'invalid_response' : 'network',
      http_status: httpStatus,
      legacy_success: legacySuccess,
    })
  }
  finally {
    if (timeoutId)
      clearTimeout(timeoutId)
  }
}

export async function trackPosthogEvent(c: Context, payload: PostHogCapturePayload) {
  return (await deliverPosthogEvent(c, payload)).legacy_success
}

// Queue batches can complete many steps at once. Send their events in one
// request so telemetry cannot consume the queue handler's request budget.
export async function trackPosthogEventBatch(c: Context, payloads: PostHogCapturePayload[]) {
  if (!payloads.length)
    return true
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }
  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_CAPTURE_URL
  const normalizedHost = stripPostHogEndpoint(trimTrailingSlashes(host))
  const url = new URL('batch/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        batch: payloads.map(payload => ({
          event: payload.event,
          distinct_id: payload.user_id || payload.distinct_id || 'anonymous',
          properties: {
            ...captureProperties(payload),
            distinct_id: payload.user_id || payload.distinct_id || 'anonymous',
          },
          timestamp: payload.timestamp ?? new Date().toISOString(),
        })),
        sent_at: new Date().toISOString(),
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog batch error', status: res.status, error: (await res.text()).slice(0, 500), count: payloads.length })
      return false
    }
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog batch sent', count: payloads.length })
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog batch fetch failed', error: serializeError(error), count: payloads.length })
    return false
  }
  finally {
    clearTimeout(timeoutId)
  }
}

function stripPostHogEndpoint(host: string) {
  for (const suffix of ['/i/v0/e', '/capture', '/s', '/e']) {
    if (host.endsWith(suffix))
      return `${host.slice(0, -suffix.length)}/`
  }
  return host
}

function getPostHogCaptureUrl(host: string) {
  const normalizedHost = stripPostHogEndpoint(trimTrailingSlashes(host))
  return new URL('capture/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}

function getPostHogSnapshotUrl(host: string) {
  const trimmedHost = trimTrailingSlashes(host)
  if (trimmedHost.endsWith('/s'))
    return `${trimmedHost}/`

  const normalizedHost = stripPostHogEndpoint(trimmedHost)
  return new URL('s/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}
function jsonByteLength(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

export interface PostHogReplaySnapshotPayload {
  currentUrl: string
  distinctId: string
  events: unknown[]
  lib: string
  libVersion: string
  sessionId: string
  snapshotBytes?: number
  timestamp: string
  userEmail?: string
  userId: string
  windowId: string
}

export async function capturePosthogReplaySnapshot(c: Context, payload: PostHogReplaySnapshotPayload) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_SNAPSHOT_URL
  let posthogUrl: string
  try {
    posthogUrl = getPostHogSnapshotUrl(host)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid PostHog replay host', error: serializeError(e), host })
    return false
  }

  const isInitialSnapshot = payload.events.some(event => typeof event === 'object' && event !== null && 'type' in event && event.type === RRWEB_META_EVENT_TYPE)
  if (isInitialSnapshot && payload.userEmail) {
    await trackPosthogEvent(c, {
      channel: 'cli',
      event: '$identify',
      // Resizes emit another rrweb Meta event. Keep retries backend-only while
      // letting PostHog deduplicate them into one identify event per session.
      nonPersonTags: { $insert_id: `cli-replay-identify:${payload.sessionId}` },
      personProperties: { email: payload.userEmail },
      timeoutMs: POSTHOG_IDENTIFY_TIMEOUT_MS,
      user_id: payload.userId,
    }).catch(error => cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog identification failed', error: serializeError(error), userId: payload.userId }))
  }

  const body = {
    api_key: apiKey,
    distinct_id: payload.distinctId,
    event: '$snapshot',
    properties: {
      $current_url: payload.currentUrl,
      $lib: payload.lib,
      $lib_version: payload.libVersion,
      $session_id: payload.sessionId,
      ...(payload.userEmail ? { $set: { email: payload.userEmail } } : {}),
      $snapshot_bytes: payload.snapshotBytes ?? jsonByteLength(payload.events),
      $snapshot_data: payload.events,
      $snapshot_source: 'web',
      $window_id: payload.windowId,
      distinct_id: payload.distinctId,
      token: apiKey,
      user_id: payload.userId,
    },
    timestamp: payload.timestamp,
  }
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POSTHOG_DELIVERY_TIMEOUT_MS)
    try {
      const res = await fetch(posthogUrl, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        signal: controller.signal,
      })

      if (!res.ok) {
        const error = await res.text()
        cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog replay error', status: res.status, error, sessionId: payload.sessionId, distinctId: payload.distinctId })
        return false
      }

      cloudlog({ requestId: c.get('requestId'), message: 'PostHog replay sent', sessionId: payload.sessionId, distinctId: payload.distinctId })
      return true
    }
    finally {
      clearTimeout(timeoutId)
    }
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog replay fetch failed', error: serializeError(e), sessionId: payload.sessionId, distinctId: payload.distinctId })
    return false
  }
}

function getPostHogExceptionUrl(host: string) {
  const trimmedHost = trimTrailingSlashes(host)
  if (trimmedHost.endsWith('/i/v0/e'))
    return `${trimmedHost}/`

  const normalizedHost = trimmedHost.endsWith('/capture') ? `${trimmedHost.slice(0, -'/capture'.length)}/` : trimmedHost
  return new URL('i/v0/e/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`).toString()
}
// Cloudflare's "internal error; reference = <id>" carries a random reference id
// that would otherwise land in the error-tracking issue title and make every
// occurrence look like a new issue. Drop the id so the class groups under one
// stable title.
function stripCloudflareInternalErrorReference(message: string | undefined): string | undefined {
  if (typeof message !== 'string')
    return message
  return message.replace(/(internal error; reference)\s*=\s*\S+/gi, '$1')
}

function getRequestPath(url: string) {
  try {
    return new URL(url).pathname || '/'
  }
  catch {
    return '/'
  }
}

function parseExceptionFrames(stack: string | undefined, fallbackFunctionName: string) {
  const frames = stack?.split('\n')
    .slice(1)
    .map((line) => {
      const trimmed = line.trim()
      const withoutAt = trimmed.startsWith('at ') ? trimmed.slice(3) : trimmed
      let functionName = fallbackFunctionName
      let location = withoutAt

      const groupedLocationIndex = withoutAt.lastIndexOf(' (')
      if (groupedLocationIndex !== -1 && withoutAt.endsWith(')')) {
        functionName = withoutAt.slice(0, groupedLocationIndex).trim() || fallbackFunctionName
        location = withoutAt.slice(groupedLocationIndex + 2, -1)
      }

      const lastColonIndex = location.lastIndexOf(':')
      const secondLastColonIndex = lastColonIndex === -1 ? -1 : location.lastIndexOf(':', lastColonIndex - 1)
      if (lastColonIndex === -1 || secondLastColonIndex === -1) {
        return {
          function: fallbackFunctionName,
          platform: 'custom',
          lang: 'javascript',
        }
      }

      return {
        function: functionName,
        filename: location.slice(0, secondLastColonIndex),
        lineno: Number.parseInt(location.slice(secondLastColonIndex + 1, lastColonIndex), 10),
        colno: Number.parseInt(location.slice(lastColonIndex + 1), 10),
        platform: 'custom',
        lang: 'javascript',
      }
    })
    .filter(Boolean)

  return frames && frames.length > 0
    ? frames
    : [{
        function: fallbackFunctionName,
        platform: 'custom',
        lang: 'javascript',
      }]
}

export async function capturePosthogException(c: Context, payload: {
  error: unknown
  functionName: string
  kind: 'drizzle_error' | 'http_exception' | 'unhandled_error'
  status?: number
}) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_EXCEPTION_URL
  let posthogUrl: string
  try {
    posthogUrl = getPostHogExceptionUrl(host)
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Invalid PostHog host', error: serializeError(e), host })
    return false
  }
  const serializedError = serializeError(payload.error)
  const distinctId = `backend:${getEnv(c, 'ENV_NAME') || 'unknown'}:${payload.functionName}`
  const frames = parseExceptionFrames(serializedError.stack, payload.functionName)
  const topFrame = frames[0]
  const requestPath = getRequestPath(c.req.url)
  const drizzleSegment = payload.kind === 'drizzle_error'
    ? drizzleErrorFingerprintSegment(payload.error)
    : undefined
  const fingerprint = [
    distinctId,
    payload.kind,
    serializedError.name || 'Error',
    drizzleSegment || topFrame?.function || payload.functionName,
    topFrame?.filename || 'unknown',
    String(payload.status ?? 500),
  ].join(':')
  const pgErrorCode = payload.kind === 'drizzle_error'
    ? readPgErrorCode(payload.error)
    : undefined

  const body = {
    token: apiKey,
    event: '$exception',
    properties: {
      distinct_id: distinctId,
      $exception_list: [{
        type: serializedError.name || 'Error',
        value: stripCloudflareInternalErrorReference(serializedError.message),
        mechanism: {
          handled: true,
          synthetic: false,
        },
        stacktrace: {
          type: 'raw',
          frames,
        },
      }],
      $exception_fingerprint: fingerprint,
      error_kind: payload.kind,
      function_name: payload.functionName,
      method: c.req.method,
      request_id: c.get('requestId'),
      status: payload.status,
      url_path: requestPath,
      ...(pgErrorCode ? { pg_error_code: pgErrorCode } : {}),
    },
    timestamp: new Date().toISOString(),
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), POSTHOG_DELIVERY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(posthogUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timeoutId)
    }
    catch (fetchError) {
      clearTimeout(timeoutId)
      throw fetchError
    }
    if (!res.ok) {
      const error = await res.text()
      cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog exception error', status: res.status, error, event: '$exception', distinctId })
      return false
    }

    cloudlog({ requestId: c.get('requestId'), message: 'PostHog exception sent', event: '$exception', distinctId })
    return true
  }
  catch (e) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'PostHog exception fetch failed', error: serializeError(e), event: '$exception', distinctId })
    return false
  }
}

export interface PostHogGroupIdentifyPayload {
  groupType: string
  groupKey: string
  properties?: Record<string, unknown>
}

export async function groupIdentifyPosthog(c: Context, payload: PostHogGroupIdentifyPayload) {
  const apiKey = getEnv(c, 'POSTHOG_API_KEY')
  if (!apiKey || !existInEnv(c, 'POSTHOG_API_KEY')) {
    cloudlog({ requestId: c.get('requestId'), message: 'PostHog not configured' })
    return false
  }

  const host = getEnv(c, 'POSTHOG_API_HOST') || POSTHOG_CAPTURE_URL
  const body = {
    api_key: apiKey,
    event: '$groupidentify',
    distinct_id: `$${payload.groupType}_${payload.groupKey}`,
    properties: {
      $group_type: payload.groupType,
      $group_key: payload.groupKey,
      $group_set: payload.properties ?? {},
    },
    timestamp: new Date().toISOString(),
  }

  try {
    const posthogUrl = getPostHogCaptureUrl(host)
    const res = await fetch(posthogUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const error = await res.text()
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'PostHog $groupidentify error',
        status: res.status,
        error,
        groupType: payload.groupType,
        groupKey: payload.groupKey,
      })
      return false
    }

    cloudlog({
      requestId: c.get('requestId'),
      message: 'PostHog $groupidentify sent',
      groupType: payload.groupType,
      groupKey: payload.groupKey,
    })
    return true
  }
  catch (e) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'PostHog $groupidentify fetch failed',
      error: serializeError(e),
      groupType: payload.groupType,
      groupKey: payload.groupKey,
    })
    return false
  }
}
