import type { Context } from 'hono'
import { supabaseAdmin } from './supabase.ts'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/(.+)$/

export interface ImagePathScope {
  orgId?: string
  userId?: string
  appId?: string
}

export function normalizeImagePath(raw?: string | null) {
  if (!raw)
    return null

  const trimmed = raw.trim()
  if (!trimmed)
    return null

  try {
    const url = new URL(trimmed)
    const match = STORAGE_URL_REGEX.exec(url.pathname)
    if (match?.[1])
      return decodeURIComponent(match[1])
    // External non-storage URL — leave as absolute URL marker via null normalize
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

  // Absolute non-storage URLs are returned unchanged (no admin signing).
  if (rawPath.includes('://')) {
    try {
      const pathname = new URL(rawPath).pathname
      if (!STORAGE_URL_REGEX.test(pathname))
        return rawPath
    }
    catch {
      return rawPath
    }
  }

  const normalized = normalizeImagePath(rawPath)
  if (!normalized)
    return null

  // Refuse to mint admin signed URLs without an ownership scope.
  if (!scope || !isAllowedImagePath(normalized, scope))
    return null

  const { data, error } = await supabaseAdmin(c)
    .storage
    .from('images')
    .createSignedUrl(normalized, SIGNED_URL_TTL_SECONDS)

  if (error || !data?.signedUrl)
    return null

  return data.signedUrl
}
