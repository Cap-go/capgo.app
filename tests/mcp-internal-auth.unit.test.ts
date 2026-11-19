import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMcpApp, MAX_BATCH_CONCURRENCY, mapWithConcurrency } from '../supabase/functions/_backend/mcp/index.ts'
import { middlewareAuth, middlewareKey } from '../supabase/functions/_backend/utils/hono_middleware.ts'
import { markInternalRequestVerified } from '../supabase/functions/_backend/utils/internal_dispatch_auth.ts'

const KEY = '11111111-2222-4333-8444-555555555555'
const apikeyRow = { id: 7, user_id: 'user-1', name: 'MCP key', key: KEY, key_hash: null, rbac_id: 'rbac-1', expires_at: null, created_at: null, updated_at: null }

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  isIPRateLimited: vi.fn(),
  recordAPIKeyUsage: vi.fn(),
  isAPIKeyRateLimited: vi.fn(),
  recordFailedAuth: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/rate_limit.ts')>(),
  isIPRateLimited: mocks.isIPRateLimited,
  recordFailedAuth: mocks.recordFailedAuth,
  recordAPIKeyUsage: mocks.recordAPIKeyUsage,
  isAPIKeyRateLimited: mocks.isAPIKeyRateLimited,
  setAPIKeyRateLimitHeaders: () => {},
}))
// Both API-key lookups (MCP entry checkKey, middleware find_apikey_by_value) go through this spy.
vi.mock('../supabase/functions/_backend/utils/supabase.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/supabase.ts')>(),
  checkKey: async (_c: unknown, key: string) => mocks.lookup(key),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async original => ({
  ...await original<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: async () => ({}),
  closeClient: () => {},
  getDrizzleClient: () => ({
    execute: async (query: { queryChunks?: unknown[] }) => {
      const key = (query.queryChunks ?? []).find(chunk => typeof chunk === 'string') ?? null
      const row = await mocks.lookup(key)
      return { rows: row ? [row] : [] }
    },
  }),
}))
vi.mock('../supabase/functions/_backend/utils/utils.ts', async original => ({ ...await original<typeof import('../supabase/functions/_backend/utils/utils.ts')>(), backgroundTask: async () => {} }))

const routeHits = { userIds: [] as unknown[] }

function apiApp() {
  const app = new Hono()
  app.get('/auth', middlewareAuth(), c => c.json({ userId: c.get('auth')?.userId }))
  app.get('/key', middlewareKey({ usePostgres: true }), c => c.json({ userId: c.get('auth')?.userId }))
  app.post('/bundle/upload/complete', middlewareAuth(), (c) => {
    routeHits.userIds.push(c.get('auth')?.userId)
    return c.json({ status: 'ok' })
  })
  return app
}

beforeEach(() => {
  vi.clearAllMocks()
  routeHits.userIds = []
  mocks.lookup.mockImplementation(async (key: string) => key === KEY ? apikeyRow : null)
  mocks.isIPRateLimited.mockResolvedValue({ limited: false })
  mocks.recordAPIKeyUsage.mockResolvedValue({ count: 1 })
  mocks.isAPIKeyRateLimited.mockResolvedValue({ limited: false })
})

