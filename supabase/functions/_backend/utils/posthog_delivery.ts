const POSTHOG_CAPTURE_URL = 'https://eu.i.posthog.com/capture/'

export type PostHogGroups = Record<string, string>

export interface PostHogCapturePayload {
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

export function captureProperties(payload: PostHogCapturePayload) {
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

export interface PostHogDeliveryConfig {
  apiKey?: string
  host?: string
}

// No request context, authentication, database, or provider credentials in the payload.
export async function deliverPosthogCapture(config: PostHogDeliveryConfig, payload: PostHogCapturePayload): Promise<PostHogDeliveryResult> {
  const startedAt = Date.now()
  const finish = (result: Omit<PostHogDeliveryDetails, 'duration_ms'> & PostHogDeliveryOutcome): PostHogDeliveryResult => ({
    ...result,
    duration_ms: Date.now() - startedAt,
  })
  const apiKey = config.apiKey
  if (!apiKey)
    return finish({ outcome: 'permanent_failure', reason: 'not_configured', http_status: null, legacy_success: false })

  let posthogUrl: string
  let body: string
  try {
    posthogUrl = getPostHogCaptureUrl(config.host || POSTHOG_CAPTURE_URL)
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
    // PostHog Cloud acknowledges successful captures with the case-sensitive status "Ok".
    if (text.trim() && response !== 1 && !(response && typeof response === 'object' && (response.status === 1 || response.status === 'ok' || response.status === 'Ok')))
      return finish({ outcome: 'ambiguous', reason: 'invalid_response', http_status: res.status, legacy_success: true })
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

export function stripPostHogEndpoint(host: string) {
  for (const suffix of ['/i/v0/e', '/capture', '/s', '/e']) {
    if (host.endsWith(suffix))
      return `${host.slice(0, -suffix.length)}/`
  }
  return host
}

export function getPostHogCaptureUrl(host: string) {
  const normalizedHost = stripPostHogEndpoint(host.replace(/\/+$/, ''))
  const url = new URL('capture/', normalizedHost.endsWith('/') ? normalizedHost : `${normalizedHost}/`)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Invalid PostHog host')
  return url.toString()
}
