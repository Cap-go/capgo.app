import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { quickError } from '../utils/hono.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'

// The console never talks to Supabase Auth directly: its auth client sends the
// same GoTrue requests here and this route relays them with anon-level
// credentials (see setAuthHeaders). Only the user-facing endpoints are reachable; admin and generate-link
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

// Supabase Auth keys rate limits, CAPTCHA verification and audit logging on the
// caller address, so every console user would otherwise share this worker's
// egress IPs and one client could exhaust the auth limits for all of them.
// Hosted Supabase only honours Sb-Forwarded-For on requests made with a secret
// API key (and IP forwarding enabled under Authentication > Rate Limits).
// A secret apikey alone resolves to service_role, which also skips GoTrue's
// CAPTCHA check, so Authorization must always carry a signed non-admin token:
// the user's session, or a short-lived anon JWT minted here for signed-out
// requests with SUPABASE_JWT_SIGNING_KEY, the private JWK of the project's
// current signing key (imported into Supabase > JWT Signing Keys).
// Without that key or a Cloudflare client address, keep relaying with the
// publishable key exactly as the browser would.
async function setAuthHeaders(c: Context<MiddlewareKeyVariables>, headers: Headers) {
  const anonKey = getEnv(c, 'SUPABASE_ANON_KEY')
  const sessionHeader = c.req.header('authorization') ?? ''
  const session = JWT_BEARER.test(sessionHeader) ? sessionHeader : null
  const secretKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  // Only Cloudflare's own header: it cannot be set by the client, x-forwarded-for can.
  const cfClientIp = c.req.header('cf-connecting-ip')

  if (cfClientIp && secretKey.startsWith('sb_secret_')) {
    const authorization = session ?? await mintAnonBearer(getEnv(c, 'SUPABASE_JWT_SIGNING_KEY'))
    if (authorization) {
      headers.set('apikey', secretKey)
      headers.set('authorization', authorization)
      // Supabase answers 401 to secret-key requests carrying a browser User-Agent.
      headers.set('user-agent', 'capgo-console-auth-relay')
      headers.set('x-forwarded-for', cfClientIp)
      headers.set('sb-forwarded-for', cfClientIp)
      return
    }
  }

  headers.set('apikey', anonKey)
  // A user session when there is one; the anon key is what the SDK sends otherwise.
  headers.set('authorization', sessionHeader || `Bearer ${anonKey}`)
  const clientIp = getClientIP(c)
  if (clientIp !== 'unknown') {
    headers.set('x-forwarded-for', clientIp)
    headers.set('sb-forwarded-for', clientIp)
  }
}

const ANON_JWT_TTL_SECONDS = 120
const ANON_JWT_REUSE_MARGIN_SECONDS = 30
let signer: { jwkJson: string, kid: string, key: Promise<CryptoKey> } | null = null
let cachedAnonBearer: { jwkJson: string, value: string, exp: number } | null = null

function base64url(bytes: Uint8Array) {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function encodeSegment(value: object) {
  return base64url(new TextEncoder().encode(JSON.stringify(value)))
}

function getSigner(jwkJson: string) {
  if (signer?.jwkJson === jwkJson)
    return signer
  let jwk: JsonWebKey & { kid?: unknown }
  try {
    jwk = JSON.parse(jwkJson)
  }
  catch {
    return null
  }
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || typeof jwk.kid !== 'string' || !jwk.kid)
    return null
  const key = crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  signer = { jwkJson, kid: jwk.kid, key }
  return signer
}

// ES256 `role: anon` token, the same claims Supabase puts in its own anon tokens.
export async function mintAnonBearer(jwkJson: string): Promise<string | null> {
  if (!jwkJson)
    return null
  const now = Math.floor(Date.now() / 1000)
  if (cachedAnonBearer?.jwkJson === jwkJson && cachedAnonBearer.exp - now > ANON_JWT_REUSE_MARGIN_SECONDS)
    return cachedAnonBearer.value
  const current = getSigner(jwkJson)
  if (!current)
    return null
  try {
    const exp = now + ANON_JWT_TTL_SECONDS
    const unsigned = `${encodeSegment({ alg: 'ES256', typ: 'JWT', kid: current.kid })}.${encodeSegment({ iss: 'supabase', role: 'anon', iat: now, exp })}`
    // WebCrypto ECDSA signatures are raw r||s, which is what JWS ES256 expects.
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await current.key, new TextEncoder().encode(unsigned))
    const value = `Bearer ${unsigned}.${base64url(new Uint8Array(signature))}`
    cachedAnonBearer = { jwkJson, value, exp }
    return value
  }
  catch {
    signer = null
    return null
  }
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
  await setAuthHeaders(c, headers)

  let body: ArrayBuffer | undefined
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    // Refuse declared oversize bodies before buffering anything; the read below bounds the rest.
    if (Number(c.req.header('content-length') ?? 0) > MAX_BODY_BYTES)
      return quickError(413, 'auth_request_too_large', 'Auth request too large')
    body = await c.req.arrayBuffer()
    if (body.byteLength > MAX_BODY_BYTES)
      return quickError(413, 'auth_request_too_large', 'Auth request too large')
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
