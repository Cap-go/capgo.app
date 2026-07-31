import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import { getEnv } from './utils.ts'

// Cache TTL constants (in seconds)
const FAILED_AUTH_TTL = 60 * 15 // 15 minutes block for failed auth attempts
const API_KEY_RATE_LIMIT_TTL = 60 // 1 minute window for API key rate limiting

// Default limits - set high to catch only severe abuse, not normal usage
const DEFAULT_FAILED_AUTH_LIMIT = 20 // 20 failed attempts before blocking (catches brute force, allows mistakes)
const DEFAULT_API_KEY_RATE_LIMIT = 2000 // 2000 requests per minute per API key (catches infinite loops)
const DEFAULT_UPLOAD_API_KEY_RATE_LIMIT = 20000 // 20000 upload requests per minute per API key (supports large bundles)
const FAILED_AUTH_PATH = '/rate-limit/failed-auth'
const FAILED_ACCOUNT_AUTH_PATH = '/rate-limit/failed-auth-account'
const API_KEY_RATE_LIMIT_PATH = '/rate-limit/apikey'
const UPLOAD_API_KEY_RATE_LIMIT_PATH = '/rate-limit/apikey-upload'

interface RateLimitData {
  count: number
  resetAt?: number
}

export interface RateLimitStatus {
  limited: boolean
  resetAt?: number
}

export type APIKeyRateLimitScope = 'default' | 'upload'

/**
 * Get the client IP address from the request.
 * Cloudflare Workers provide the client IP in cf-connecting-ip header.
 * Returns 'unknown' if no IP headers are found - callers should handle this case.
 */
export function getClientIP(c: Context): string {
  // Cloudflare Workers provide the real client IP
  const cfConnectingIp = c.req.header('cf-connecting-ip')
  if (cfConnectingIp)
    return cfConnectingIp

  // Fallback to x-forwarded-for (less reliable but common)
  const forwardedFor = c.req.header('x-forwarded-for')
  if (forwardedFor) {
    // Take the first IP in the chain (original client)
    return forwardedFor.split(',')[0].trim()
  }

  // Fallback to x-real-ip
  const realIp = c.req.header('x-real-ip')
  if (realIp)
    return realIp

  // If no IP headers found, return unknown
  // Note: In production behind Cloudflare, cf-connecting-ip should always be present
  return 'unknown'
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function hashIdentifier(identifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier))
  return bytesToHex(new Uint8Array(digest))
}

export function normalizeRateLimitAccountIdentifier(identifier: string): string {
  return identifier.trim().toLowerCase()
}

async function getAccountRateLimitKey(identifier: string): Promise<string | null> {
  const normalized = normalizeRateLimitAccountIdentifier(identifier)
  if (!normalized)
    return null

  return await hashIdentifier(normalized)
}

function getRateLimitWindowSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000))
}

function buildResetAt() {
  return Date.now() + FAILED_AUTH_TTL * 1000
}

/**
 * Check if an IP is rate limited due to failed authentication attempts.
 * Returns true if the IP should be blocked.
 * Note: If cache is unavailable, rate limiting fails open (returns false) to avoid blocking legitimate traffic.
 */
export async function isIPRateLimited(c: Context): Promise<RateLimitStatus> {
  const ip = getClientIP(c)
  if (ip === 'unknown') {
    // Log warning but don't block - in production behind Cloudflare this shouldn't happen
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Rate limit check skipped: unknown IP (missing cf-connecting-ip header)',
    })
    return { limited: false }
  }

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_AUTH_PATH, { ip })
  const data = await cacheHelper.matchJson<RateLimitData>(cacheKey)

  // If no data or cache unavailable, fail open (don't block)
  if (!data)
    return { limited: false }

  const limit = getFailedAuthLimit(c)
  const isLimited = data.count >= limit

  if (isLimited) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'IP rate limited due to failed auth attempts',
      ip,
      count: data.count,
      limit,
    })
  }

  return { limited: isLimited, resetAt: data.resetAt }
}

/**
 * Record a failed authentication attempt for an IP.
 * After reaching the configured limit (default 20), the IP will be rate limited.
 * This should be awaited to ensure accurate counting before returning error responses.
 */
export async function recordFailedAuth(c: Context): Promise<void> {
  const ip = getClientIP(c)
  if (ip === 'unknown') {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Failed auth not recorded: unknown IP',
    })
    return
  }

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_AUTH_PATH, { ip })
  const existingData = await cacheHelper.matchJson<RateLimitData>(cacheKey)
  const resetAt = buildResetAt()

  const newData: RateLimitData = {
    count: (existingData?.count ?? 0) + 1,
    resetAt,
  }

  await cacheHelper.putJson(cacheKey, newData, getRateLimitWindowSeconds(resetAt, Date.now()))

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Recorded failed auth attempt',
    ip,
    count: newData.count,
  })
}

/**
 * Clear failed auth attempts for an IP after successful authentication.
 * Uses a 60 second TTL to ensure cache consistency across Cloudflare edge nodes.
 */
export async function clearFailedAuth(c: Context): Promise<void> {
  const ip = getClientIP(c)
  if (ip === 'unknown')
    return

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_AUTH_PATH, { ip })

  // Set count to 0 to effectively clear the rate limit
  // Use 60s TTL for cache consistency across Cloudflare edge nodes
  await cacheHelper.putJson(cacheKey, { count: 0 }, 60)
}

