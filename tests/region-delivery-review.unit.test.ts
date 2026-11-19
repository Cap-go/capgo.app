import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../cloudflare_workers/files/index.ts'
import { buildWorkersCacheKey } from '../cloudflare_workers/files/cache_key.ts'
import { enforceFileServingPolicy, enforcePreviewServingPolicy } from '../supabase/functions/_backend/files/file_serving_policy.ts'
import { enforceServingPolicy } from '../supabase/functions/_backend/plugin_runtime/utils/servingPolicy.ts'
import { SERVING_REGIONS } from '../supabase/functions/_backend/plugin_runtime/utils/servingRegions.ts'

vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {} }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ servingRegionReaderEpoch: 'test-review-delivery' }))
const appId = 'com.example.restricted'
const previewApp = 'com.example.open'
const filePath = `/files/read/attachments/orgs/example/apps/${appId}/bundle.zip`
function request(host: string, path = filePath, colo = 'CDG') {
  const req = new Request(`https://${host}${path}`)
  Object.defineProperty(req, 'cf', { value: { colo } })
  return req
}
function policy(app: string, regions: readonly string[] = SERVING_REGIONS, mode = 'route') {
  return { f: 1, app_id: app, generation: '1', policy: { regions, mode } }
}
afterEach(() => vi.unstubAllGlobals())

describe('app identity at delivery admission', () => {
  it.each(['/files/read/attachments/', '/private/files/read/attachments/'])('rejects a preview hostname combined with %s before a warm managed cache', async (prefix) => {
    const path = prefix + `orgs/example/apps/${appId}/bundle.zip`
    const previewHost = '123-com-0example-0open.preview.capgo.app'
    const key = buildWorkersCacheKey(request('files.capgo.app', path))
    expect(buildWorkersCacheKey(request(previewHost, path))).toBe(key)
    const managedCache = new Map([[key, 'restricted cached bytes']])
    const cachedFetch = vi.fn(async (req: Request) => new Response(managedCache.get(buildWorkersCacheKey(req))))
    const match = vi.fn()
    vi.stubGlobal('caches', { default: { match } })
    const get = vi.fn(async (key: string) => ({ json: async () => key === `sr1:${previewApp}` ? policy(previewApp) : policy(appId, ['NA']) }))
    const env = { PLUGIN_STATE_POINTERS: { get } }
    const ctx = { props: {}, waitUntil: vi.fn(), passThroughOnException: vi.fn(), exports: { CachedFiles: { fetch: cachedFetch } } }
    expect((await worker.fetch(request('files.capgo.app', path), env, ctx)).status).toBe(403)
    const mixed = await worker.fetch(request(previewHost, path), env, ctx)
    expect(mixed.status).toBe(404)
    expect(await mixed.text()).not.toContain('restricted cached bytes')
    expect(cachedFetch).not.toHaveBeenCalled()
    expect(match).not.toHaveBeenCalled()
  })

  it('does not reuse another app admission on the same Request', async () => {
    const get = vi.fn(async (key: string) => ({ json: async () => key === `sr1:${previewApp}` ? policy(previewApp) : policy(appId, ['NA']) }))
    const data = vi.fn()
    const app = new Hono().get('/', async c => {
      await enforceServingPolicy(c, previewApp)
      await enforceServingPolicy(c, previewApp)
      await enforceServingPolicy(c, appId)
      data()
      return c.text('restricted data')
    })
    expect((await app.fetch(request('files.capgo.app', '/'), { PLUGIN_STATE_POINTERS: { get } })).status).toBe(503)
    expect(get).toHaveBeenCalledTimes(1)
    expect(data).not.toHaveBeenCalled()
  })
})

describe('TUS upload IDs at file admission', () => {
  it('admits a supported TUS upload ID through the app of its storage key', async () => {
    const tusId = btoa(`capgo/orgs/example/apps/${appId}/bundle.zip/123e4567-e89b-42d3-a456-426614174000`)
    const get = vi.fn(async (_key: string) => ({ json: async () => policy(appId) }))
    const app = new Hono().get('/', async (c) => {
      await enforceFileServingPolicy(c, tusId)
      return c.text('admitted')
    })
    expect((await app.fetch(request('files.capgo.app', '/'), { PLUGIN_STATE_POINTERS: { get } })).status).toBe(200)
    expect(get.mock.calls.map(call => String(call[0]))).toEqual([`sr1:${appId}`])
  })
  it('still refuses an ID that stays unscoped once decoded', async () => {
    const get = vi.fn()
    const app = new Hono().get('/', async (c) => {
      await enforceFileServingPolicy(c, btoa('capgo/uploads/bundle.zip/123e4567-e89b-42d3-a456-426614174000'))
      return c.text('admitted')
    })
    expect((await app.fetch(request('files.capgo.app', '/'), { PLUGIN_STATE_POINTERS: { get } })).status).toBe(503)
    expect(get).not.toHaveBeenCalled()
  })
})

describe('preview delivery depends on deselections', () => {
  it.each([
    { regions: [...SERVING_REGIONS], mode: 'route', status: 200 },
    { regions: [...SERVING_REGIONS], mode: 'block', status: 200 },
    { regions: ['NA'], mode: 'route', status: 503 },
    { regions: ['NA'], mode: 'block', status: 503 },
  ])('serves $regions with legacy $mode as $status', async ({ regions, mode, status }) => {
    const app = new Hono().get('*', async c => {
      await enforcePreviewServingPolicy(c)
      return c.text('preview admitted')
    })
    const get = vi.fn(async () => ({ json: async () => policy(previewApp, regions, mode) }))
    const result = await app.fetch(request('123-com-0example-0open.preview.capgo.app', '/', 'EWR'), { PLUGIN_STATE_POINTERS: { get } })
    expect(result.status).toBe(status)
  })
})