describe('in-process verified API key reuse', () => {
  it.each(['/auth', '/key'])('%s reuses the verified row without a second lookup, but still counts the key rate limit', async (path) => {
    const request = new Request(`http://localhost${path}`, { headers: { capgkey: KEY } })
    markInternalRequestVerified(request, KEY, apikeyRow as never)
    const response = await apiApp().fetch(request)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ userId: 'user-1' })
    expect(mocks.lookup).not.toHaveBeenCalled()
    expect(mocks.isIPRateLimited).not.toHaveBeenCalled()
    expect(mocks.recordAPIKeyUsage).toHaveBeenCalledTimes(1)
    expect(mocks.isAPIKeyRateLimited).toHaveBeenCalledTimes(1)
  })

  it.each(['/auth', '/key'])('%s still enforces the API key rate limit on a verified request', async (path) => {
    mocks.isAPIKeyRateLimited.mockResolvedValue({ limited: true, resetAt: Date.now() + 1000 })
    const request = new Request(`http://localhost${path}`, { headers: { capgkey: KEY } })
    markInternalRequestVerified(request, KEY, apikeyRow as never)
    const response = await apiApp().fetch(request)
    expect(response.status).toBe(429)
  })

  it.each([
    ['a forged internal-looking header', { 'capgkey': 'not-a-real-key', 'x-capgo-internal': '1', 'x-mcp-verified': KEY, 'user-agent': 'capgo-mcp', 'x-cli-command': 'mcp' }],
    ['the MCP headers with an unknown key', { 'capgkey': 'not-a-real-key', 'user-agent': 'capgo-mcp', 'x-cli-command': 'mcp' }],
  ])('external request with %s is looked up and rejected', async (_name, headers) => {
    const response = await apiApp().fetch(new Request('http://localhost/auth', { headers }))
    expect(response.status).toBe(401)
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
    expect(mocks.isIPRateLimited).toHaveBeenCalledTimes(1)
    expect(mocks.recordFailedAuth).toHaveBeenCalledTimes(1)
  })

  it('does not trust a copy of a verified request', async () => {
    const original = new Request('http://localhost/auth', { headers: { capgkey: 'not-a-real-key' } })
    markInternalRequestVerified(original, 'not-a-real-key', apikeyRow as never)
    const response = await apiApp().fetch(new Request(original))
    expect(response.status).toBe(401)
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })

  it('does not trust a verified request whose key header was swapped', async () => {
    const request = new Request('http://localhost/auth', { headers: { capgkey: 'other-key' } })
    markInternalRequestVerified(request, KEY, apikeyRow as never)
    const response = await apiApp().fetch(request)
    expect(response.status).toBe(401)
    expect(mocks.lookup).toHaveBeenCalledWith('other-key')
  })

  it('does not trust a verified row that expired since', async () => {
    const request = new Request('http://localhost/auth', { headers: { capgkey: KEY } })
    markInternalRequestVerified(request, KEY, { ...apikeyRow, expires_at: '2000-01-01T00:00:00Z' } as never)
    const response = await apiApp().fetch(request)
    expect(response.status).toBe(200)
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })

  it('looks the key up once per MCP request, however many API calls the tools make', async () => {
    const api = apiApp()
    const mcp = createMcpApp(request => api.fetch(request))
    const response = await mcp.request('/mcp', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify([1, 2, 3].map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'capgo_complete_bundle_upload', arguments: { upload_token: `token-${id}` } } }))),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { id: number }[]
    expect(body.map(entry => entry.id)).toEqual([1, 2, 3])
    expect(routeHits.userIds).toEqual(['user-1', 'user-1', 'user-1'])
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
    expect(mocks.recordAPIKeyUsage).toHaveBeenCalledTimes(3)
  })
})

describe('batch concurrency', () => {
  it('mapWithConcurrency keeps input order and never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const results = await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 4, async (item) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, (10 - item) * 2))
      inFlight--
      return item * 10
    })
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
    expect(peak).toBe(4)
  })

  it('runs at most MAX_BATCH_CONCURRENCY batched messages at once and keeps response order', async () => {
    let inFlight = 0
    let peak = 0
    const mcp = createMcpApp(async (request) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      const { upload_token } = await request.json() as { upload_token: string }
      // Later messages finish first, so ordering cannot come from completion order.
      await new Promise(resolve => setTimeout(resolve, 40 - Number(upload_token) * 3))
      inFlight--
      return Response.json({ status: 'ok' })
    })
    const ids = Array.from({ length: 12 }, (_, i) => i + 1)
    const response = await mcp.request('/mcp', {
      method: 'POST',
      headers: { 'authorization': `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(ids.map(id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'capgo_complete_bundle_upload', arguments: { upload_token: String(id) } } }))),
    })
    expect(response.status).toBe(200)
    const body = await response.json() as { id: number }[]
    expect(body.map(entry => entry.id)).toEqual(ids)
    expect(peak).toBe(MAX_BATCH_CONCURRENCY)
  })
})
