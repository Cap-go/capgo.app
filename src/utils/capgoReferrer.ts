/**
 * Trusted Capgo origins for URL session login handoff (landing → console).
 * External or missing referrers still require explicit confirmation.
 */
export function isCapgoDomainReferrer(referrer: string | null | undefined): boolean {
  const trimmed = referrer?.trim()
  if (!trimmed)
    return false

  try {
    const { hostname } = new URL(trimmed)
    return hostname === 'capgo.app' || hostname.endsWith('.capgo.app')
  }
  catch {
    return false
  }
}

/**
 * True when this document first loaded on a login page.
 * Last path segment is `login` so `/console/login` still counts.
 * Confirmation is only for a direct landing with session tokens.
 * In-app hops (invite → login, etc.) must not show it.
 */
export function isDirectLoginLanding(firstUrl: string | null | undefined): boolean {
  if (!firstUrl)
    return true

  try {
    const path = new URL(firstUrl).pathname.replace(/\/+$/, '') || '/'
    const lastSegment = path.split('/').filter(Boolean).at(-1)
    return lastSegment === 'login'
  }
  catch {
    return true
  }
}
