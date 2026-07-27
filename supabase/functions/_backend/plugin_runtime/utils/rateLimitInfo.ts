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
