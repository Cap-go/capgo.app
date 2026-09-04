const SCHEME_LIKE_PATH = /^[a-z][a-z0-9+.-]*:/i

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

  if (SCHEME_LIKE_PATH.test(path))
    return fallback

  if (path.includes('\\'))
    return fallback

  if (options?.blockedPrefixes?.some(prefix => path.startsWith(prefix)))
    return fallback

  return path
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

  if (options.allowLocalDev) {
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
      return true
  }

  if (url.protocol !== 'https:')
    return false

  return options.allowedHosts.includes(url.hostname)
}

export function getAllowedConfirmationHosts() {
  const hosts = new Set<string>()

  for (const envKey of ['VITE_APP_URL', 'VITE_SUPABASE_URL'] as const) {
    const raw = import.meta.env[envKey]
    if (typeof raw !== 'string' || !raw)
      continue
    try {
      hosts.add(new URL(raw).hostname)
    }
    catch {
      // Ignore invalid build-time URLs.
    }
  }

  return [...hosts]
}
