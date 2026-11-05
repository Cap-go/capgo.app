import { getCapgoCliHttpStatus, readCapgoCliApiErrorPayload } from '../api/capgo-http-error-payload'
import { isTransientNetworkError } from './network-error'

export const CAPGO_API_RETRY_MAX_ATTEMPTS = 3

/** Backend 503 error codes that are safe to retry during uploads and preflight. */
export const EXPLICIT_RETRYABLE_503_ERROR_CODES = new Set([
  'database_unavailable',
  'upstream_unavailable',
  'upload_authorization_unavailable',
  'event_queue_unavailable',
])

const NETWORK_RETRY_DELAYS_MS = [500, 1000]
const DEFAULT_503_RETRY_MS = 2000
export const CAPGO_API_MAX_RETRY_DELAY_MS = 10_000

export type CapgoApiRetryOptions = {
  /** When false, only explicit transient 503 responses are retried (not transport errors). */
  retryTransientNetwork?: boolean
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function capRetryDelayMs(delayMs: number): number {
  return Math.min(Math.max(0, delayMs), CAPGO_API_MAX_RETRY_DELAY_MS)
}

function retryAfterHeaderDelayMs(response: Response): number | null {
  const retryAfter = response.headers.get('Retry-After')?.trim()
  if (!retryAfter)
    return null
  if (/^\d+$/.test(retryAfter)) {
    const retryAfterSeconds = Number(retryAfter)
    if (!Number.isSafeInteger(retryAfterSeconds) || retryAfterSeconds < 0)
      return null
    return capRetryDelayMs(retryAfterSeconds * 1000)
  }
  const retryAt = Date.parse(retryAfter)
  if (Number.isFinite(retryAt)) {
    const waitMs = retryAt - Date.now()
    if (waitMs >= 0)
      return capRetryDelayMs(waitMs)
  }
  return null
}

function retryAfterFromPayload(payload: { moreInfo?: Record<string, unknown> } | null): number | null {
  const retryAfterSeconds = payload?.moreInfo?.retryAfterSeconds
  if (typeof retryAfterSeconds !== 'number' || !Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0)
    return null
  return capRetryDelayMs(retryAfterSeconds * 1000)
}

/** Transport failures and curated transient 503 responses from the Capgo API. */
export async function isRetryableCapgoApiError(
  error: unknown,
  options: CapgoApiRetryOptions = {},
): Promise<boolean> {
  if (options.retryTransientNetwork !== false && isTransientNetworkError(error))
    return true
  if (getCapgoCliHttpStatus(error) !== 503)
    return false

  const payload = await readCapgoCliApiErrorPayload(error)
  if (payload?.error && EXPLICIT_RETRYABLE_503_ERROR_CODES.has(payload.error))
    return true
  if (retryAfterFromPayload(payload) !== null)
    return true

  const response = (error as { context?: Response } | null)?.context
  if (response instanceof Response && retryAfterHeaderDelayMs(response) !== null)
    return true

  return false
}

export async function getCapgoApiRetryDelayMs(error: unknown, attemptIndex: number): Promise<number> {
  if (isTransientNetworkError(error))
    return NETWORK_RETRY_DELAYS_MS[attemptIndex] ?? 1000

  const payload = await readCapgoCliApiErrorPayload(error)
  const fromPayload = retryAfterFromPayload(payload)
  if (fromPayload !== null)
    return fromPayload

  const response = (error as { context?: Response } | null)?.context
  if (response instanceof Response) {
    const fromHeader = retryAfterHeaderDelayMs(response)
    if (fromHeader !== null)
      return fromHeader
  }

  return DEFAULT_503_RETRY_MS
}

export async function invokeCapgoCliApiResultWithRetry<T>(
  call: () => PromiseLike<{ data: T | null, error: { message?: string } | null }>,
  sleepFn: (ms: number) => Promise<void> = sleep,
  options: CapgoApiRetryOptions = {},
): Promise<{ data: T | null, error: { message?: string } | null }> {
  let lastResult = await call()
  if (!lastResult.error)
    return lastResult

  for (let attempt = 1; attempt < CAPGO_API_RETRY_MAX_ATTEMPTS; attempt++) {
    if (!(await isRetryableCapgoApiError(lastResult.error, options)))
      return lastResult
    await sleepFn(await getCapgoApiRetryDelayMs(lastResult.error, attempt - 1))
    lastResult = await call()
    if (!lastResult.error)
      return lastResult
  }

  return lastResult
}
