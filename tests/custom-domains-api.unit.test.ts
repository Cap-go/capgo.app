import { randomUUID } from 'node:crypto'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/custom_domains.ts'

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  enterprise: vi.fn(),
  query: vi.fn(),
  provider: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/hono_jwt.ts', () => ({ middlewareAuth: async (_c: unknown, next: () => Promise<void>) => next() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: mocks.permission }))
vi.mock('../supabase/functions/_backend/utils/plan-gating.ts', () => ({ requireEnterprisePlan: mocks.enterprise }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: () => ({ query: mocks.query }),
  closeClient: vi.fn(),
  withPgTransaction: async (_pool: unknown, run: (client: { query: typeof mocks.query }) => Promise<unknown>) => run({ query: mocks.query }),
}))
vi.mock('../supabase/functions/_backend/utils/custom-domains.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/custom-domains.ts')>(),
  cloudflareCustomHostname: mocks.provider,
  customDomainConfig: () => ({ target: 'customers.capgo.app' }),
}))

const orgId = randomUUID()
beforeEach(() => {
  vi.resetAllMocks()
  mocks.permission.mockResolvedValue(true)
  mocks.enterprise.mockResolvedValue(undefined)
  mocks.query.mockResolvedValue({ rows: [] })
  mocks.provider.mockResolvedValue({ id: 'provider-id', worker_route_id: 'route-id', hostname: 'updates.example.com', status: 'pending' })
})

describe('private organization custom domain API', () => {
  it.each(['GET', 'POST', 'DELETE'])('denies %s before provider or database access', async (method) => {
    mocks.permission.mockResolvedValue(false)
    expect((await app.request(`/${orgId}`, { method })).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it('rejects malformed organization IDs before permission checks', async () => {
    expect((await app.request('/not-a-uuid')).status).toBe(400)
    expect(mocks.permission).not.toHaveBeenCalled()
  })

  it('denies creation before provisioning when the paid Enterprise check fails', async () => {
    mocks.enterprise.mockRejectedValueOnce(new HTTPException(403))
    expect((await app.request(`/${orgId}`, { method: 'POST' })).status).toBe(403)
    expect(mocks.query).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it('keeps an existing organization domain when another add is attempted', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ org_id: orgId }] })
    const response = await app.request(`/${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'updates.example.com' }) })
    expect(response.status).toBe(409)
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it('normalizes hostname creation and stores the provider ID after reserving it', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ org_id: orgId }] }).mockResolvedValueOnce({ rows: [] })
    const response = await app.request(`/${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: ' Updates.Example.com ' }) })
    expect(response.status).toBe(200)
    expect(mocks.enterprise).toHaveBeenCalledWith(expect.anything(), orgId, 'Custom domains', true)
    expect(mocks.provider).toHaveBeenCalledWith(expect.anything(), 'POST', '', 'updates.example.com')
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining('SET provider_id'), [orgId, 'provider-id', 'route-id'])
  })

  it('never provisions a hostname reserved by another organization', async () => {
    const response = await app.request(`/${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'updates.example.com' }) })
    expect(response.status).toBe(409)
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it('removes provider state if persistence fails after creation', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ org_id: orgId }] }).mockRejectedValueOnce(new Error('database unavailable'))
    expect((await app.request(`/${orgId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: 'updates.example.com' }) })).status).toBe(500)
    expect(mocks.provider).toHaveBeenLastCalledWith(expect.anything(), 'DELETE', 'provider-id', undefined, 'route-id')
  })

  it('passes the saved route ID to provider cleanup before deleting local state', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ provider_id: 'provider-id', provider_route_id: 'route-id' }] })
    expect((await app.request(`/${orgId}`, { method: 'DELETE' })).status).toBe(200)
    expect(mocks.provider).toHaveBeenCalledWith(expect.anything(), 'DELETE', 'provider-id', undefined, 'route-id')
    expect(mocks.query).toHaveBeenLastCalledWith('DELETE FROM public.org_custom_domains WHERE org_id = $1', [orgId])
  })

  it('allows deletion after a downgrade and keeps the row when provider deletion fails', async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ provider_id: 'provider-id', provider_route_id: 'route-id' }] })
    mocks.provider.mockRejectedValueOnce(new Error('provider unavailable'))
    expect((await app.request(`/${orgId}`, { method: 'DELETE' })).status).toBe(500)
    expect(mocks.enterprise).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.some(([sql]) => sql.startsWith('DELETE'))).toBe(false)
  })
})
