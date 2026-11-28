import type { Context } from 'hono'
import { cloudlog, cloudlogErr } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'
import { queryJsonOne } from './pg_rls.ts'
import { backgroundTask, getEnv } from './utils.ts'

// Affonso affiliate signups are recorded server-side, not by Affonso's browser pixel.
// The website Worker records the affiliate click and stores its id in the
// `affonso_referral` cookie; this sends the signup with the user's email and name, so
// the referral and its commissions show who the customer is.

export const AFFONSO_API_URL = 'https://api.affonso.io/v1'
const REQUEST_TIMEOUT_MS = 10_000
const CLICK_ID = /^[\w-]{1,200}$/
// Same as the affiliate cookie lifetime: older accounts were not referred by this click.
export const AFFONSO_SIGNUP_MAX_ACCOUNT_AGE_DAYS = 30

interface AffonsoUser {
  email: string
  first_name: string | null
  last_name: string | null
  created_at: string | null
}

export type AffonsoSignupResult = 'tracked' | 'no_api_key' | 'invalid_click' | 'no_user' | 'account_too_old'

export function isAffonsoClickId(value: unknown): value is string {
  return typeof value === 'string' && CLICK_ID.test(value)
}

export async function postBearerJson(url: string, apiKey: string, body: Record<string, unknown>) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  if (!response.ok)
    throw new Error(`${url} responded ${response.status}: ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) as Record<string, any> : {}
}

async function getAffonsoUser(c: Context, userId: string) {
  const pg = await getPgClient(c)
  try {
    return await queryJsonOne<AffonsoUser>(pg, 'SELECT email, first_name, last_name, created_at FROM public.users WHERE id = $1', [userId])
  }
  finally {
    closeClient(c, pg)
  }
}

function isAccountTooOld(createdAt: string | null, now: number) {
  if (!createdAt)
    return false
  const created = Date.parse(createdAt)
  return Number.isFinite(created) && now - created > AFFONSO_SIGNUP_MAX_ACCOUNT_AGE_DAYS * 24 * 60 * 60 * 1000
}

/**
 * Turns the affiliate click into an Affonso lead with the user's email and name.
 * Affonso keys signups on the click id, so repeating it returns the existing referral.
 */
export async function trackAffonsoSignup(
  c: Context,
  clickId: unknown,
  userId: string,
  options: { requireRecentAccount?: boolean, now?: number } = {},
): Promise<AffonsoSignupResult> {
  const apiKey = getEnv(c, 'AFFONSO_API_KEY')
  if (!apiKey)
    return 'no_api_key'
  if (!isAffonsoClickId(clickId))
    return 'invalid_click'
  const user = await getAffonsoUser(c, userId)
  if (!user?.email)
    return 'no_user'
  if (options.requireRecentAccount && isAccountTooOld(user.created_at, options.now ?? Date.now()))
    return 'account_too_old'

  const name = [user.first_name, user.last_name].map(part => part?.trim()).filter(Boolean).join(' ').slice(0, 255)
  const result = await postBearerJson(`${AFFONSO_API_URL}/signups`, apiKey, {
    click_id: clickId,
    email: user.email,
    external_user_id: userId,
    ...(name ? { name } : {}),
  })
  cloudlog({ requestId: c.get('requestId'), message: 'Affonso signup tracked', clickId, userId, status: result?.data?.status })
  return 'tracked'
}

/**
 * Checkout safety net: whoever buys with an affiliate cookie gets their email on the
 * referral, even if the console never sent the signup. Never delays or fails checkout.
 */
export function scheduleAffonsoSignup(c: Context, clickId: unknown) {
  const userId = c.get('auth')?.userId
  if (!userId || !isAffonsoClickId(clickId) || !getEnv(c, 'AFFONSO_API_KEY'))
    return
  backgroundTask(c, trackAffonsoSignup(c, clickId, userId).catch((error) => {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Affonso signup tracking failed', clickId, userId, error })
  }))
}
