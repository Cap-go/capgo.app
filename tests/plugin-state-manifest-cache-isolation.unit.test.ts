import { Hono } from 'hono'
import { afterEach, expect, it, vi } from 'vitest'
import { getManifestDownloadSize } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { pluginStateAppKey, pluginStateManifestKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { pluginStateBucket } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateSwitch.ts'

const database = vi.hoisted(() => ({ query: vi.fn() }))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/pg.ts')>(),
  getPgClient: async () => ({ query: database.query }),
  closeClient: async () => undefined,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts', () => ({
  readPublishedPluginState: async (_context: unknown, store: { get: (key: string) => unknown }, key: string) => ({ value: await store.get(key), revision: null }),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('keeps KV canary size maps separate from the unchanged DB/control cache', async () => {
  vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
  vi.stubEnv('PLUGIN_STATE_KV', '1%')
  const appId = 'com.example.manifestcanary'
  const devices = Array.from({ length: 10_000 }, (_, i) => `device-${i}`)
  const canary = devices.find(device => pluginStateBucket(appId, device) < 100)
  const control = devices.find(device => pluginStateBucket(appId, device) >= 100)
  if (!canary || !control)
    throw new Error('Expected distinct canary and control fixture devices')
  const entries = new Map<string, Response>()
  vi.stubGlobal('caches', { open: async () => ({
    match: async (request: Request) => entries.get(request.url)?.clone(),
    put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()) },
  }) })
  database.query.mockResolvedValue({ rows: [{ file_hash: 'hash', version_id: 42, file_size: 100 }] })
  const appKey = await pluginStateAppKey(appId)
  const appDoc = {
    f: 1, app_id: appId, exists: true, built_at: Date.now(),
    owner: { owner_org: '00000000-0000-4000-8000-000000000001', block_provider_infra_requests: false },
    plan: { has_credits: false, customer_id: null, stripe: null }, channels: [], overrides: {},
  }
  const get = vi.fn(async (key: string) => {
    if (key === appKey)
      return appDoc
    if (key === pluginStateManifestKey(42))
      return { f: 1, built_at: Date.now(), app_id: appId, version_id: 42, deleted: false, entries: [], sizes: [['hash', '200']] }
    throw new Error('unexpected state read')
  })
  const app = new Hono()
  app.get('/', async c => c.json(await getManifestDownloadSize(c, appId, undefined, 42, Array.from({ length: Number(c.req.query('versions') ?? 1) }, (_, i) => (
    { file_name: `file-${i}.js`, file_hash: i === 0 ? 'hash' : `hash-${i}`, download_url: `https://example.com/files/read?key=${42 + i}` }
  )), c.req.query('device'))))
  const env = { PLUGIN_STATE: { get } }
  const db = await app.request(`/?device=${control}`, undefined, env)
  expect(await db.json()).toMatchObject({ totalSize: 100 })
  expect(get).not.toHaveBeenCalled()
  expect(database.query).toHaveBeenCalledOnce()
  const dbEntry = entries.get(`http://localhost/.manifest-sizes-v1?app_id=${appId}&version_id=42`)
  expect(dbEntry?.headers.get('Cache-Control')).toBe('public, s-maxage=86400')
  expect(dbEntry?.headers.get('Cache-Tag')).toBeNull()

  const kv = await app.request(`/?device=${canary}`, undefined, env)
  expect(await kv.json()).toMatchObject({ totalSize: 200 })
  expect(kv.headers.get('X-Plugin-State')).toBe('kv')
  expect(get).toHaveBeenCalledTimes(2)
  expect(database.query).toHaveBeenCalledOnce()
  const kvEntry = entries.get(`http://localhost/.plugin-state-manifest-sizes-v1?app_id=${appId}&version_id=42`)
  expect(kvEntry?.headers.get('Cache-Control')).toBe('public, s-maxage=30')
  expect(kvEntry?.headers.get('Cache-Tag')).toBe(`capgo-plugin-state-${appId}`)

  const warmControl = await app.request(`/?device=${control}`, undefined, env)
  expect(await warmControl.json()).toMatchObject({ totalSize: 100 })
  const warmCanary = await app.request(`/?device=${canary}`, undefined, env)
  expect(await warmCanary.json()).toMatchObject({ totalSize: 200 })
  expect(database.query).toHaveBeenCalledOnce()
  expect(get).toHaveBeenCalledTimes(2)

  // A public request spanning many version ids uses one batched replica query
  // before reading any per-version KV documents, without truncating its files.
  const large = await app.request(`/?device=${canary}&versions=100`, undefined, env)
  expect(large.headers.get('X-Plugin-State')).toBe('fallback')
  expect(await large.json()).toMatchObject({ totalSize: 100, knownFiles: 1, unknownFiles: 99, files: expect.any(Array) })
  expect(database.query).toHaveBeenCalledTimes(2)
  expect(get).toHaveBeenCalledTimes(2)
})
