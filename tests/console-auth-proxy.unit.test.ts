import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app, consoleAuthPath } from '../supabase/functions/_backend/private/console_auth_proxy'

const fetchMock = vi.fn()
const BASE_ENV: Record<string, string> = { SUPABASE_URL: 'https://auth.example.co/', SUPABASE_ANON_KEY: 'anon-key' }
const ANON_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig'
const USER_JWT = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.sig'
const FORWARDING_ENV = { ...BASE_ENV, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test', SUPABASE_ANON_JWT: ANON_JWT }
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
  beforeEach(() => {
    env = FORWARDING_ENV
  })

  async function relayedHeaders(path: string, headers: Record<string, string>) {
    await app.request(`https://api.example.com/private/console/auth/${path}`, { method: 'POST', headers, body: '{}' })
    return new Headers(fetchMock.mock.calls[0][1].headers)
  }

  it('uses the secret key with the anon JWT for signed-out requests so Sb-Forwarded-For is honoured', async () => {
    const headers = await relayedHeaders('signup', { 'cf-connecting-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130' })
    expect(headers.get('apikey')).toBe('sb_secret_test')
    // Supabase rejects secret-key requests that carry a browser User-Agent.
    expect(headers.get('user-agent')).toBe('capgo-console-auth-relay')
    expect(headers.get('authorization')).toBe(`Bearer ${ANON_JWT}`)
    expect(headers.get('sb-forwarded-for')).toBe('203.0.113.9')
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9')
  })

  it('keeps the user session as the caller identity', async () => {
    const headers = await relayedHeaders('factors', { 'cf-connecting-ip': '203.0.113.9', 'authorization': USER_JWT })
    expect(headers.get('apikey')).toBe('sb_secret_test')
    expect(headers.get('authorization')).toBe(USER_JWT)
  })

  it('never lets a non-JWT bearer reach the gateway, where it would resolve to service_role and skip CAPTCHA', async () => {
    for (const authorization of ['Bearer sb_publishable_x', 'Bearer sb_secret_test', 'bearer x.y.z', 'Basic abc']) {
      fetchMock.mockClear()
      const headers = await relayedHeaders('token?grant_type=password', { 'cf-connecting-ip': '203.0.113.9', authorization })
      expect(headers.get('authorization'), authorization).toBe(`Bearer ${ANON_JWT}`)
    }
  })

  it('only forwards the Cloudflare address, never a client-supplied x-forwarded-for, with the secret key', async () => {
    const headers = await relayedHeaders('recover', { 'x-forwarded-for': '198.51.100.4', 'user-agent': 'Mozilla/5.0' })
    expect(headers.get('apikey')).toBe('anon-key')
    expect(headers.get('user-agent')).toBe('Mozilla/5.0')
    expect(headers.get('authorization')).toBe('Bearer anon-key')
  })

  it('falls back to the publishable key when the anon JWT or a secret key is not configured', async () => {
    for (const missing of [{ SUPABASE_ANON_JWT: '' }, { SUPABASE_SERVICE_ROLE_KEY: 'eyJ.legacy.jwt' }]) {
      env = { ...FORWARDING_ENV, ...missing }
      fetchMock.mockClear()
      const headers = await relayedHeaders('otp', { 'cf-connecting-ip': '203.0.113.9' })
      expect(headers.get('apikey')).toBe('anon-key')
      expect(headers.get('authorization')).toBe('Bearer anon-key')
      expect(headers.get('sb-forwarded-for')).toBe('203.0.113.9')
    }
  })
})
