import { normalizeWebsiteLiveUrl } from '~/stores/appUpdateMode'

// People who used to sign up through the retired WebNativeApp site now land on
// Capgo Web2App. They arrive with `?ref=webnativeapp&website=<url>`, either on
// /register or on a page that the auth guard forwards as `?to=<path?query>`.
export const WEB2APP_LEGACY_REF = 'webnativeapp'
const WEB2APP_ARRIVAL_STORAGE_KEY = 'capgo:web2app-arrival'
const WEB2APP_ARRIVAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface Web2AppArrival {
  websiteUrl: string | null
}

type QueryValue = string | null | undefined | Array<string | null>
type QueryLike = Record<string, QueryValue>

function firstQueryValue(value: QueryValue): string | null {
  if (Array.isArray(value))
    return value.find((entry): entry is string => typeof entry === 'string') ?? null
  return typeof value === 'string' ? value : null
}

function arrivalFromParams(ref: string | null, website: string | null): Web2AppArrival | null {
  const websiteUrl = website ? normalizeWebsiteLiveUrl(website) : null
  if (websiteUrl)
    return { websiteUrl }
  if (ref?.trim().toLowerCase() === WEB2APP_LEGACY_REF)
    return { websiteUrl: null }
  return null
}

function arrivalFromRelativePath(path: string | null): Web2AppArrival | null {
  // Only same-origin relative paths: the auth guard stores `to.fullPath`.
  if (!path?.startsWith('/') || path.startsWith('//'))
    return null
  const queryStart = path.indexOf('?')
  if (queryStart < 0)
    return null
  const params = new URLSearchParams(path.slice(queryStart + 1).split('#')[0])
  return arrivalFromParams(params.get('ref'), params.get('website'))
}

export function parseWeb2AppArrival(query: QueryLike): Web2AppArrival | null {
  return arrivalFromParams(firstQueryValue(query.ref), firstQueryValue(query.website))
    ?? arrivalFromRelativePath(firstQueryValue(query.to))
}

export function web2AppArrivalQuery(query: QueryLike): Record<string, string> {
  const forwarded: Record<string, string> = {}
  const ref = firstQueryValue(query.ref)
  const website = firstQueryValue(query.website)
  if (ref)
    forwarded.ref = ref
  if (website)
    forwarded.website = website
  return forwarded
}

function arrivalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  }
  catch {
    return null
  }
}

// Kept across the email confirmation round trip, which drops the query string.
export function rememberWeb2AppArrival(arrival: Web2AppArrival, now = Date.now()) {
  try {
    arrivalStorage()?.setItem(WEB2APP_ARRIVAL_STORAGE_KEY, JSON.stringify({ ...arrival, savedAt: now }))
  }
  catch {
    // Private mode or a full quota: the query string still covers the direct path.
  }
}

export function readRememberedWeb2AppArrival(now = Date.now()): Web2AppArrival | null {
  let raw: string | null = null
  try {
    raw = arrivalStorage()?.getItem(WEB2APP_ARRIVAL_STORAGE_KEY) ?? null
  }
  catch {
    return null
  }
  if (!raw)
    return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null)
      return null
    const { savedAt, websiteUrl } = parsed as { savedAt?: unknown, websiteUrl?: unknown }
    if (typeof savedAt !== 'number' || now - savedAt > WEB2APP_ARRIVAL_MAX_AGE_MS || savedAt > now)
      return null
    return { websiteUrl: typeof websiteUrl === 'string' ? normalizeWebsiteLiveUrl(websiteUrl) : null }
  }
  catch {
    return null
  }
}

export function clearRememberedWeb2AppArrival() {
  try {
    arrivalStorage()?.removeItem(WEB2APP_ARRIVAL_STORAGE_KEY)
  }
  catch {
    // Nothing to clear.
  }
}
