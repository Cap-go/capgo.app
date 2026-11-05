import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { quickError } from '../utils/hono.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'

// The console never talks to Supabase Auth directly: its auth client sends the
// same GoTrue requests here and this route relays them (see relayAuth for the
// credentials). Only the user-facing endpoints are reachable; admin and generate-link
// endpoints are not, so this is never more than what the browser could already do.
const ALLOWED_PATHS = [
  /^token$/,
  /^signup$/,
  /^logout$/,
  /^user$/,
  /^otp$/,
  /^verify$/,
  /^resend$/,
  /^recover$/,
  /^reauthenticate$/,
  /^sso$/,
  /^factors$/,
  /^factors\/[\w-]+$/,
  /^factors\/[\w-]+\/(?:challenge|verify)$/,
]

const MAX_BODY_BYTES = 64 * 1024
// A signed session or anon token. Anything else (no header, `Bearer sb_...`) makes
// the Supabase gateway substitute the role of the apikey header.
const JWT_BEARER = /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/
const MOUNT = '/console/auth/'

// Browser headers worth relaying; everything else (cookies, host, origin) stays here.
const RELAYED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'user-agent', 'x-client-info', 'x-supabase-api-version']
const RELAYED_RESPONSE_HEADERS = ['content-type', 'location', 'x-sb-error-code', 'retry-after']

function trimTrailingSlashes(value: string) {
  let end = value.length
  while (end > 0 && value[end - 1] === '/')
    end--
  return value.slice(0, end)
}

export function consoleAuthPath(requestPath: string): string | null {
  const index = requestPath.indexOf(MOUNT)
  if (index < 0)
    return null
  const path = trimTrailingSlashes(requestPath.slice(index + MOUNT.length))
  return ALLOWED_PATHS.some(pattern => pattern.test(path)) ? path : null
}

// GoTrue routes behind its CAPTCHA gate (internal/api/api.go, isIgnoreCaptchaRoute).
const CAPTCHA_PATHS = new Set(['signup', 'recover', 'resend', 'otp', 'sso'])
const CAPTCHA_FREE_GRANTS = new Set(['pkce', 'refresh_token', 'id_token'])
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export function requiresCaptcha(path: string, method: string, search: URLSearchParams) {
  if (method !== 'POST')
    return false
  if (path === 'token')
    return !CAPTCHA_FREE_GRANTS.has(search.get('grant_type') ?? '')
  return CAPTCHA_PATHS.has(path)
}

// Supabase Auth keys rate limits, CAPTCHA verification and audit logging on the
// caller address, so every console user would otherwise share this worker's
// egress IPs and one client could exhaust the auth limits for all of them.
// Hosted Supabase only honours Sb-Forwarded-For on requests made with a secret
// API key (and IP forwarding enabled under Authentication > Rate Limits).
// Without a user session that key makes the request service_role, and GoTrue
// skips its CAPTCHA for admin callers, so the relay verifies Turnstile itself
// on those routes before relaying. Supabase's own CAPTCHA must stay enabled:
// it still guards anyone calling Auth directly with the publishable key.
interface RelayAuth {
  headers: Record<string, string>
  // Set when the relay itself must verify Turnstile before relaying.
  captcha?: { secret: string, clientIp: string }
}

