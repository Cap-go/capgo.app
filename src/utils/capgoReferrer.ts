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
