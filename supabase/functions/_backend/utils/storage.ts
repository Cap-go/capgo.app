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

export function getStorageAllowedOrigins(c: Context): string[] {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL').trim()
  if (!supabaseUrl)
    return []
  try {
    return [new URL(supabaseUrl).origin]
  }
  catch {
    return []
  }
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
    const match = STORAGE_URL_REGEX.exec(url.pathname)
    if (match?.[1]) {
      // Only extract object paths from our configured Supabase origin.
      if (!options?.allowedOrigins?.includes(url.origin))
        return null
      return decodeURIComponent(match[1]).replace(/^\/+/, '')
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
      const isOurStoragePath = STORAGE_URL_REGEX.test(url.pathname)
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
