/** Normalize an untrusted billing link, or use the caller's safe fallback. */
export function normalizePlansUrl(candidate: unknown, fallback: string): string {
  if (typeof candidate !== 'string')
    return fallback
  try {
    const url = new URL(candidate)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password)
      return url.href
  }
  catch {
    // Invalid links use the trusted fallback.
  }
  return fallback
}

/** Console plans link that also opens the trial "add a card" prompt for its `oid` org. */
export function withTrialCardPrompt(plansUrl: string): string {
  const url = new URL(plansUrl)
  url.searchParams.set('trial_card', '1')
  return url.href
}
