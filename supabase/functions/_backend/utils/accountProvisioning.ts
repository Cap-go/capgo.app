import type { Context } from 'hono'
import type { PgClient } from './pg.ts'
import { closeClient, getPgClient } from './pg.ts'
import { getEnv } from './utils.ts'

// Keeps the `{ data, error }` result supabase-js gave callers, so their error branches stay unchanged.
async function adminQuery<T>(c: Context, run: (pg: PgClient) => Promise<T>): Promise<{ data: T | null, error: unknown }> {
  let pg: PgClient | null = null
  try {
    pg = await getPgClient(c)
    return { data: await run(pg), error: null }
  }
  catch (error) {
    return { data: null, error }
  }
  finally {
    if (pg)
      closeClient(c, pg)
  }
}

export function getCaptchaSecret(c: Context) {
  return getEnv(c, 'CAPTCHA_SECRET_KEY') || getEnv(c, 'CLOUDFLARE_TURNSTILE_SECRET_KEY')
}

export async function hashEmailSha256(email: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function checkRegistrationEmail(c: Context, email: string) {
  const emailHash = await hashEmailSha256(email)
  return adminQuery(c, async (pg) => {
    const result = await pg.query<{ not_deleted: boolean }>('SELECT public.is_not_deleted(email_check => $1::varchar) AS not_deleted', [emailHash])
    return result.rows[0]?.not_deleted ?? null
  })
}

export function isCaptchaFailedError(error: unknown) {
  const err = error as { code?: string, message?: string }
  return err?.code === 'captcha_failed' || String(err?.message ?? '').toLowerCase().includes('captcha')
}

export function isAuthRateLimitError(error: unknown) {
  const err = error as { code?: string, message?: string, status?: number }
  return err?.status === 429 || ['over_request_rate_limit', 'over_email_send_rate_limit'].includes(err?.code ?? '')
    || String(err?.message ?? '').toLowerCase().includes('rate limit')
}

// GoTrue rejects passwords found in breach lists (HaveIBeenPwned) with weak_password even when they pass our own policy.
export function isWeakPasswordError(error: unknown) {
  const err = error as { code?: string, message?: string }
  return err?.code === 'weak_password' || String(err?.message ?? '').toLowerCase().includes('known to be weak')
}

export function isLeakedPasswordError(error: unknown) {
  const err = error as { message?: string, reasons?: unknown }
  return (Array.isArray(err?.reasons) && err.reasons.includes('pwned')) || String(err?.message ?? '').toLowerCase().includes('known to be weak')
}

export interface ProfileInput {
  id: string
  email: string
  first_name: string
  last_name: string
  opt_for_newsletters?: boolean
}

// Insert the real profile so on_user_create runs exactly once.
export function provisionUserProfile(c: Context, profile: ProfileInput) {
  return adminQuery(c, async (pg) => {
    await pg.query(
      `INSERT INTO public.users (id, email, first_name, last_name, enable_notifications, opt_for_newsletters)
       VALUES ($1, $2, $3, $4, true, $5)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         enable_notifications = EXCLUDED.enable_notifications,
         opt_for_newsletters = EXCLUDED.opt_for_newsletters`,
      [profile.id, profile.email, profile.first_name, profile.last_name, profile.opt_for_newsletters ?? false],
    )
  })
}

export function deleteUserProfile(c: Context, userId: string) {
  return adminQuery(c, async (pg) => {
    await pg.query('DELETE FROM public.users WHERE id = $1', [userId])
  })
}
