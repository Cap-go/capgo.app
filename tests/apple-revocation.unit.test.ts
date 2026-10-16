import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/revoke_apple_authorization.ts'

const mocks = vi.hoisted(() => ({
  configured: true,
  user: { id: 'current-user', identities: [{ provider: 'apple', identity_data: { sub: 'apple-subject' } }], last_sign_in_at: '', factors: [] as { status: string }[] },
  aal: 'aal1',
  getUser: vi.fn(),
  verification: vi.fn(),
  from: vi.fn(),
  revoke: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/appleSignIn.ts', () => ({
  isAppleSignInConfigured: () => mocks.configured,
  revokeAppleAuthorization: (...args: unknown[]) => mocks.revoke(...args),
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseClient: () => ({ auth: { getUser: mocks.getUser }, from: mocks.from }),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    if (!c.req.header('authorization'))
      return c.json({ error: 'unauthorized' }, 401)
    c.set('auth', { userId: 'current-user', authType: 'jwt', claims: { aal: mocks.aal } })
    c.set('authorization', 'Bearer verified-session')
    await next()
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.configured = true
  mocks.aal = 'aal1'
  mocks.user = { id: 'current-user', identities: [{ provider: 'apple', identity_data: { sub: 'apple-subject' } }], last_sign_in_at: new Date().toISOString(), factors: [] }
  mocks.getUser.mockImplementation(async () => ({ data: { user: mocks.user }, error: null }))
  mocks.verification.mockResolvedValue({ data: { email_otp_verified_at: new Date().toISOString() }, error: null })
  mocks.from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle: mocks.verification }) }) }))
  mocks.revoke.mockResolvedValue(undefined)
})

function request(body: unknown = { code: 'fresh-authorization-code' }, authenticated = true) {
  const router = new Hono().route('/revoke', app)
  return router.request('http://local/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { authorization: 'Bearer verified-session' } : {}) },
    body: JSON.stringify(body),
  })
}

describe('apple authorization revocation', () => {
  it('requires authentication before touching credentials', async () => {
    expect((await request({}, false)).status).toBe(401)
    expect(mocks.getUser).not.toHaveBeenCalled()
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('binds the code to the server-verified Apple identity, ignoring client identity fields', async () => {
    expect((await request({ code: 'fresh-code', subject: 'different-subject', userId: 'another-user' })).status).toBe(200)
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), 'fresh-code', 'apple-subject', false)
    expect(mocks.getUser).toHaveBeenCalledWith('verified-session')
    expect(mocks.from).toHaveBeenCalledWith('user_security')
  })
  it('rejects malformed codes', async () => {
    for (const body of [{}, { code: '' }, { code: 'x'.repeat(4097) }])
      expect((await request(body)).status).toBe(400)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('requires configured credentials', async () => {
    mocks.configured = false
    expect((await request()).status).toBe(503)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('rejects another Supabase user and accounts without an Apple identity', async () => {
    mocks.user.id = 'another-user'
    expect((await request()).status).toBe(401)
    mocks.user.id = 'current-user'
    mocks.user.identities = []
    expect((await request()).status).toBe(403)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('requires a recent sign-in and custom email verification', async () => {
    mocks.user.last_sign_in_at = new Date(Date.now() - 6 * 60_000).toISOString()
    expect((await request()).status).toBe(403)
    mocks.user.last_sign_in_at = new Date().toISOString()
    mocks.verification.mockResolvedValue({ data: null, error: null })
    expect((await request()).status).toBe(403)
    expect(mocks.revoke).not.toHaveBeenCalled()
  })
  it('requires MFA for accounts with a verified factor', async () => {
    mocks.user.factors = [{ status: 'verified' }]
    expect((await request()).status).toBe(403)
    expect(mocks.revoke).not.toHaveBeenCalled()
    mocks.aal = 'aal2'
    expect((await request()).status).toBe(200)
  })
  it('does not expose Apple errors or credentials in responses', async () => {
    mocks.revoke.mockRejectedValue(new Error('private upstream token'))
    const response = await request()
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('private upstream token')
  })
})
