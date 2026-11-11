import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { z } from 'zod'
import { parseBody, quickError, simpleRateLimit, useCors } from '../utils/hono.ts'
import { buildRateLimitInfo } from '../utils/rateLimitInfo.ts'
import { cloudlog } from '../utils/logging.ts'
import {
  getClientIP,
  isCaptchaFallbackEmailRateLimited,
  isCaptchaFallbackIpRateLimited,
  normalizeRateLimitAccountIdentifier,
  recordCaptchaFallbackRequest,
} from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'
import { isEmailDomainSsoEnforced } from './sso/domain-enforcement.ts'

const BRES = { status: 'ok' as const }

const bodySchema = z.object({
  email: z.string().email().max(320),
  purpose: z.enum(['magic_link', 'recover', 'resend_signup']),
  redirect_to: z.string().url().max(2048).optional(),
})

function trimTrailingSlashes(value: string) {
  let end = value.length
  while (end > 0 && value[end - 1] === '/')
    end--
  return value.slice(0, end)
}

function consoleOriginAllowed(c: Context<MiddlewareKeyVariables>, origin: string | undefined): boolean {
  if (!origin)
    return false
  try {
    const requestOrigin = new URL(origin).origin
    const allowed = new Set<string>()
    const webapp = getEnv(c, 'WEBAPP_URL')
    if (webapp) {
      try {
        allowed.add(new URL(webapp).origin)
      }
      catch {
        // ignore invalid WEBAPP_URL
      }
    }
    for (const extra of getEnv(c, 'CAPTCHA_FALLBACK_ALLOWED_ORIGINS').split(',')) {
      const trimmed = extra.trim()
      if (!trimmed)
        continue
      try {
        allowed.add(new URL(trimmed).origin)
      }
      catch {
        // ignore invalid configured origin
      }
    }
    if (allowed.size === 0)
      return false
    return allowed.has(requestOrigin)
  }
  catch {
    return false
  }
}

function resolveRecoverRedirectTo(c: Context<MiddlewareKeyVariables>, redirectTo?: string): string | undefined {
  const webapp = getEnv(c, 'WEBAPP_URL').trim()
  if (!webapp)
    return undefined

  let webappOrigin: string
  try {
    webappOrigin = new URL(webapp).origin
  }
  catch {
    return undefined
  }

  const defaultRedirect = `${trimTrailingSlashes(webapp)}/forgot_password?step=2`
  if (!redirectTo)
    return defaultRedirect

  try {
    const candidate = new URL(redirectTo)
    if (candidate.origin !== webappOrigin)
      return defaultRedirect
    return candidate.href
  }
  catch {
    return defaultRedirect
  }
}

async function relayCaptchaFallbackAuth(
  c: Context<MiddlewareKeyVariables>,
  purpose: z.infer<typeof bodySchema>['purpose'],
  email: string,
  redirectTo?: string,
) {
  const secretKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  if (!secretKey.startsWith('sb_secret_'))
    throw new Error('captcha_fallback_requires_secret_key')

  const cfClientIp = c.req.header('cf-connecting-ip') ?? getClientIP(c)
  const headers: Record<string, string> = {
    apikey: secretKey,
    'content-type': 'application/json',
    'user-agent': 'capgo-console-captcha-fallback',
  }
  if (cfClientIp !== 'unknown') {
    headers['x-forwarded-for'] = cfClientIp
    headers['sb-forwarded-for'] = cfClientIp
  }

  const base = `${trimTrailingSlashes(getEnv(c, 'SUPABASE_URL'))}/auth/v1`
  if (purpose === 'magic_link') {
    return await fetch(`${base}/otp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, create_user: false, data: {} }),
    })
  }
  if (purpose === 'recover') {
    const upstream = new URL(`${base}/recover`)
    const safeRedirect = resolveRecoverRedirectTo(c, redirectTo)
    if (safeRedirect)
      upstream.searchParams.set('redirect_to', safeRedirect)
    return await fetch(upstream, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email }),
    })
  }
  return await fetch(`${base}/resend`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, type: 'signup' }),
  })
}

export const app = new Hono<MiddlewareKeyVariables>()
app.use('*', useCors)

app.post('/', async (c) => {
  const captchaSecret = getEnv(c, 'CAPTCHA_SECRET_KEY') || getEnv(c, 'CLOUDFLARE_TURNSTILE_SECRET_KEY')
  if (!captchaSecret)
    return quickError(503, 'captcha_fallback_disabled', 'Captcha fallback is not enabled')

  if (!consoleOriginAllowed(c, c.req.header('origin')))
    return quickError(403, 'origin_not_allowed', 'Origin is not allowed')

  const parsed = bodySchema.safeParse(await parseBody(c))
  if (!parsed.success)
    return quickError(400, 'invalid_body', 'Invalid request body')

  const email = normalizeRateLimitAccountIdentifier(parsed.data.email)
  const ipLimit = await isCaptchaFallbackIpRateLimited(c)
  if (ipLimit.limited)
    return simpleRateLimit({ reason: 'captcha_fallback_ip_rate_limit', ...buildRateLimitInfo(ipLimit.resetAt) })

  const emailLimit = await isCaptchaFallbackEmailRateLimited(c, email)
  if (emailLimit.limited)
    return simpleRateLimit({ reason: 'captcha_fallback_email_rate_limit', ...buildRateLimitInfo(emailLimit.resetAt) })

  if (parsed.data.purpose === 'magic_link') {
    try {
      if (await isEmailDomainSsoEnforced(c, email))
        return quickError(403, 'sso_enforced', 'SSO is required for this email domain')
    }
    catch (error) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'captcha fallback SSO enforcement check failed',
        error,
      })
      return quickError(500, 'query_error', 'Failed to check domain')
    }
  }

  // Count admitted attempts before relay so quota exhaustion cannot reveal account existence.
  await recordCaptchaFallbackRequest(c, email)

  let response: Response
  try {
    response = await relayCaptchaFallbackAuth(c, parsed.data.purpose, email, parsed.data.redirect_to)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'captcha fallback auth relay error',
      purpose: parsed.data.purpose,
      error,
    })
    return quickError(502, 'captcha_fallback_failed', 'Unable to send email')
  }

  if (!response.ok) {
    if (response.status === 429)
      return simpleRateLimit({ reason: 'captcha_fallback_upstream_rate_limit', ...buildRateLimitInfo(Date.now() + 3_600_000) })
    if (response.status === 401 || response.status === 403)
      return quickError(503, 'captcha_fallback_failed', 'Unable to send email')
    if (response.status >= 500)
      return quickError(502, 'captcha_fallback_failed', 'Unable to send email')
    cloudlog({
      requestId: c.get('requestId'),
      message: 'captcha fallback auth relay failed',
      purpose: parsed.data.purpose,
      status: response.status,
    })
  }

  // Same shape for unknown emails so this is not an existence oracle.
  return c.json(BRES)
})
