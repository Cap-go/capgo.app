import type { Context } from 'hono'
import type { RateLimitStatus } from './rate_limit.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import { getClientIP } from './rate_limit.ts'
import { getEnv } from './utils.ts'

const UPDATE_ENUMERATION_SLOT_PATH = '/rate-limit/update-enumeration/slot'
const UPDATE_ENUMERATION_LIMIT_PATH = '/rate-limit/update-enumeration/limited'
const UPDATE_ENUMERATION_TTL_SECONDS = 60 * 15
const DEFAULT_UPDATE_ENUMERATION_MISS_LIMIT = 5
const UPDATE_ENUMERATION_SLOT_MULTIPLIER = 4

interface UpdateEnumerationSlotData {
  resetAt: number
}

interface UpdateEnumerationLimitData {
  resetAt: number
}

interface UpdateEnumerationMissState {
  count: number
  resetAt?: number
}

function getUpdateEnumerationMissLimit(c: Context) {
  const envLimit = getEnv(c, 'RATE_LIMIT_UPDATE_ENUMERATION_MISSES')
  if (envLimit) {
    const parsed = Number.parseInt(envLimit, 10)
    if (!Number.isNaN(parsed) && parsed > 0)
      return parsed
  }
  return DEFAULT_UPDATE_ENUMERATION_MISS_LIMIT
}

function getUpdateEnumerationHashSecret(c: Context) {
  return getEnv(c, 'RATE_LIMIT_UPDATE_ENUMERATION_HASH_SECRET')
    || getEnv(c, 'JWT_SECRET')
    || getEnv(c, 'API_SECRET')
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function hmacSha256Hex(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value))
  return bytesToHex(new Uint8Array(digest))
}

async function hashAppId(c: Context, appId: string) {
  const normalized = appId.trim().toLowerCase()
  const secret = getUpdateEnumerationHashSecret(c)
  if (secret)
    return await hmacSha256Hex(normalized, secret)

  return await sha256Hex(normalized)
}

function getUpdateEnumerationSlotCount(limit: number) {
  return limit * UPDATE_ENUMERATION_SLOT_MULTIPLIER
}

function getUpdateEnumerationSlot(appIdHash: string, slotCount: number) {
  const prefix = appIdHash.slice(0, 8)
  return (Number.parseInt(prefix, 16) % slotCount).toString()
}

function buildUpdateEnumerationCacheEntry(c: Context) {
  const ip = getClientIP(c)
  if (ip === 'unknown') {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Update enumeration guard skipped: unknown IP',
    })
    return null
  }

  const helper = new CacheHelper(c)
  return { helper, ip }
}

function buildUpdateEnumerationSlotRequest(helper: CacheHelper, ip: string, slot: string) {
  return helper.buildRequest(UPDATE_ENUMERATION_SLOT_PATH, { ip, slot })
}

function buildUpdateEnumerationLimitRequest(helper: CacheHelper, ip: string) {
  return helper.buildRequest(UPDATE_ENUMERATION_LIMIT_PATH, { ip })
}

export async function isUpdateEnumerationLimited(c: Context): Promise<RateLimitStatus> {
  try {
    const cacheEntry = buildUpdateEnumerationCacheEntry(c)
    if (!cacheEntry)
      return { limited: false }

    const existingLimit = await cacheEntry.helper.matchJson<UpdateEnumerationLimitData>(
      buildUpdateEnumerationLimitRequest(cacheEntry.helper, cacheEntry.ip),
    )
    if (existingLimit)
      return { limited: true, resetAt: existingLimit.resetAt }
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Update enumeration guard limit read failed',
      error,
    })
  }

  return { limited: false }
}

async function countOccupiedMissSlots(c: Context, helper: CacheHelper, ip: string, slotCount: number): Promise<UpdateEnumerationMissState> {
  const slotRequests = Array.from({ length: slotCount }, (_, index) => (
    buildUpdateEnumerationSlotRequest(helper, ip, index.toString())
  ))

  try {
    const slots = await Promise.all(slotRequests.map(request => helper.matchJson<UpdateEnumerationSlotData>(request)))
    let count = 0
    let resetAt: number | undefined
    for (const slot of slots) {
      if (!slot)
        continue
      count += 1
      if (!resetAt || slot.resetAt > resetAt)
        resetAt = slot.resetAt
    }
    return { count, resetAt }
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Update enumeration guard slot read failed',
      error,
    })
    return { count: 0 }
  }
}

export async function recordUpdateEnumerationMiss(c: Context, appId: string): Promise<RateLimitStatus> {
  if (!appId?.trim())
    return { limited: false }

  const limit = getUpdateEnumerationMissLimit(c)
  const slotCount = getUpdateEnumerationSlotCount(limit)
  const appIdHash = await hashAppId(c, appId)
  const slot = getUpdateEnumerationSlot(appIdHash, slotCount)
  const resetAt = Date.now() + UPDATE_ENUMERATION_TTL_SECONDS * 1000
  let cacheEntry: ReturnType<typeof buildUpdateEnumerationCacheEntry>
  let missState: UpdateEnumerationMissState

  try {
    cacheEntry = buildUpdateEnumerationCacheEntry(c)
    if (!cacheEntry)
      return { limited: false }

    const limitRequest = buildUpdateEnumerationLimitRequest(cacheEntry.helper, cacheEntry.ip)
    const existingLimit = await cacheEntry.helper.matchJson<UpdateEnumerationLimitData>(limitRequest)
    if (existingLimit)
      return { limited: true, resetAt: existingLimit.resetAt }

    // Slot markers are idempotent writes. Concurrent misses cannot overwrite a
    // shared counter, and the keyed hash prevents useful precomputed slot collisions.
    const slotRequest = buildUpdateEnumerationSlotRequest(cacheEntry.helper, cacheEntry.ip, slot)
    await cacheEntry.helper.putJson(slotRequest, { resetAt }, UPDATE_ENUMERATION_TTL_SECONDS)
    missState = await countOccupiedMissSlots(c, cacheEntry.helper, cacheEntry.ip, slotCount)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Update enumeration guard slot write failed while recording miss',
      error,
    })
    return { limited: false }
  }

  const limited = missState.count >= limit
  if (limited) {
    await cacheEntry.helper.putJson(
      buildUpdateEnumerationLimitRequest(cacheEntry.helper, cacheEntry.ip),
      { resetAt: missState.resetAt ?? resetAt },
      UPDATE_ENUMERATION_TTL_SECONDS,
    )
  }

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Recorded update enumeration miss',
    appIdHash: appIdHash.slice(0, 12),
    slot,
    count: missState.count,
    limit,
    limited,
  })

  return { limited, resetAt: missState.resetAt }
}

export function updateEnumerationLimitedResponse(c: Context) {
  return c.json({ error: 'on_premise_app' }, 429)
}