function relayAuth(c: Context<MiddlewareKeyVariables>): RelayAuth {
  const anonKey = getEnv(c, 'SUPABASE_ANON_KEY')
  const sessionHeader = c.req.header('authorization') ?? ''
  const secretKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  const captchaSecret = getEnv(c, 'CAPTCHA_SECRET_KEY') || getEnv(c, 'CLOUDFLARE_TURNSTILE_SECRET_KEY')
  // Only Cloudflare's own header: it cannot be set by the client, x-forwarded-for can.
  const cfClientIp = c.req.header('cf-connecting-ip')

  if (cfClientIp && secretKey.startsWith('sb_secret_') && captchaSecret) {
    const session = JWT_BEARER.test(sessionHeader) ? sessionHeader : null
    return {
      headers: {
        'apikey': secretKey,
        // A user session keeps the caller identity (and GoTrue's own CAPTCHA);
        // anything else is dropped so the gateway never sees a client-chosen bearer.
        ...(session ? { authorization: session } : {}),
        // Supabase answers 401 to secret-key requests carrying a browser User-Agent.
        'user-agent': 'capgo-console-auth-relay',
        'x-forwarded-for': cfClientIp,
        'sb-forwarded-for': cfClientIp,
      },
      captcha: session ? undefined : { secret: captchaSecret, clientIp: cfClientIp },
    }
  }

  // Relay with the publishable key exactly as the browser would; GoTrue checks the CAPTCHA.
  const clientIp = getClientIP(c)
  return {
    headers: {
      'apikey': anonKey,
      'authorization': sessionHeader || `Bearer ${anonKey}`,
      ...(clientIp === 'unknown' ? {} : { 'x-forwarded-for': clientIp, 'sb-forwarded-for': clientIp }),
    },
  }
}

function captchaToken(body: ArrayBuffer | undefined): string {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body))
    const token = parsed?.gotrue_meta_security?.captcha_token
    return typeof token === 'string' ? token.trim() : ''
  }
  catch {
    return ''
  }
}

// Same response GoTrue gives, so the console's auth client surfaces it unchanged.
function captchaFailed(reason: string) {
  return Response.json(
    { code: 400, error_code: 'captcha_failed', msg: `captcha protection: request disallowed (${reason})` },
    { status: 400, headers: { 'x-sb-error-code': 'captcha_failed', 'cache-control': 'no-store' } },
  )
}

async function verifyTurnstile(captcha: NonNullable<RelayAuth['captcha']>, token: string) {
  const form = new FormData()
  form.set('secret', captcha.secret)
  form.set('response', token)
  form.set('remoteip', captcha.clientIp)
  const response = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
  if (!response.ok)
    throw new Error(`turnstile siteverify returned ${response.status}`)
  const result = await response.json() as { 'success'?: boolean, 'error-codes'?: string[] }
  return { success: result.success === true, errorCodes: result['error-codes'] ?? [] }
}

// Mounted under the console data app, which already applies CORS.
export const app = new Hono<MiddlewareKeyVariables>()

app.all('/*', async (c) => {
  const path = consoleAuthPath(c.req.path)
  if (!path)
    return quickError(404, 'unsupported_auth_endpoint', 'Unsupported auth endpoint')

  const upstream = new URL(`${trimTrailingSlashes(getEnv(c, 'SUPABASE_URL'))}/auth/v1/${path}`)
  upstream.search = new URL(c.req.url).search

  const headers = new Headers()
  for (const name of RELAYED_REQUEST_HEADERS) {
    const value = c.req.header(name)
    if (value)
      headers.set(name, value)
  }
  const auth = relayAuth(c)
  for (const [name, value] of Object.entries(auth.headers))
    headers.set(name, value)

  let body: ArrayBuffer | undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    // Refuse declared oversize bodies before buffering anything; the read below bounds the rest.
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES)
      return quickError(413, 'auth_request_too_large', 'Auth request too large')
    body = await c.req.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES)
      return quickError(413, 'auth_request_too_large', 'Auth request too large')
  }

  if (auth.captcha && requiresCaptcha(path, c.req.method, upstream.searchParams)) {
    const token = captchaToken(body)
    if (!token)
      return captchaFailed('no captcha_token found')
    const result = await verifyTurnstile(auth.captcha, token)
    if (!result.success)
      return captchaFailed(result.errorCodes.join(', ') || 'invalid captcha_token')
  }

  const response = await fetch(upstream, { method: c.req.method, headers, body, redirect: 'manual' })
  const responseHeaders = new Headers()
  for (const name of RELAYED_RESPONSE_HEADERS) {
    const value = response.headers.get(name)
    if (value)
      responseHeaders.set(name, value)
  }
  responseHeaders.set('cache-control', 'no-store')
  return new Response(response.body, { status: response.status, headers: responseHeaders })
})
