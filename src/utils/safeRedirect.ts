import type { LocationQuery } from 'vue-router'
import { isLocalDevHost } from './urlSafety'

function hasControlCharacters(path: string): boolean {
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i)
    if (code < 0x20 || code === 0x7F)
      return true
  }
  return false
}

function normalizeRedirectPath(path: string): string | null {
  try {
    const url = new URL(path, 'http://localhost')
    if (url.origin !== 'http://localhost')
      return null
    return `${url.pathname}${url.search}${url.hash}`
  }
  catch {
    return null
  }
}

function addConfiguredHost(hosts: Set<string>, raw: string | undefined) {
  if (typeof raw !== 'string' || !raw)
    return

  const withScheme = raw.includes('://') ? raw : `https://${raw}`
  try {
    hosts.add(new URL(withScheme).hostname)
  }
  catch {
    // Ignore invalid configured hosts.
  }
}

/**
 * Validates in-app redirect targets from query params (`to`, `return_to`, …).
 * Only same-origin relative paths are allowed.
 */
export function validateRedirectPath(
  path: string | null | undefined,
  fallback = '/dashboard',
  options?: { blockedPrefixes?: string[] },
): string {
  if (!path)
    return fallback

  if (!path.startsWith('/') || path.startsWith('//'))
    return fallback

  if (path.includes('\\') || hasControlCharacters(path))
    return fallback

  const normalized = normalizeRedirectPath(path)
  if (!normalized || !normalized.startsWith('/'))
    return fallback

  if (options?.blockedPrefixes?.some(prefix => normalized.startsWith(prefix)))
    return fallback

  return normalized
}

/**
 * Validates absolute HTTPS URLs used for auth email confirmation redirects.
 */
export function isAllowedConfirmationUrl(urlValue: string, options: {
  allowedHosts: string[]
  allowLocalDev?: boolean
}) {
  let url: URL
  try {
    url = new URL(urlValue)
  }
  catch {
    return false
  }

  if (options.allowLocalDev && isLocalDevHost(url.hostname) && url.protocol === 'http:')
    return true

  if (url.protocol !== 'https:')
    return false

  return options.allowedHosts.includes(url.hostname)
}

/** Auth email links verify through the Capgo API, which relays them to the auth provider. */
export const AUTH_VERIFY_PATH = '/auth/v1/verify'
export const CONSOLE_AUTH_VERIFY_PATH = '/private/console/auth/verify'

export function resolveConfirmationUrl(query: LocationQuery, options: {
  allowedHosts: string[]
  allowLocalDev?: boolean
  /** Capgo API base; verification links are rewritten onto it. */
  apiHost?: string
}): string | null {
  const confirmationUrl = query.confirmation_url
  if (typeof confirmationUrl !== 'string' || !confirmationUrl)
    return null

  try {
    // Vue Router already decodes query values. Only decode legacy URLs whose scheme is still encoded.
    const decodedUrl = /^https?%3A/i.test(confirmationUrl) ? decodeURIComponent(confirmationUrl) : confirmationUrl
    let url = new URL(decodedUrl)
    const isVerifyLink = url.pathname === AUTH_VERIFY_PATH || url.pathname === CONSOLE_AUTH_VERIFY_PATH
    if (isVerifyLink && options.apiHost) {
      // Whatever host the email named, the token is only ever verified by our
      // own auth provider through the API; its redirect allow-list does the rest.
      // String concatenation on purpose: the API base may carry a path prefix (local /functions/v1).
      const relayed = new URL(`${options.apiHost.replace(/\/$/, '')}${CONSOLE_AUTH_VERIFY_PATH}`)
      relayed.search = url.search
      url = relayed
    }
    else if (!isAllowedConfirmationUrl(url.href, options)) {
      return null
    }

    if (isVerifyLink && url.searchParams.has('token')) {
      // Some email links place these parameters outside the nested confirmation URL.
      for (const parameter of ['type', 'redirect_to'] as const) {
        const value = query[parameter]
        if (!url.searchParams.has(parameter) && typeof value === 'string')
          url.searchParams.set(parameter, value)
      }
    }
    return url.href
  }
  catch {
    return null
  }
}

export function getAllowedConfirmationHosts() {
  const hosts = new Set<string>()

  addConfiguredHost(hosts, import.meta.env.VITE_APP_URL)
  addConfiguredHost(hosts, import.meta.env.VITE_API_HOST)

  // Production fallbacks only; the repo config file stays out of the bundle (it carries backend keys).
  if (hosts.size === 0) {
    addConfiguredHost(hosts, 'console.capgo.app')
    addConfiguredHost(hosts, 'api.capgo.app')
  }

  return [...hosts]
}
