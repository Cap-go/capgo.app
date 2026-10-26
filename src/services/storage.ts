import { defaultApiHost, useConsole } from './console'
import { resolveConsoleApiBase } from './consoleAuth'

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7
const SIGNED_URL_CACHE_MAX_AGE_MS = 15 * 60 * 1000
const MAX_CACHE_ENTRIES = 500
// Fetch a new image token this long before the current one expires, so URLs
// already on screen keep loading.
const IMAGE_TOKEN_RENEW_MARGIN_MS = 60 * 60 * 1000
const STORAGE_URL_REGEX = /\/storage\/v1\/object(?:\/(?:public|sign))?\/images\/./
const CONSOLE_READ_PATH = '/private/console/images/read'
const signedUrlCache = new Map<string, { url: string, expiresAt: number }>()

interface ImageToken {
  userId: string
  token: string
  expiresAt: number
}

let imageToken: ImageToken | null = null
let pendingImageToken: { userId: string, promise: Promise<string | null> } | null = null

function consoleApiBase() {
  return resolveConsoleApiBase(defaultApiHost)
}

// Only our own image relay URLs carry a storage path worth re-signing; an external
// URL that merely ends with the same path is left alone.
function isConsoleReadUrl(url: URL) {
  if (!url.pathname.endsWith(CONSOLE_READ_PATH) || !url.searchParams.get('path') || !(url.searchParams.get('t') || url.searchParams.get('token')))
    return false
  try {
    return url.origin === new URL(consoleApiBase()).origin
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
      // Same order as the API's normalizeImagePath, so `/images/x` becomes `x`.
      normalized: trimmed.replace(/^\/+/, '').replace(/^images\//, '').replace(/^\/+/, ''),
      shouldSign: true,
    }
  }
}

export function getImmediateImageUrl(raw?: string | null) {
  const { normalized, shouldSign } = resolveImagePath(raw)
  return shouldSign ? '' : normalized
}

/** True for an image URL served by the console image relay. */
export function isConsoleImageUrl(raw: string) {
  try {
    return isConsoleReadUrl(new URL(raw))
  }
  catch {
    return false
  }
}

async function fetchImageToken(userId: string) {
  const { data: response } = await useConsole().functions.invoke<{ data: { token: string, expiresAt: number } | null }>('private/console/images/token', { body: {} })
  const issued = response?.data
  if (!issued?.token)
    return null
  imageToken = { userId, token: issued.token, expiresAt: issued.expiresAt }
  return issued.token
}

/**
 * The caller's image token: one JWT-like credential that can only read images,
 * issued once and reused for every image URL until it nears expiry. Image
 * elements cannot send the session bearer header, so it rides in the URL.
 */
async function getImageToken(forceRefresh: boolean) {
  const { data } = await useConsole().auth.getSession()
  const userId = data.session?.user?.id
  if (!userId) {
    imageToken = null
    return null
  }
  if (!forceRefresh && imageToken?.userId === userId && imageToken.expiresAt * 1000 - Date.now() > IMAGE_TOKEN_RENEW_MARGIN_MS)
    return imageToken.token
  if (pendingImageToken?.userId === userId)
    return pendingImageToken.promise

  const promise = fetchImageToken(userId).finally(() => {
    if (pendingImageToken?.promise === promise)
      pendingImageToken = null
  })
  pendingImageToken = { userId, promise }
  return promise
}

function buildImageReadUrl(path: string, token: string) {
  const url = new URL(`${consoleApiBase()}${CONSOLE_READ_PATH}`)
  url.searchParams.set('path', path)
  url.searchParams.set('t', token)
  return url.href
}

// Legacy values stored as full storage URLs need the API to verify their origin
// and extract the object path, so they still go through the sign endpoint.
async function signLegacyStorageUrl(normalized: string, forceRefresh: boolean) {
  const cacheKey = `images:${normalized}`
  if (forceRefresh) {
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

export async function createSignedImageUrl(path?: string | null, options: { forceRefresh?: boolean } = {}) {
  const { normalized, shouldSign } = resolveImagePath(path)
  if (!normalized)
    return ''

  if (!shouldSign)
    return normalized

  if (normalized.includes('://'))
    return signLegacyStorageUrl(normalized, options.forceRefresh ?? false)

  const token = await getImageToken(options.forceRefresh ?? false)
  return token ? buildImageReadUrl(normalized, token) : ''
}

const IMAGE_RETRIED_ATTRIBUTE = 'data-capgo-image-retried'

/**
 * One capture-phase handler for every console image. An `<img>` rendered from a
 * URL whose image token has expired gets one retry with a current token; an
 * image that is really gone (or not readable) is hidden instead of showing the
 * browser's broken-image icon.
 */
export function installConsoleImageFallback(target: Document = document) {
  target.addEventListener('error', (event) => {
    const image = event.target
    if (!(image instanceof HTMLImageElement) || !isConsoleImageUrl(image.currentSrc || image.src))
      return
    const failedUrl = image.src
    if (image.getAttribute(IMAGE_RETRIED_ATTRIBUTE) === failedUrl) {
      image.style.visibility = 'hidden'
      return
    }
    // Rebuilding the URL renews the token only when it is near or past expiry,
    // so a page of missing images does not fetch a token per image.
    void createSignedImageUrl(failedUrl).then((freshUrl) => {
      if (freshUrl && freshUrl !== failedUrl) {
        image.setAttribute(IMAGE_RETRIED_ATTRIBUTE, freshUrl)
        image.src = freshUrl
      }
      else {
        image.setAttribute(IMAGE_RETRIED_ATTRIBUTE, failedUrl)
        image.style.visibility = 'hidden'
      }
    })
  }, true)
  // Vue reuses elements: once one shows a working image again, undo the fallback.
  target.addEventListener('load', (event) => {
    const image = event.target
    if (image instanceof HTMLImageElement && image.hasAttribute(IMAGE_RETRIED_ATTRIBUTE)) {
      image.removeAttribute(IMAGE_RETRIED_ATTRIBUTE)
      image.style.visibility = ''
    }
  }, true)
}
