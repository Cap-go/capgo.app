import { useSupabase } from './supabase'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const SIGNED_URL_CACHE_MAX_AGE_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 500
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/(.+)$/
const signedUrlCache = new Map<string, { url: string, expiresAt: number }>()

export function resolveImagePath(raw?: string | null) {
  if (!raw)
    return { normalized: '', shouldSign: false }

  const trimmed = raw.trim()
  if (!trimmed)
    return { normalized: '', shouldSign: false }

  try {
    const url = new URL(trimmed)
    const match = STORAGE_URL_REGEX.exec(url.pathname)
    if (match?.[1]) {
      return {
        normalized: decodeURIComponent(match[1]).replace(/^\/+/, ''),
        shouldSign: true,
      }
    }

    return {
      normalized: trimmed,
      shouldSign: false,
    }
  }
  catch {
    return {
      normalized: trimmed.replace(/^images\//, '').replace(/^\/+/, ''),
      shouldSign: true,
    }
  }
}

export function getImmediateImageUrl(raw?: string | null) {
  const { normalized, shouldSign } = resolveImagePath(raw)
  return shouldSign ? '' : normalized
}

export async function createSignedImageUrl(path?: string | null, options: { forceRefresh?: boolean } = {}) {
  const { normalized, shouldSign } = resolveImagePath(path)
  if (!normalized)
    return ''

  if (!shouldSign)
    return normalized

  const cacheKey = `images:${normalized}`
  if (options.forceRefresh) {
    signedUrlCache.delete(cacheKey)
  }
  else {
    const cached = signedUrlCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now())
      return cached.url
    if (cached)
      signedUrlCache.delete(cacheKey)
  }

  const { data, error } = await useSupabase()
    .storage
    .from('images')
    .createSignedUrl(normalized, SIGNED_URL_TTL_SECONDS)

  if (error || !data?.signedUrl)
    return ''

  signedUrlCache.set(cacheKey, {
    url: data.signedUrl,
    expiresAt: Date.now() + Math.min(SIGNED_URL_TTL_SECONDS * 1000, SIGNED_URL_CACHE_MAX_AGE_MS),
  })
  if (signedUrlCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = signedUrlCache.keys().next().value
    if (oldestKey)
      signedUrlCache.delete(oldestKey)
  }
  return data.signedUrl
}
