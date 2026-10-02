import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/sso/check-enforcement'

const mocks = vi.hoisted(() => ({ client: vi.fn(), claims: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  createHono: () => new Hono(),
  useCors: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: async () => ({}),
  quickError: () => new Response(null, { status: 500 }),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  getClaimsFromJWT: mocks.claims,
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer target-jwt')
    c.set('auth', { userId: 'target-user', claims: { sub: 'target-user', email: 'target@example.com', app_metadata: { provider: 'email' } } })
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseClient: mocks.client,
  supabaseWithAuth: () => ({ rpc: async (name: string) => ({ error: null, data: name === 'check_domain_sso' ? [{}] : [{ org_id: 'fixture-org', enforce_sso: true }] }) }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.client.mockReturnValue({ rpc: async () => ({ data: true, error: null }) })
})

describe('SSO impersonation authentication', () => {
  it.each([
    ['Bearer legacy-admin-jwt', 'Bearer legacy-admin-jwt'],
    ['Bearer capgo_session_admin', 'Bearer mapped-admin-jwt'],
  ])('checks separate admin proof %s and restores the target authorization', async (proof, expected) => {
    let context: any
    mocks.claims.mockImplementation(async (c: any) => {
      context = c
      if (proof.startsWith('Bearer capgo_session_'))
        c.set('authorization', 'Bearer mapped-admin-jwt')
      return { sub: 'admin-user' }
    })
    const response = await app.request('http://localhost/', { method: 'POST', headers: { 'x-capgo-spoof-admin-authorization': proof } })
    expect(await response.json()).toEqual({ allowed: true })
    expect(mocks.client).toHaveBeenCalledWith(expect.anything(), expected)
    expect(context.get('authorization')).toBe('Bearer target-jwt')
  })
})
