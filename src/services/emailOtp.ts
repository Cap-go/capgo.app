import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import dayjs from 'dayjs'
import { invokeCapgoApi } from '~/services/capgoApi'

const EMAIL_OTP_VALIDITY_WINDOW_HOURS = 1

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
) {
  return await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      captchaToken: captchaToken || undefined,
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
