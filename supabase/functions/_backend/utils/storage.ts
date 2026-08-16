import type { Context } from 'hono'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/(.+)$/

export interface ImagePathScope {
  orgId?: string
  userId?: string
  appId?: string
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname)
  }
  catch {
    return pathname
  }
}

/** True when pathname is a Capgo images storage object URL (raw or percent-encoded route). */
function isStorageImagePathname(pathname: string) {
  return STORAGE_URL_REGEX.test(pathname)
    || STORAGE_URL_REGEX.test(decodePathname(pathname))
}

/**
 * Extract the images object key from a storage pathname.
 * Decode the route for matching when needed, but decode the object key only once.
 * Malformed percent-escapes are rejected (null), not returned as raw URLs.
 */
function extractStorageImageKey(pathname: string) {
  const rawMatch = STORAGE_URL_REGEX.exec(pathname)
  if (rawMatch?.[1]) {
    try {
      return decodeURIComponent(rawMatch[1]).replace(/^\/+/, '')
    }
    catch {
      return null
    }
  }

  const decodedMatch = STORAGE_URL_REGEX.exec(decodePathname(pathname))
  if (decodedMatch?.[1])
    return decodedMatch[1].replace(/^\/+/, '')

  return null
}

function originFromEnvUrl(raw: string) {
  const trimmed = raw.trim()
  if (!trimmed)
    return null
  try {
    return new URL(trimmed).origin
  }
  catch {
    return null
  }
}

/**
 * Origins that may host Capgo image objects.
 * Include both primary and replica/gateway hosts so signed/public object URLs
 * round-trip correctly; never treat an empty list as “trust any host”.
 */
export function getStorageAllowedOrigins(c: Context): string[] {
  const origins = new Set<string>()
  for (const key of ['SUPABASE_URL', 'SUPABASE_REPLICATE_URL'] as const) {
    const origin = originFromEnvUrl(getEnv(c, key))
    if (origin)
      origins.add(origin)
  }
  return [...origins]
}

export function isSupabaseStorageImageUrl(raw: string) {
  try {
    return isStorageImagePathname(new URL(raw).pathname)
  }
  catch {
    return false
  }
}

/**
 * Normalize a client-supplied icon/logo for persistence.
 * - Owned storage paths → relative object path
 * - True external CDN URLs → absolute URL unchanged
 * - Storage-shaped URLs on unknown/missing origins → reject (null)
 */
export function resolveWritableImageValue(
  raw: string,
  scope: ImagePathScope,
  allowedOrigins: string[],
) {
  const normalized = normalizeImagePath(raw, { allowedOrigins })
  if (raw.includes('://') && !normalized) {
    if (isSupabaseStorageImageUrl(raw))
      return null
    return raw
  }
  return assertAllowedImagePath(normalized, scope)
}

export function normalizeImagePath(
  raw?: string | null,
  options?: { allowedOrigins?: string[] },
) {
  if (!raw)
    return null

  const trimmed = raw.trim()
  if (!trimmed)
    return null

  try {
    const url = new URL(trimmed)
    const objectKey = extractStorageImageKey(url.pathname)
    if (objectKey) {
      // Require an explicit allow-list; empty list means misconfigured, not open.
      const allowed = options?.allowedOrigins ?? []
      if (!allowed.includes(url.origin))
        return null
      return objectKey
    }
    // External non-storage URL
    return null
  }
  catch {
    // Not a URL
  }

  return trimmed.replace(/^images\//, '').replace(/^\/+/, '')
}

function hasUnsafeImagePathSegments(normalized: string) {
  return normalized.includes('\0')
    || normalized.split('/').some(segment => segment === '.' || segment === '..')
}

/** Legacy icons stored as a single root-level filename (no `/`). */
export function isLegacyBareImageFilename(normalized: string) {
  return !!normalized && !normalized.includes('/') && !hasUnsafeImagePathSegments(normalized)
}

/**
 * Any path with a folder segment must pass ownership checks.
 * Bare filenames are the only legacy exception.
 */
export function isOwnershipBearingImagePath(normalized: string) {
  return normalized.includes('/')
}

/**
 * Image objects must live under a caller-owned prefix:
 * - user avatar: `{userId}/...`
 * - org logo / app icon: `org/{orgId}/...` (optionally `org/{orgId}/{appId}/...`)
 */
export function isAllowedImagePath(normalized: string, scope: ImagePathScope) {
  if (!normalized || hasUnsafeImagePathSegments(normalized))
    return false

  const prefixes: string[] = []
  if (scope.userId)
    prefixes.push(`${scope.userId}/`)
  if (scope.orgId) {
    prefixes.push(`org/${scope.orgId}/`)
    if (scope.appId)
      prefixes.push(`org/${scope.orgId}/${scope.appId}/`)
  }

  if (prefixes.length === 0)
    return false

  return prefixes.some(prefix => normalized.startsWith(prefix))
}

export function assertAllowedImagePath(normalized: string | null, scope: ImagePathScope) {
  if (!normalized)
    return null
  if (hasUnsafeImagePathSegments(normalized))
    return null
  if (isLegacyBareImageFilename(normalized))
    return normalized
  if (!isAllowedImagePath(normalized, scope))
    return null
  return normalized
}

export async function createSignedImageUrl(
  c: Context,
  rawPath?: string | null,
  scope?: ImagePathScope,
) {
  if (!rawPath)
    return null

  const allowedOrigins = getStorageAllowedOrigins(c)

  // Absolute non-storage / foreign-host URLs are returned unchanged (no admin signing).
  if (rawPath.includes('://')) {
    try {
      const url = new URL(rawPath)
      const isOurStoragePath = isStorageImagePathname(url.pathname)
        && allowedOrigins.includes(url.origin)
      if (!isOurStoragePath)
        return rawPath
    }
    catch {
      return rawPath
    }
  }

  const normalized = normalizeImagePath(rawPath, { allowedOrigins })
  if (!normalized || hasUnsafeImagePathSegments(normalized))
    return null

  // Foldered paths require a matching ownership scope before admin signing.
  if (isOwnershipBearingImagePath(normalized)) {
    if (!scope || !isAllowedImagePath(normalized, scope))
      return null
  }

  const { data, error } = await supabaseAdmin(c)
    .storage
    .from('images')
    .createSignedUrl(normalized, SIGNED_URL_TTL_SECONDS)

  if (error || !data?.signedUrl)
    return null

  return data.signedUrl
}
