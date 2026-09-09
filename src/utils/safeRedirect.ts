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
