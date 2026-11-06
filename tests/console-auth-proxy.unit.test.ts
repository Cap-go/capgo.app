import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, consoleAuthPath, requiresCaptcha } from '../supabase/functions/_backend/private/console_auth_proxy'

const fetchMock = vi.fn()
const BASE_ENV: Record<string, string> = { SUPABASE_URL: 'https://auth.example.co/', SUPABASE_ANON_KEY: 'anon-key' }
const FORWARDING_ENV = { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', CAPTCHA_SECRET_KEY: 'turnstile-secret' }
const USER_JWT = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
let env = BASE_ENV
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  quickError: (status: number, error: string) => Response.json({ error }, { status }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => env[key] ?? '',
}))

beforeEach(() => {
  env = BASE_ENV
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{"access_token":"t"}', { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'leak=1' } }))
})
afterEach(() => vi.unstubAllGlobals())

describe('console auth relay', () => {
  it('relays allowed endpoints with the anon key and the browser address', async () => {
    const response = await app.request('https://api.example.com/private/console/auth/token?grant_type=password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', 'cookie': 'session=secret', 'x-client-info': 'capgo-console' },
      body: JSON.stringify({ email: 'a', password: 'b' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ access_token: 't' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')

    const [url, init] = fetchMock.mock.calls[0]
    expect(url.href).toBe('https://auth.example.co/auth/v1/token?grant_type=password')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    expect(headers.get('apikey')).toBe('anon-key')
    expect(headers.get('authorization')).toBe('Bearer anon-key')
    // Supabase Auth rate limits, CAPTCHA checks and audit logs key on these.
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(headers.get('sb-forwarded-for')).toBe('203.0.113.9')
    expect(headers.get('x-client-info')).toBe('capgo-console')
    expect(headers.has('cookie')).toBe(false)
    expect(Buffer.from(init.body).toString()).toBe('{"email":"a","password":"b"}')
  })

  it('forwards the user session for authenticated endpoints', async () => {
    await app.request('https://api.example.com/private/console/auth/user', { headers: { authorization: 'Bearer user-jwt', 'x-forwarded-for': '198.51.100.4, 10.0.0.1' } })
    const headers = new Headers(fetchMock.mock.calls[0][1].headers)
    expect(headers.get('authorization')).toBe('Bearer user-jwt')
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.4')
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('passes verification redirects back untouched so email links complete', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 303, headers: { location: 'https://console.example/login#access_token=x' } }))
    const response = await app.request('https://api.example.com/private/console/auth/verify?token=abc&type=signup')
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('https://console.example/login#access_token=x')
    expect(fetchMock.mock.calls[0][0].href).toBe('https://auth.example.co/auth/v1/verify?token=abc&type=signup')
  })

  it('never relays admin or unknown endpoints', async () => {
    for (const path of ['admin/users', 'admin/generate_link', 'invite', '../rest/v1/users', 'factors/x/y/z', '']) {
      const response = await app.request(`https://api.example.com/private/console/auth/${path}`, { method: 'POST' })
      expect(response.status, path).toBe(404)
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(consoleAuthPath('/private/console/auth/factors/abc-123/verify')).toBe('factors/abc-123/verify')
    expect(consoleAuthPath('/private/console/auth/admin/users')).toBeNull()
  })

  it('rejects oversized bodies before contacting the auth provider', async () => {
    const response = await app.request('https://api.example.com/private/console/auth/signup', { method: 'POST', body: 'x'.repeat(70 * 1024) })
    expect(response.status).toBe(413)
    const declared = await app.request('https://api.example.com/private/console/auth/signup', { method: 'POST', headers: { 'content-length': String(80 * 1024) }, body: '{}' })
    expect(declared.status).toBe(413)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('console auth relay client address forwarding', () => {
  let turnstile: { success: boolean, 'error-codes'?: string[] }

  beforeEach(() => {
    env = FORWARDING_ENV
    turnstile = { success: true }
    fetchMock.mockImplementation(async (url: URL | string) => {
      if (String(url) === TURNSTILE_URL)
        return Response.json(turnstile)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })

  function authCalls() {
    return fetchMock.mock.calls.filter(([url]) => String(url) !== TURNSTILE_URL)
  }

  function turnstileCalls() {
    return fetchMock.mock.calls.filter(([url]) => String(url) === TURNSTILE_URL)
  }

  async function relay(path: string, headers: Record<string, string>, body: unknown = { gotrue_meta_security: { captcha_token: 'cf-token' } }) {
    const response = await app.request(`https://api.example.com/private/console/auth/${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const call = authCalls()[0]
    return { response, headers: call ? new Headers(call[1].headers) : null }
  }

  it('verifies Turnstile itself, then relays with the secret key and the Cloudflare address', async () => {
    const { response, headers } = await relay('signup', { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 Chrome/130', 'authorization': 'Bearer sb_publishable_x' })
    expect(response.status).toBe(200)
    const [, init] = turnstileCalls()[0]
    expect(init.body.get('secret')).toBe('turnstile-secret')
    expect(init.body.get('response')).toBe('cf-token')
    expect(init.body.get('remoteip')).toBe('203.0.113.9')

    expect(headers?.get('apikey')).toBe('sb_secret_test')
    // A client-chosen non-JWT bearer is dropped, never relayed.
    expect(headers?.has('authorization')).toBe(false)
    expect(headers?.get('sb-forwarded-for')).toBe('203.0.113.9')
    expect(headers?.get('x-forwarded-for')).toBe('203.0.113.9')
    // Supabase rejects secret-key requests that carry a browser User-Agent.
    expect(headers?.get('user-agent')).toBe('capgo-console-auth-relay')
  })

  it('rejects missing or failed captchas with GoTrue\'s error before contacting Supabase Auth', async () => {
    const missing = await relay('token?grant_type=password', { 'cf-connecting-ip': '203.0.113.9' }, { email: 'a', password: 'b' })
    expect(missing.response.status).toBe(400)
    expect(missing.response.headers.get('x-sb-error-code')).toBe('captcha_failed')
    expect(await missing.response.json()).toMatchObject({ error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (no captcha_token found)' })
    expect(turnstileCalls()).toHaveLength(0)

    turnstile = { 'success': false, 'error-codes': ['timeout-or-duplicate'] }
    const failed = await relay('recover', { 'cf-connecting-ip': '203.0.113.9' })
    expect(failed.response.status).toBe(400)
    expect(await failed.response.json()).toMatchObject({ error_code: 'captcha_failed', msg: 'captcha protection: request disallowed (timeout-or-duplicate)' })

    const unparsable = await app.request('https://api.example.com/private/console/auth/otp', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.9' }, body: 'not json' })
    expect(unparsable.status).toBe(400)
    expect(authCalls()).toHaveLength(0)
  })

  it('leaves the CAPTCHA to GoTrue when a user session is the caller', async () => {
    const { headers } = await relay('signup', { 'cf-connecting-ip': '203.0.113.9', 'authorization': USER_JWT })
    expect(turnstileCalls()).toHaveLength(0)
    expect(headers?.get('apikey')).toBe('sb_secret_test')
    expect(headers?.get('authorization')).toBe(USER_JWT)
  })

  it('does not ask for a captcha on routes GoTrue does not gate', async () => {
    for (const path of ['token?grant_type=refresh_token', 'token?grant_type=pkce', 'verify', 'logout']) {
      fetchMock.mockClear()
      const { response } = await relay(path, { 'cf-connecting-ip': '203.0.113.9' }, {})
      expect(response.status, path).toBe(200)
      expect(turnstileCalls(), path).toHaveLength(0)
    }
  })

  it('only forwards the Cloudflare address, never a client-supplied x-forwarded-for, with the secret key', async () => {
    const { headers } = await relay('recover', { 'x-forwarded-for': '198.51.100.4', 'user-agent': 'Mozilla/5.0' })
    expect(turnstileCalls()).toHaveLength(0)
    expect(headers?.get('apikey')).toBe('anon-key')
    expect(headers?.get('authorization')).toBe('Bearer anon-key')
    expect(headers?.get('user-agent')).toBe('Mozilla/5.0')
  })

  it('falls back to the publishable key, and GoTrue\'s own CAPTCHA, without a secret key or captcha secret', async () => {
    const unusable: Record<string, string>[] = [{ CAPTCHA_SECRET_KEY: '' }, { SUPABASE_SERVICE_ROLE_KEY: 'eyJ.legacy.jwt' }]
    for (const missing of unusable) {
      env = { ...FORWARDING_ENV, ...missing }
      fetchMock.mockClear()
      const { headers } = await relay('otp', { 'cf-connecting-ip': '203.0.113.9' })
      expect(turnstileCalls()).toHaveLength(0)
      expect(headers?.get('apikey')).toBe('anon-key')
      expect(headers?.get('authorization')).toBe('Bearer anon-key')
      expect(headers?.get('sb-forwarded-for')).toBe('203.0.113.9')
    }
  })
})

describe('captcha-gated routes', () => {
  it('matches the GoTrue routes behind verifyCaptcha', () => {
    const search = (query: string) => new URLSearchParams(query)
    for (const path of ['signup', 'recover', 'resend', 'otp', 'sso'])
      expect(requiresCaptcha(path, 'POST', search('')), path).toBe(true)
    expect(requiresCaptcha('token', 'POST', search('grant_type=password'))).toBe(true)
    expect(requiresCaptcha('token', 'POST', search('grant_type=web3'))).toBe(true)
    expect(requiresCaptcha('token', 'POST', search(''))).toBe(true)
    for (const grant of ['pkce', 'refresh_token', 'id_token'])
      expect(requiresCaptcha('token', 'POST', search(`grant_type=${grant}`)), grant).toBe(false)
    expect(requiresCaptcha('signup', 'GET', search(''))).toBe(false)
    expect(requiresCaptcha('verify', 'POST', search(''))).toBe(false)
  })
})
