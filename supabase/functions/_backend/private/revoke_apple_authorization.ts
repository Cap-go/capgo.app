import { z } from 'zod'
import { isAppleSignInConfigured, revokeAppleAuthorization } from '../utils/appleSignIn.ts'
import { BRES, createHono, parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { supabaseClient } from '../utils/supabase.ts'
import { version } from '../utils/version.ts'

export const app = createHono('', version)
const bodySchema = z.object({ code: z.string().min(1).max(4096), client: z.enum(['native', 'web']).optional() })
app.use('/', useCors)
app.post('/', middlewareAuth, async (c) => {
  const auth = c.get('auth')
  const authorization = c.get('authorization')
  if (!auth?.userId || auth.authType !== 'jwt' || !authorization)
    return quickError(401, 'not_authenticated', 'JWT authentication required')
  if (!isAppleSignInConfigured(c))
    return quickError(503, 'apple_login_unavailable', 'Apple login is not configured')
  const body = safeParseSchema(bodySchema, await parseBody(c))
  if (!body.success)
    return quickError(400, 'invalid_body', 'An Apple authorization code is required')

  const client = supabaseClient(c, authorization)
  const { data: { user }, error } = await client.auth.getUser(authorization.replace(/^Bearer /i, ''))
  if (error || !user || user.id !== auth.userId)
    return quickError(401, 'not_authenticated', 'Authentication required')
  const appleIdentity = user.identities?.find(identity => identity.provider === 'apple')
  const subject = appleIdentity?.identity_data?.sub
  if (typeof subject !== 'string' || !subject)
    return quickError(403, 'apple_identity_required', 'An Apple identity is required')
  if (user.factors?.some(factor => factor.status === 'verified') && auth.claims?.aal !== 'aal2')
    return quickError(403, 'mfa_required', 'Complete two-factor authentication first')
  // Require Apple sign-in within five minutes; later MFA must not extend this window.
  const lastSignIn = Date.parse(user.last_sign_in_at ?? '')
  if (!Number.isFinite(lastSignIn) || Date.now() - lastSignIn > 5 * 60_000)
    return quickError(403, 'reauth_required', 'Sign in again before deleting your account')
  const verified = await client.from('user_security').select('email_otp_verified_at').eq('user_id', user.id).maybeSingle()
  const verifiedAt = Date.parse(verified.data?.email_otp_verified_at ?? '')
  if (verified.error || !Number.isFinite(verifiedAt) || verifiedAt <= Date.now() - 60 * 60_000)
    return quickError(403, 'email_not_verified', 'Verify your email before deleting your account')

  try {
    await revokeAppleAuthorization(c, body.data.code, subject, body.data.client === 'web')
  }
  catch {
    return quickError(502, 'apple_revocation_failed', 'Could not revoke Apple authorization. Please try again')
  }
  return c.json(BRES)
})
