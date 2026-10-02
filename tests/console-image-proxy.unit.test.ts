import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/console_data'

const mocks = vi.hoisted(() => ({ sign: vi.fn(), client: vi.fn(), fetch: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  useCors: async (_c: unknown, next: () => Promise<void>) => next(),
  parseBody: (c: any) => c.req.json(),
  quickError: (status: number, error: string) => Response.json({ error }, { status }),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({
  middlewareAuth: async (c: any, next: () => Promise<void>) => {
    c.set('authorization', 'Bearer caller-rls-jwt')
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({ supabaseClient: mocks.client, emptySupabase: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  getEnv: (_c: unknown, key: string) => key === 'CONSOLE_AUTH_URL' ? 'https://api.example.com/functions/v1' : 'https://storage.example.com',
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('fetch', mocks.fetch)
  mocks.client.mockReturnValue({ storage: { from: () => ({ createSignedUrl: mocks.sign }) } })
})
afterEach(() => vi.unstubAllGlobals())

describe('console image proxy', () => {
  it('returns a Capgo image URL signed with the authenticated caller', async () => {
    mocks.sign.mockResolvedValue({ data: { signedUrl: 'https://storage.example.com/storage/v1/object/sign/images/org/logo.png?token=fixture-capability' }, error: null })
    const response = await app.request('https://api.example.com/images/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'org/logo.png', expiresIn: 60 }),
    })
    const { data } = await response.json() as { data: { signedUrl: string } }
    const url = new URL(data.signedUrl)
    expect(url.origin).toBe('https://api.example.com')
    expect(url.pathname).toBe('/functions/v1/private/console/images/read')
    expect(url.searchParams.get('path')).toBe('org/logo.png')
    expect(mocks.client).toHaveBeenCalledWith(expect.anything(), 'Bearer caller-rls-jwt')
  })

  it('streams image bytes from the fixed storage bucket without redirects', async () => {
    mocks.fetch.mockResolvedValue(new Response('fixture-image', { headers: { 'content-type': 'image/png' } }))
    const response = await app.request('https://api.example.com/images/read?path=org%2Fmy%20logo.png&token=fixture-capability')
    expect(await response.text()).toBe('fixture-image')
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const [upstream, options] = mocks.fetch.mock.calls[0]
    expect(upstream.href).toBe('https://storage.example.com/storage/v1/object/sign/images/org/my%20logo.png?token=fixture-capability')
    expect(options.redirect).toBe('error')
  })

  it('rejects traversal before making a storage request', async () => {
    const response = await app.request('https://api.example.com/images/read?path=..%2Fother-bucket%2Fsecret&token=fixture-capability')
    expect(response.status).toBe(400)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('does not serve an expired or invalid capability', async () => {
    mocks.fetch.mockResolvedValue(new Response('invalid token', { status: 401 }))
    const response = await app.request('https://api.example.com/images/read?path=org%2Flogo.png&token=expired-capability')
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'image_unavailable' })
  })
})
