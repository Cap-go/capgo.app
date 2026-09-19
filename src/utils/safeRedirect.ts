import type { LocationQuery } from 'vue-router'
import configs from '../../configs.json'
import { isLocalDevHost } from './sanitize'

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

export function resolveConfirmationUrl(query: LocationQuery, options: {
  allowedHosts: string[]
  allowLocalDev?: boolean
}): string | null {
  const confirmationUrl = query.confirmation_url
  if (typeof confirmationUrl !== 'string' || !confirmationUrl)
    return null

  try {
    // Vue Router already decodes query values. Only decode legacy URLs whose scheme is still encoded.
    const decodedUrl = /^https?%3A/i.test(confirmationUrl) ? decodeURIComponent(confirmationUrl) : confirmationUrl
    if (!isAllowedConfirmationUrl(decodedUrl, options))
      return null

    const url = new URL(decodedUrl)
    if (url.pathname === '/auth/v1/verify' && url.searchParams.has('token')) {
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
  addConfiguredHost(hosts, import.meta.env.VITE_SUPABASE_URL)

  if (hosts.size === 0) {
    addConfiguredHost(hosts, configs.base_domain?.prod)
    addConfiguredHost(hosts, configs.supa_url?.prod)
  }

  return [...hosts]
}
