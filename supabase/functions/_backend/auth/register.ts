import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { z } from 'zod'
import { Hono } from 'hono/tiny'
import { verifyCaptchaToken } from '../utils/captcha.ts'
import { parseBody, simpleErrorWithStatus, useCors } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { getPasswordPolicyValidationErrors } from '../utils/password_policy.ts'
import { safeParseSchema } from '../utils/schema_validation.ts'
import { emptySupabase, supabaseAdmin } from '../utils/supabase.ts'
import { getEnv } from '../utils/utils.ts'

const DEFAULT_PASSWORD_POLICY = {
  min_length: 6,
  require_uppercase: true,
  require_number: true,
  require_special: true,
}

const registerSchema = z.object({
  email: z.string().trim().pipe(z.email().max(320)),
  password: z.string(),
  first_name: z.string().trim().min(1),
  last_name: z.string().trim().min(1),
  captcha_token: z.string().min(1).optional(),
  registration_device_type: z.string().trim().min(1).optional(),
  registration_os: z.string().trim().min(1).optional(),
  registration_browser: z.string().trim().min(1).optional(),
})

const ACCOUNT_DELETED_MESSAGE = 'Account is in error, please contact support at support@capgo.app'
const EMAIL_EXISTS_MESSAGE = 'User already registered'

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

async function hashEmailSha256(email: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function getCaptchaSecret(c: Parameters<typeof getEnv>[0]) {
  return getEnv(c, 'CAPTCHA_SECRET_KEY') || getEnv(c, 'CLOUDFLARE_TURNSTILE_SECRET_KEY')
}

function isUserAlreadyRegisteredError(err: unknown): boolean {
  const anyErr = err as { message?: string, status?: number }
  const message = String(anyErr?.message ?? '').toLowerCase()
  return anyErr?.status === 422
    || message.includes('already registered')
    || message.includes('user already exists')
}

async function rollbackCreatedUser(c: Parameters<typeof supabaseAdmin>[0], userId: string) {
  const admin = supabaseAdmin(c)
  try {
    await admin.from('users').delete().eq('id', userId)
  }
  catch {}
  try {
    await admin.auth.admin.deleteUser(userId)
  }
  catch {}
}

app.post('/', async (c) => {
  const rawBody = await parseBody<Record<string, unknown>>(c)
  const validationResult = safeParseSchema(registerSchema, rawBody)
  if (!validationResult.success) {
    return simpleErrorWithStatus(c, 400, 'invalid_request', 'Invalid registration request', {
      errors: validationResult.error.message,
    })
  }

  const body = validationResult.data
  const normalizedEmail = body.email.trim().toLowerCase()
  const captchaSecret = getCaptchaSecret(c)

  if (captchaSecret.length > 0) {
    if (!body.captcha_token) {
      return simpleErrorWithStatus(c, 422, 'captcha_failed', 'Captcha verification failed')
    }
    try {
      await verifyCaptchaToken(c, body.captcha_token, captchaSecret)
    }
    catch {
      return simpleErrorWithStatus(c, 422, 'captcha_failed', 'Captcha verification failed')
    }
  }

  const passwordPolicyErrors = getPasswordPolicyValidationErrors(body.password, DEFAULT_PASSWORD_POLICY)
  if (passwordPolicyErrors.length > 0 || !/[a-z]/.test(body.password)) {
    return simpleErrorWithStatus(c, 400, 'invalid_request', 'Invalid registration request', {
      errors: passwordPolicyErrors.length > 0
        ? passwordPolicyErrors
        : ['Password must contain at least one lowercase letter'],
    })
  }

  const admin = supabaseAdmin(c)
  const hashedEmail = await hashEmailSha256(normalizedEmail)
  const { data: notDeleted, error: deletedCheckError } = await admin.rpc('is_not_deleted', {
    email_check: hashedEmail,
  })

  if (deletedCheckError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'auth register is_not_deleted check failed',
      error: serializeError(deletedCheckError),
    })
    return simpleErrorWithStatus(c, 500, 'registration_failed', 'Registration failed')
  }

  if (!notDeleted) {
    return simpleErrorWithStatus(c, 403, 'account_deleted', ACCOUNT_DELETED_MESSAGE)
  }

  const userMetadata: Record<string, string> = {
    first_name: body.first_name,
    last_name: body.last_name,
  }
  if (body.registration_device_type)
    userMetadata.registration_device_type = body.registration_device_type
  if (body.registration_os)
    userMetadata.registration_os = body.registration_os
  if (body.registration_browser)
    userMetadata.registration_browser = body.registration_browser

  const authClient = emptySupabase(c)
  const { data: signupData, error: signupError } = await authClient.auth.signUp({
    email: normalizedEmail,
    password: body.password,
    options: {
      captchaToken: captchaSecret.length > 0 ? body.captcha_token : undefined,
      data: userMetadata,
    },
  })

  if (signupError) {
    cloudlog({
      requestId: c.get('requestId'),
      context: 'auth register signUp failed',
      error: signupError.message,
      status: signupError.status,
    })
    if (isUserAlreadyRegisteredError(signupError)) {
      return simpleErrorWithStatus(c, 409, 'email_exists', EMAIL_EXISTS_MESSAGE)
    }
    return simpleErrorWithStatus(c, 500, 'registration_failed', 'Registration failed')
  }

  const userId = signupData.user?.id
  const accessToken = signupData.session?.access_token
  const refreshToken = signupData.session?.refresh_token

  if (!userId || !accessToken || !refreshToken) {
    cloudlog({
      requestId: c.get('requestId'),
      context: 'auth register missing session after signUp',
      userId,
      hasAccessToken: Boolean(accessToken),
      hasRefreshToken: Boolean(refreshToken),
    })
    if (userId)
      await rollbackCreatedUser(c, userId)
    return simpleErrorWithStatus(c, 500, 'registration_failed', 'Registration failed')
  }

  const { error: profileError } = await admin.from('users').upsert({
    id: userId,
    email: normalizedEmail,
    first_name: body.first_name,
    last_name: body.last_name,
    enable_notifications: true,
    opt_for_newsletters: true,
  }, { onConflict: 'id' })

  if (profileError) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'auth register users upsert failed',
      error: serializeError(profileError),
    })
    await rollbackCreatedUser(c, userId)
    return simpleErrorWithStatus(c, 500, 'registration_failed', 'Registration failed')
  }

  return c.json({
    user: { id: userId },
    session: {
      access_token: accessToken,
      refresh_token: refreshToken,
    },
  })
})
