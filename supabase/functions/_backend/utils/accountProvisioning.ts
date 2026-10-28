import type { Context } from 'hono'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

export function getCaptchaSecret(c: Context) {
  return getEnv(c, 'CAPTCHA_SECRET_KEY') || getEnv(c, 'CLOUDFLARE_TURNSTILE_SECRET_KEY')
}

export async function hashEmailSha256(email: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email.trim().toLowerCase()))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function checkRegistrationEmail(c: Context, email: string) {
  return supabaseAdmin(c).rpc('is_not_deleted', { email_check: await hashEmailSha256(email) })
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
  return supabaseAdmin(c).from('users').upsert({
    ...profile,
    enable_notifications: true,
    opt_for_newsletters: profile.opt_for_newsletters ?? false,
  }, { onConflict: 'id' })
}
