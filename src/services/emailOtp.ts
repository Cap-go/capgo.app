import type { AuthError, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import dayjs from 'dayjs'
import { invokeCapgoApi } from '~/services/capgoApi'

const EMAIL_OTP_VALIDITY_WINDOW_HOURS = 1
const EMAIL_OTP_RATE_LIMIT_SECONDS_PATTERN = /after\s+(\d+)\s+seconds?/i

export type EmailOtpSendErrorKind = 'rate_limit' | 'captcha' | 'generic'

export interface ParsedEmailOtpSendError {
  kind: EmailOtpSendErrorKind
  waitSeconds?: number
}

export function parseEmailOtpSendError(
  error: Pick<AuthError, 'code' | 'message' | 'status'> | null | undefined,
): ParsedEmailOtpSendError | null {
  if (!error)
    return null

  const message = error.message ?? ''
  const lowerMessage = message.toLowerCase()
  const code = error.code ?? ''

  if (
    code === 'over_email_send_rate_limit'
    || error.status === 429
    || lowerMessage.includes('over_email_send_rate_limit')
  ) {
    const match = message.match(EMAIL_OTP_RATE_LIMIT_SECONDS_PATTERN)
    const waitSeconds = match ? Number.parseInt(match[1], 10) : undefined
    return {
      kind: 'rate_limit',
      waitSeconds: Number.isFinite(waitSeconds) ? waitSeconds : undefined,
    }
  }

  if (code === 'captcha_failed' || lowerMessage.includes('captcha'))
    return { kind: 'captcha' }

  return { kind: 'generic' }
}

export function getEmailOtpSendErrorMessage(
  parsed: ParsedEmailOtpSendError,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  switch (parsed.kind) {
    case 'rate_limit':
      return parsed.waitSeconds
        ? t('email-otp-rate-limit-wait', { seconds: parsed.waitSeconds })
        : t('email-otp-rate-limit-wait-unknown')
    case 'captcha':
      return t('captcha-fail')
    default:
      return t('email-otp-send-failed')
  }
}

export function isRecentEmailOtpVerification(verifiedAt?: string | null) {
  if (!verifiedAt)
    return false

  return dayjs(verifiedAt).isAfter(dayjs().subtract(EMAIL_OTP_VALIDITY_WINDOW_HOURS, 'hour'))
}

export async function getRecentEmailOtpVerification(
  supabase: SupabaseClient<Database>,
  userId: string,
) {
  const { data, error } = await supabase
    .from('user_security')
    .select('email_otp_verified_at')
    .eq('user_id', userId)
    .maybeSingle()

  if (error)
    throw error

  return {
    verifiedAt: data?.email_otp_verified_at ?? null,
    isVerified: isRecentEmailOtpVerification(data?.email_otp_verified_at),
  }
}

export async function sendEmailOtpVerification(
  supabase: SupabaseClient<Database>,
  email: string,
  captchaToken?: string,
  purpose?: 'delete_account' | 'setup_2fa',
) {
  const emailRedirectTo = purpose
    ? new URL(`/?reason=${purpose}`, globalThis.location.origin).href
    : undefined

  return await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      captchaToken: captchaToken || undefined,
      ...(emailRedirectTo ? { emailRedirectTo } : {}),
    },
  })
}

export async function verifyEmailOtp(
  supabase: SupabaseClient<Database>,
  token: string,
) {
  return await invokeCapgoApi('private/verify_email_otp', {
    client: supabase,
    body: { token: token.replaceAll(' ', '') },
  })
}
