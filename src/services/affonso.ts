import { getAffonsoReferral } from '~/services/attributionCookies'
import { invokeCapgoApi } from '~/services/capgoApi'

const SENT_KEY_PREFIX = 'capgo_affonso_signup:'
const FINAL_STATUSES = new Set(['tracked', 'account_too_old'])

function sentKey(userId: string, clickId: string) {
  return `${SENT_KEY_PREFIX}${userId}:${clickId}`
}

function wasSent(key: string) {
  try {
    return localStorage.getItem(key) === '1'
  }
  catch {
    return false
  }
}

function markSent(key: string) {
  try {
    localStorage.setItem(key, '1')
  }
  catch {}
}

/**
 * Records the Affonso affiliate signup from the API, with the user's email, when the
 * visitor arrived through an affiliate link. Replaces the website pixel's
 * Affonso.signup(), which was skipped whenever the pixel loaded late or was blocked.
 * Covers every way to sign up (website form, console, Google, GitHub, SSO).
 */
export async function sendAffonsoSignup(userId: string | undefined) {
  if (!userId)
    return
  const clickId = await getAffonsoReferral()
  if (!clickId)
    return
  const key = sentKey(userId, clickId)
  if (wasSent(key))
    return
  const { data, error } = await invokeCapgoApi<{ status?: string }>('private/affonso_signup', { body: JSON.stringify({ clickId }) })
  if (error) {
    console.warn('Cannot record Affonso signup', error)
    return
  }
  // Only final answers are cached. A missing API key or user profile is retried on a later
  // sign-in, so signups made before the key is configured are still sent.
  if (data?.status && FINAL_STATUSES.has(data.status))
    markSent(key)
}
