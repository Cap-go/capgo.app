import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { quickError } from '../utils/hono.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { getEnv } from '../utils/utils.ts'

// The console never talks to Supabase Auth directly: its auth client sends the
// same GoTrue requests here and this route relays them with the project's anon
// key. Only the user-facing endpoints are reachable; admin and generate-link
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

// Mounted under the console data app, which already applies CORS.
export const app = new Hono<MiddlewareKeyVariables>()

app.all('/*', async (c) => {
  const path = consoleAuthPath(c.req.path)
  if (!path)
    return quickError(404, 'unsupported_auth_endpoint', 'Unsupported auth endpoint')

  const anonKey = getEnv(c, 'SUPABASE_ANON_KEY')
  const upstream = new URL(`${trimTrailingSlashes(getEnv(c, 'SUPABASE_URL'))}/auth/v1/${path}`)
  upstream.search = new URL(c.req.url).search

  const headers = new Headers()
  for (const name of RELAYED_REQUEST_HEADERS) {
    const value = c.req.header(name)
    if (value)
      headers.set(name, value)
  }
  headers.set('apikey', anonKey)
  // A user session when there is one; the anon key is what the SDK sends otherwise.
  headers.set('authorization', c.req.header('authorization') ?? `Bearer ${anonKey}`)
  // Supabase Auth keys rate limits, CAPTCHA verification and audit logging on the
  // caller address. Hand it the browser's address, not ours, through both the
  // header GoTrue has always read and the one it trusts behind proxies when
  // GOTRUE_SECURITY_SB_FORWARDED_FOR_ENABLED is on.
  const clientIp = getClientIP(c)
  if (clientIp !== 'unknown') {
    headers.set('x-forwarded-for', clientIp)
    headers.set('sb-forwarded-for', clientIp)
  }

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
