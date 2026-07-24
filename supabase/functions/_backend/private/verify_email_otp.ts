import { z } from 'zod'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { createHono, parseBody, quickError, simpleError, simpleRateLimit, useCors } from '../utils/hono.ts'
import { getClaimsFromJWT, middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { clearFailedAccountAuth, isAccountRateLimited, recordFailedAccountAuth } from '../utils/rate_limit.ts'
import { buildRateLimitInfo } from '../utils/rateLimitInfo.ts'
import { emptySupabase, supabaseAdmin } from '../utils/supabase.ts'
import { version } from '../utils/version.ts'

const bodySchema = z.object({
  token: z.string().optional(),
  token_hash: z.string().optional(),
  type: z.enum(['email', 'magiclink']).optional(),
})

export const app = createHono('', version)

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const rawBody = await parseBody<{ token?: string, token_hash?: string, type?: 'email' | 'magiclink' }>(c)
  const token = rawBody.token?.replaceAll(' ', '') ?? ''
  const tokenHash = rawBody.token_hash?.trim() ?? ''

  const validationPayload: { token: string, token_hash: string, type?: 'email' | 'magiclink' } = {
    token,
    token_hash: tokenHash,
  }
  if (rawBody.type !== undefined) {
    validationPayload.type = rawBody.type
  }

  const validation = safeParseSchema(bodySchema, validationPayload)
  if (!validation.success) {
    throw simpleError('invalid_body', 'Invalid request body', { errors: validation.error.message })
  }
  const otpType = validation.data.type ?? 'email'
  if (!token && !tokenHash) {
    throw simpleError('invalid_body', 'Token or token_hash is required')
  }
  if (token && tokenHash) {
    throw simpleError('invalid_body', 'Provide token or token_hash, not both')
  }
  if (token && token.length !== 6) {
    throw simpleError('invalid_body', 'Token must be 6 characters long')
  }

  const auth = c.get('auth')
  if (!auth?.userId) {
    return quickError(401, 'not_authenticated', 'Not authenticated')
  }
  if (auth.authType !== 'jwt') {
    return quickError(401, 'invalid_auth_type', 'JWT authentication required')
  }

  const accountRateLimitStatus = await isAccountRateLimited(c, auth.userId)
  if (accountRateLimitStatus.limited) {
    return simpleRateLimit({ reason: 'too_many_failed_account_auth_attempts', ...buildRateLimitInfo(accountRateLimitStatus.resetAt) })
  }

  const authorization = c.get('authorization')
  if (!authorization) {
    return quickError(401, 'no_authorization', 'No authorization header provided')
  }

  const claims = await getClaimsFromJWT(c, authorization)
  const email = claims?.email
  if (!email && token) {
    return quickError(400, 'missing_email', 'Email is required to verify OTP')
  }

  const supabase = emptySupabase(c)
  let verifyData: Awaited<ReturnType<typeof supabase.auth.verifyOtp>>['data']
  let verifyError: Awaited<ReturnType<typeof supabase.auth.verifyOtp>>['error']
  if (tokenHash) {
    ({ data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: otpType,
    }))
  }
  else {
    if (!email) {
      return quickError(400, 'missing_email', 'Email is required to verify OTP')
    }
    ({ data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token,
      type: otpType,
    }))
  }

  if (verifyError || !verifyData?.session?.access_token) {
    await recordFailedAccountAuth(c, auth.userId)
    cloudlog({ requestId: c.get('requestId'), context: 'verify_email_otp - verifyOtp failed', error: verifyError?.message })
    return quickError(401, 'invalid_otp', 'Invalid or expired OTP')
  }

  if (verifyData.user?.id && verifyData.user.id !== auth.userId) {
    await recordFailedAccountAuth(c, auth.userId)
    return quickError(403, 'otp_user_mismatch', 'OTP does not match current user')
  }
  if (!verifyData.user?.id) {
    await recordFailedAccountAuth(c, auth.userId)
    return quickError(500, 'no_user', 'No user associated with OTP')
  }

  await clearFailedAccountAuth(c, auth.userId)

  const otpVerifiedAt = new Date().toISOString()
  const { error: recordError } = await supabaseAdmin(c).rpc('record_email_otp_verified', {
    p_user_id: verifyData.user.id,
  })

  if (recordError) {
    cloudlog({ requestId: c.get('requestId'), context: 'verify_email_otp - record failed', error: recordError?.message })
    return quickError(500, 'record_failed', 'Failed to record OTP verification')
  }

  return c.json({ verified_at: otpVerifiedAt })
})
