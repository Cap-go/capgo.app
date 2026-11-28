// First-party cookies set by the website (capgo.app) that the console forwards to the API.

export async function getCookieValue(name: string) {
  if ('cookieStore' in globalThis && globalThis.cookieStore)
    return (await globalThis.cookieStore.get(name))?.value

  if (typeof document === 'undefined')
    return undefined

  const encodedName = `${encodeURIComponent(name)}=`
  const cookie = document.cookie.split('; ').find(cookie => cookie.startsWith(encodedName))
  return cookie ? decodeURIComponent(cookie.slice(encodedName.length)) : undefined
}

export async function getDatafastAttribution() {
  return {
    visitorId: await getCookieValue('datafast_visitor_id'),
    sessionId: await getCookieValue('datafast_session_id'),
  }
}

// Affonso click id, set by the website Worker when a visitor lands from an affiliate link.
export async function getAffonsoReferral() {
  try {
    const referral = await getCookieValue('affonso_referral')
    // Stripe metadata values are capped at 500 characters.
    return referral && referral.length <= 500 ? referral : ''
  }
  catch {
    return ''
  }
}
