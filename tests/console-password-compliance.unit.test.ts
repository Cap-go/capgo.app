import { APIError } from 'better-auth/api'
import { beforeEach, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/validate_password_compliance.ts'

const { verifyPassword, close, recordAccountFailure } = vi.hoisted(() => ({ verifyPassword: vi.fn(), close: vi.fn(), recordAccountFailure: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/console_auth.ts', () => ({
  consoleAuthHeaders: (headers: Headers) => headers,
  createConsoleAuth: () => ({ auth: { api: { verifyPassword } }, close }),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('auth', { userId: 'fixture-user', claims: { email: 'fixture@example.com' } })
    c.set('authorization', c.req.header('authorization'))
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  isIPRateLimited: async () => ({ limited: false }),
  isAccountRateLimited: async () => ({ limited: false }),
  recordFailedAuth: vi.fn(),
  recordFailedAccountAuth: recordAccountFailure,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

async function request(error: Error) {
  verifyPassword.mockRejectedValue(error)
  return app.request('http://localhost/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer capgo_session_fixture' },
    body: JSON.stringify({ email: 'fixture@example.com', password: 'fixture-password', org_id: '10000000-0000-4000-8000-000000000001' }),
  }, { CAPTCHA_SECRET_KEY: '' })
}

it('counts an invalid password as an account authentication failure', async () => {
  expect((await request(new APIError('BAD_REQUEST', { code: 'INVALID_PASSWORD', message: 'Invalid password' }))).status).toBe(401)
  expect(recordAccountFailure).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})

it('preserves other provider client failures without counting a bad password', async () => {
  expect((await request(new APIError('TOO_MANY_REQUESTS', { code: 'RATE_LIMITED', message: 'Rate limited' }))).status).toBe(429)
  expect(recordAccountFailure).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})

it('propagates unexpected failures without locking the account', async () => {
  expect((await request(new Error('Fixture database unavailable'))).status).toBe(500)
  expect(recordAccountFailure).not.toHaveBeenCalled()
  expect(close).toHaveBeenCalledOnce()
})
