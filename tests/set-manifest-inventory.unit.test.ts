import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from '../supabase/functions/_backend/private/set_manifest.ts'
import { ManifestInventoryConflict } from '../supabase/functions/_backend/utils/manifest_inventory.ts'

const mocks = vi.hoisted(() => ({ persist: vi.fn(), register: vi.fn(), verify: vi.fn(), version: { storage_provider: 'r2-direct', id: 1, app_id: 'com.example.fake', name: 'test', deleted: false }, primary: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({ middlewareKey: () => async (_c: unknown, next: () => Promise<void>) => next() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: async () => true }))
vi.mock('../supabase/functions/_backend/utils/manifest_persist.ts', () => ({ persistVersionManifestEntries: mocks.persist }))
vi.mock('../supabase/functions/_backend/utils/manifest_size_receipt.ts', async original => ({ ...await original<object>(), verifyManifestSizeReceiptFacts: mocks.verify }))
vi.mock('../supabase/functions/_backend/utils/manifest_inventory.ts', async original => ({ ...await original<object>(), usesManifestInventory: () => true, withManifestInventory: async (_c: unknown, run: (db: unknown) => Promise<void>) => run({}), registerManifestInventory: mocks.register }))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({ from: (table: string) => {
    const chain = { select: () => chain, eq: () => chain, single: async () => ({ data: table === 'apps' ? { app_id: 'com.example.fake', owner_org: 'fake-org' } : mocks.version, error: null }) }
    return chain
  } }),
  supabaseAdmin: mocks.primary,
}))
beforeEach(() => {
  vi.clearAllMocks()
  mocks.register.mockResolvedValue(undefined)
  mocks.persist.mockResolvedValue({ inserted: 2, alreadyPresent: false })
  mocks.verify.mockResolvedValue([{ version: 2, size: 42 }, { version: 2, size: 43 }])
})
const entries = ['a', 'b'].map(file => ({ file_name: file, file_hash: 'fake-hash', s3_path: `orgs/fake-org/apps/com.example.fake/delta/${file}`, file_size_receipt: 'synthetic-receipt' }))
async function request(manifest = entries, cliVersion: string | null = '8.74.0') {
  const server = new Hono()
  server.onError((error, c) => error instanceof HTTPException ? c.json(error.cause as object, error.status) : c.json({ error: 'unexpected' }, 500))
  server.route('/', app)
  const headers = new Headers({ 'content-type': 'application/json' })
  if (cliVersion !== null)
    headers.set('x-cli-version', cliVersion)
  return server.request('/', { method: 'POST', headers, body: JSON.stringify({ app_id: 'com.example.fake', name: 'test', manifest }) })
}

describe('whole-manifest inventory gate', () => {
  it.each([null, '', 'invalid', '8.73.0', '8.73.99', '8.74.0-beta.1'])('preserves legacy uploads without inventory admission for CLI %s', async (cliVersion) => {
    mocks.register.mockRejectedValue(new ManifestInventoryConflict([entries[0].s3_path]))
    expect((await request(entries, cliVersion)).status).toBe(200)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.persist).toHaveBeenCalledOnce()
    expect(mocks.verify).toHaveBeenCalledOnce()
  })
  it.each(['8.74.0', '8.74.0+build.1', '8.74.1', '8.100.0', '9.0.0'])('requires active inventory reservations for CLI %s', async (cliVersion) => {
    mocks.register.mockRejectedValue(new ManifestInventoryConflict([entries[0].s3_path]))
    expect((await request(entries, cliVersion)).status).toBe(409)
    expect(mocks.register).toHaveBeenCalledOnce()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it('still rejects invalid receipts for legacy uploads', async () => {
    mocks.verify.mockResolvedValue(null)
    expect((await request(entries, '8.73.0')).status).toBe(400)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it('rejects conflicts with 409 before any primary manifest insertion', async () => {
    mocks.register.mockRejectedValue(new ManifestInventoryConflict([entries[1].s3_path]))
    const response = await request()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'error_manifest_inventory_conflict', moreInfo: { entries: [entries[1].s3_path] } })
    expect(mocks.persist).not.toHaveBeenCalled()
    expect(mocks.primary).not.toHaveBeenCalled()
  })
  it('verifies every receipt before opening the inventory transaction', async () => {
    mocks.verify.mockResolvedValue(null)
    expect((await request()).status).toBe(400)
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.persist).not.toHaveBeenCalled()
  })
  it('registers confirmed sizes first and then preserves the existing manifest transaction', async () => {
    expect((await request()).status).toBe(200)
    expect(mocks.verify.mock.calls[0][2]).toHaveLength(2)
    expect(mocks.register.mock.invocationCallOrder[0]).toBeLessThan(mocks.persist.mock.invocationCallOrder[0])
    expect(mocks.persist.mock.calls[0][2].map((entry: { file_size: number }) => entry.file_size)).toEqual([42, 43])
  })
})
