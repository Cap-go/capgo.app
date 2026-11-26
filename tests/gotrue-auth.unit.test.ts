import type { Context } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GotrueAdminError } from '../supabase/functions/_backend/utils/gotrue_admin.ts'
import { gotrueAuth } from '../supabase/functions/_backend/utils/gotrue_auth.ts'

const ENV: Record<string, string> = { SUPABASE_URL: 'https://project.supabase.co/', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test' }
const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'a@b.co', app_metadata: {}, user_metadata: {} }
const SESSION = { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: USER }
const fetchMock = vi.fn()
const { getClientIPMock } = vi.hoisted(() => ({ getClientIPMock: vi.fn(() => '203.0.113.10') }))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => ENV[key] ?? '',
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  getClientIP: getClientIPMock,
}))

function context(env: Record<string, unknown> = {}) {
  return { env } as unknown as Context
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function lastCall(mock = fetchMock) {
  const [url, init] = mock.mock.calls.at(-1) as [string, RequestInit]
  return { url, init, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  getClientIPMock.mockReturnValue('203.0.113.10')
})
afterEach(() => vi.unstubAllGlobals())

describe('gotrueAuth requests', () => {
  it('signs in with a password like supabase-js', async () => {
    fetchMock.mockResolvedValue(json(SESSION))
    const { data, error } = await gotrueAuth(context()).signInWithPassword({ email: 'a@b.co', password: 'pw', options: { captchaToken: 'cap' } })

    expect(error).toBeNull()
    expect(data.user?.id).toBe(USER.id)
    expect(data.session?.access_token).toBe('access')
    expect(data.session?.refresh_token).toBe('refresh')
    expect(data.session?.expires_at).toBeGreaterThan(Date.now() / 1000)
    const call = lastCall()
    expect(call.url).toBe('https://project.supabase.co/auth/v1/token?grant_type=password')
    expect(call.init.method).toBe('POST')
    expect(call.body).toEqual({ email: 'a@b.co', password: 'pw', gotrue_meta_security: { captcha_token: 'cap' } })
    expect(call.headers.get('apikey')).toBe('anon-key')
    expect(call.headers.get('authorization')).toBe('Bearer anon-key')
    expect(call.headers.get('x-supabase-api-version')).toBe('2024-01-01')
    expect(call.headers.get('content-type')).toBe('application/json;charset=UTF-8')
    expect(call.headers.has('x-forwarded-for')).toBe(false)
  })

  it('signs up with metadata and forwards the client IP when asked', async () => {
    fetchMock.mockResolvedValue(json(SESSION))
    const { data, error } = await gotrueAuth(context(), { forwardClientIp: true }).signUp({
      email: 'a@b.co',
      password: 'pw',
      options: { captchaToken: 'cap', data: { first_name: 'A' } },
    })

    expect(error).toBeNull()
    expect(data.user?.id).toBe(USER.id)
    const call = lastCall()
    expect(call.url).toBe('https://project.supabase.co/auth/v1/signup')
    expect(call.body).toEqual({ email: 'a@b.co', password: 'pw', data: { first_name: 'A' }, gotrue_meta_security: { captcha_token: 'cap' } })
    expect(call.headers.get('x-forwarded-for')).toBe('203.0.113.10')
  })

  it('does not forward an unknown client IP', async () => {
    getClientIPMock.mockReturnValue('unknown')
    fetchMock.mockResolvedValue(json(SESSION))
    await gotrueAuth(context(), { forwardClientIp: true }).signUp({ email: 'a@b.co', password: 'pw' })

    const call = lastCall()
    expect(call.headers.has('x-forwarded-for')).toBe(false)
    expect(call.body).toEqual({ email: 'a@b.co', password: 'pw', data: {}, gotrue_meta_security: {} })
  })

  it('returns the user without a session when sign-up awaits email confirmation', async () => {
    fetchMock.mockResolvedValue(json(USER))
    const { data, error } = await gotrueAuth(context()).signUp({ email: 'a@b.co', password: 'pw' })

    expect(error).toBeNull()
    expect(data.user?.id).toBe(USER.id)
    expect(data.session).toBeNull()
  })

  it('verifies an OTP by token hash or by email and token', async () => {
    fetchMock.mockImplementation(async () => json(SESSION))
    const auth = gotrueAuth(context())

    const byHash = await auth.verifyOtp({ token_hash: 'hash', type: 'email' })
    expect(byHash.data.session?.access_token).toBe('access')
    let call = lastCall()
    expect(call.url).toBe('https://project.supabase.co/auth/v1/verify')
    expect(call.body).toEqual({ token_hash: 'hash', type: 'email', gotrue_meta_security: {} })

    await auth.verifyOtp({ email: 'a@b.co', token: '123456', type: 'magiclink' })
    call = lastCall()
    expect(call.body).toEqual({ email: 'a@b.co', token: '123456', type: 'magiclink', gotrue_meta_security: {} })
  })

  it('goes through the GOTRUE binding when the environment has one', async () => {
    const bindingFetch = vi.fn(async () => json(SESSION))
    await gotrueAuth(context({ GOTRUE: { fetch: bindingFetch } })).verifyOtp({ token_hash: 'hash', type: 'email' })

    expect(fetchMock).not.toHaveBeenCalled()
    const call = lastCall(bindingFetch)
    expect(call.url).toBe('https://gotrue/verify')
    expect(call.headers.get('apikey')).toBe('anon-key')
  })
})

describe('gotrueAuth errors', () => {
  it('keeps GoTrue status and code', async () => {
    fetchMock.mockResolvedValue(json({ code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400))
    const { data, error } = await gotrueAuth(context()).signInWithPassword({ email: 'a@b.co', password: 'bad' })

    expect(data).toEqual({ user: null, session: null })
    expect(error).toBeInstanceOf(GotrueAdminError)
    expect(error).toMatchObject({ message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' })
  })

  it('keeps the weak password reasons', async () => {
    fetchMock.mockResolvedValue(json({ code: 'weak_password', msg: 'Password is known to be weak', weak_password: { reasons: ['pwned'] } }, 422))
    const { error } = await gotrueAuth(context()).signUp({ email: 'a@b.co', password: 'password' })

    expect(error).toMatchObject({ status: 422, code: 'weak_password', reasons: ['pwned'] })
  })

  it('reports rate limits with their status', async () => {
    fetchMock.mockResolvedValue(json({ error_code: 'over_request_rate_limit', msg: 'Request rate limit reached' }, 429))
    const { error } = await gotrueAuth(context()).verifyOtp({ token_hash: 'hash', type: 'email' })

    expect(error).toMatchObject({ status: 429, code: 'over_request_rate_limit' })
  })

  it('treats a sign-in without a session as an error, like supabase-js', async () => {
    fetchMock.mockResolvedValue(json(USER))
    const { data, error } = await gotrueAuth(context()).signInWithPassword({ email: 'a@b.co', password: 'pw' })

    expect(data).toEqual({ user: null, session: null })
    expect(error).toMatchObject({ message: 'Auth session or user missing', status: 500 })
  })

  it('turns a network failure into an error instead of throwing', async () => {
    fetchMock.mockRejectedValue(new Error('connection reset'))
    const { error } = await gotrueAuth(context()).verifyOtp({ token_hash: 'hash', type: 'email' })

    expect(error).toMatchObject({ message: 'connection reset', status: 0 })
  })
})
