import type { Context } from 'hono'
import { getEnv } from './utils.ts'

export function buildRateLimitInfo(resetAt?: number) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt)) {
    return {}
  }

  const retryAfterSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
  return {
    rateLimitResetAt: resetAt,
    retryAfterSeconds,
  }
}

/** Default client/edge backoff for sticky on-prem / cancelled plugin responses (1h). */
export const DEFAULT_ON_PREMISE_RETRY_AFTER_SECONDS = 60 * 60

export function getOnPremiseRetryAfterSeconds(c: Context): number {
  const envLimit = getEnv(c, 'RATE_LIMIT_ON_PREMISE_RETRY_AFTER_SECONDS')
  if (envLimit) {
    const trimmed = envLimit.trim()
    const parsed = Number(trimmed)
    if (/^\d+$/.test(trimmed) && Number.isSafeInteger(parsed) && parsed > 0)
      return parsed
  }
  return DEFAULT_ON_PREMISE_RETRY_AFTER_SECONDS
}

/**
 * Canonical 429 for on-prem / cancelled plugin responses.
 * Sets Retry-After + Cache-Control so clients and the edge snippet skip the worker
 * until the backoff window expires.
 *
 * Do not use for IP-scoped guards (e.g. update enumeration): those must stay
 * `private, no-store` so they cannot poison the app-keyed public edge cache.
 */
export function onPremiseAppResponse(c: Context) {
  const retryAfterSeconds = getOnPremiseRetryAfterSeconds(c)
  const resetAt = Date.now() + retryAfterSeconds * 1000
  const moreInfo = buildRateLimitInfo(resetAt)

  // Retry-After is relative; X-RateLimit-Reset is absolute. The edge snippet
  // rewrites Retry-After + Cache-Control from the reset on every cache HIT.
  c.header('Retry-After', String(retryAfterSeconds))
  c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)))
  c.header('Cache-Control', `public, max-age=${retryAfterSeconds}`)

  return c.json({
    error: 'on_premise_app',
    message: 'On-premise app detected',
    moreInfo,
  }, 429)
}