/**
 * Check if a specific account is rate limited due to failed authentication attempts.
 * The account identifier is hashed before it is used as a cache key to avoid storing
 * raw email addresses or user IDs in Cache API URLs.
 */
export async function isAccountRateLimited(c: Context, accountIdentifier: string): Promise<RateLimitStatus> {
  const accountKey = await getAccountRateLimitKey(accountIdentifier)
  if (!accountKey) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Account rate limit check skipped: empty account identifier',
    })
    return { limited: false }
  }

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_ACCOUNT_AUTH_PATH, { account: accountKey })
  const data = await cacheHelper.matchJson<RateLimitData>(cacheKey)

  if (!data)
    return { limited: false }

  const limit = getFailedAuthLimit(c)
  const isLimited = data.count >= limit

  if (isLimited) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Account rate limited due to failed auth attempts',
      accountKey,
      count: data.count,
      limit,
    })
  }

  return { limited: isLimited, resetAt: data.resetAt }
}

/**
 * Record a failed authentication attempt for a specific account.
 */
export async function recordFailedAccountAuth(c: Context, accountIdentifier: string): Promise<void> {
  const accountKey = await getAccountRateLimitKey(accountIdentifier)
  if (!accountKey) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Failed account auth not recorded: empty account identifier',
    })
    return
  }

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_ACCOUNT_AUTH_PATH, { account: accountKey })
  const existingData = await cacheHelper.matchJson<RateLimitData>(cacheKey)
  const resetAt = buildResetAt()

  const newData: RateLimitData = {
    count: (existingData?.count ?? 0) + 1,
    resetAt,
  }

  await cacheHelper.putJson(cacheKey, newData, getRateLimitWindowSeconds(resetAt, Date.now()))

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Recorded failed account auth attempt',
    accountKey,
    count: newData.count,
  })
}

/**
 * Clear failed authentication attempts for a specific account after successful authentication.
 */
export async function clearFailedAccountAuth(c: Context, accountIdentifier: string): Promise<void> {
  const accountKey = await getAccountRateLimitKey(accountIdentifier)
  if (!accountKey)
    return

  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(FAILED_ACCOUNT_AUTH_PATH, { account: accountKey })

  await cacheHelper.putJson(cacheKey, { count: 0 }, 60)
}

/**
 * Check if an API key is rate limited.
 * Returns true if the API key has exceeded its configured rate limit.
 * Note: If cache is unavailable, rate limiting fails open (returns false).
 */
export async function isAPIKeyRateLimited(c: Context, apiKeyId: number, scope: APIKeyRateLimitScope = 'default'): Promise<RateLimitStatus> {
  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(getAPIKeyRateLimitPath(scope), { id: String(apiKeyId) })
  const data = await cacheHelper.matchJson<RateLimitData>(cacheKey)

  // If no data or cache unavailable, fail open (don't block)
  if (!data)
    return { limited: false }

  const limit = getAPIKeyRateLimit(c, scope)
  const isLimited = data.count >= limit

  if (isLimited) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'API key rate limited',
      apiKeyId,
      scope,
      count: data.count,
      limit,
    })
  }

  return { limited: isLimited, resetAt: data.resetAt }
}

/**
 * Record an API call for rate limiting purposes.
 * Tracks the number of calls per API key within the configured time window.
 * This should be awaited to ensure accurate counting before checking limits.
 */
export async function recordAPIKeyUsage(c: Context, apiKeyId: number, scope: APIKeyRateLimitScope = 'default'): Promise<void> {
  const cacheHelper = new CacheHelper(c)
  const cacheKey = cacheHelper.buildRequest(getAPIKeyRateLimitPath(scope), { id: String(apiKeyId) })
  const existingData = await cacheHelper.matchJson<RateLimitData>(cacheKey)

  const newData: RateLimitData = {
    count: (existingData?.count ?? 0) + 1,
    resetAt: Date.now() + API_KEY_RATE_LIMIT_TTL * 1000,
  }

  await cacheHelper.putJson(cacheKey, newData, API_KEY_RATE_LIMIT_TTL)
}

/**
 * Get the failed auth limit from environment or use default (20).
 */
function getFailedAuthLimit(c: Context): number {
  const envLimit = getEnv(c, 'RATE_LIMIT_FAILED_AUTH')
  if (envLimit) {
    const parsed = Number.parseInt(envLimit, 10)
    if (!Number.isNaN(parsed) && parsed > 0)
      return parsed
  }
  return DEFAULT_FAILED_AUTH_LIMIT
}

function getAPIKeyRateLimitPath(scope: APIKeyRateLimitScope) {
  return scope === 'upload' ? UPLOAD_API_KEY_RATE_LIMIT_PATH : API_KEY_RATE_LIMIT_PATH
}

/**
 * Get the API key rate limit from environment or use default (2000/minute).
 */
function getAPIKeyRateLimit(c: Context, scope: APIKeyRateLimitScope): number {
  const envKey = scope === 'upload' ? 'RATE_LIMIT_API_KEY_UPLOAD' : 'RATE_LIMIT_API_KEY'
  const envLimit = getEnv(c, envKey)
  if (envLimit) {
    const parsed = Number.parseInt(envLimit, 10)
    if (!Number.isNaN(parsed) && parsed > 0)
      return parsed
  }
  return scope === 'upload' ? DEFAULT_UPLOAD_API_KEY_RATE_LIMIT : DEFAULT_API_KEY_RATE_LIMIT
}
