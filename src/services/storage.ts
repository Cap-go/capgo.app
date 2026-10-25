import { defaultApiHost, useConsole } from './console'
import { resolveConsoleApiBase } from './consoleAuth'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const SIGNED_URL_CACHE_MAX_AGE_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 500
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/./
const CONSOLE_READ_PATH = '/private/console/images/read'
const signedUrlCache = new Map<string, { url: string, expiresAt: number }>()

// Only our own image relay URLs carry a storage path worth re-signing; an external
// URL that merely ends with the same path is left alone.
function isConsoleReadUrl(url: URL) {
  if (!url.pathname.endsWith(CONSOLE_READ_PATH) || !url.searchParams.get('path') || !url.searchParams.get('token'))
    return false
  try {
    return url.origin === new URL(resolveConsoleApiBase(defaultApiHost)).origin
  }
  catch {
    return false
  }
}

function decodePathname(pathname: string) {
  try {
    return decodeURIComponent(pathname)
  }
  catch {
    return pathname
  }
}

export function resolveImagePath(raw?: string | null) {
  if (!raw)
    return { normalized: '', shouldSign: false }

  const trimmed = raw.trim()
  if (!trimmed)
    return { normalized: '', shouldSign: false }

  try {
    const url = new URL(trimmed)
    // A URL this console signed earlier carries the storage path; re-sign from it.
    if (isConsoleReadUrl(url))
      return { normalized: url.searchParams.get('path')!.replace(/^\/+/, ''), shouldSign: true }
    // Storage URLs (encoded routes included) are signed by the API, which checks
    // the URL comes from Capgo storage before extracting its key.
    if (STORAGE_URL_REGEX.test(decodePathname(url.pathname))) {
      return {
        normalized: trimmed,
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

  const { data, error } = await useConsole()
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
