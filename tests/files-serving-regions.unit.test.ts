import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import files from '../cloudflare_workers/files/index.ts'
import { SERVING_REGIONS } from '../supabase/functions/_backend/plugin_runtime/utils/servingRegions.ts'

const rollout = vi.hoisted(() => ({ epoch: 'test-delivery-epoch' as string | null }))
vi.mock('../supabase/functions/_backend/plugin_runtime/utils/servingRegionRollout.js', () => ({ get servingRegionReaderEpoch() { return rollout.epoch } }))
vi.mock('cloudflare:workers', () => ({ WorkerEntrypoint: class {}, DurableObject: class {} }))
// The inner handler represents an already warm managed cache. The actual
// default entrypoint must deny it before invoking this data-serving layer.
vi.mock('../supabase/functions/_backend/files/files.ts', () => ({ app: new Hono().get('*', c => c.text('uncached bundle')) }))
vi.mock('../supabase/functions/_backend/files/preview.ts', () => ({
  isPreviewSubdomain: (hostname: string) => hostname.endsWith('.preview.capgo.app'),
  handlePreviewSubdomain: vi.fn(),
  withPreviewHostHeaders: (_request: Request, response: Response) => response,
}))

const appId = 'com.example.delivery'
const path = `orgs/example-org/apps/${appId}/bundle.zip`
function request(host: string, prefix = '/files/read/attachments/', colo = 'CDG', key = path, method = 'GET') {
  const req = new Request(`https://${host}${prefix}${key}?app_id=com.example.other`, { method })
  Object.defineProperty(req, 'cf', { value: { colo } })
  return req
}
function fixture() {
  let regions = [...SERVING_REGIONS]
  const get = vi.fn(async () => ({ json: async () => ({ f: 1, app_id: appId, generation: '1', policy: { regions, mode: 'route' } }) }))
  const fetch = vi.fn(async () => new Response('warm bundle', { headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } }))
  const env = { PLUGIN_STATE_POINTERS: { get } }
  const ctx = { props: {}, exports: { CachedFiles: { fetch } }, waitUntil: vi.fn(), passThroughOnException: vi.fn() }
  return { get, fetch, env, ctx, deselectEurope: () => { regions = regions.filter(region => region !== 'EU') } }
}

afterEach(() => { rollout.epoch = 'test-delivery-epoch'; vi.restoreAllMocks() })

describe('bundle delivery policy before managed caches', () => {
  it.each(['files.capgo.app', 'api.capgo.app', 'plugin.eu.capgo.app', 'plugin.na.capgo.app', 'updates.example.com'])(
    'denies a previously cached URL on %s immediately after deselection', async (host) => {
      const f = fixture()
      expect((await files.fetch(request(host), f.env, f.ctx)).status).toBe(200)
      f.deselectEurope()
      const denied = await files.fetch(request(host), f.env, f.ctx)
      expect(denied.status).toBe(403)
      expect(await denied.text()).not.toContain('bundle')
      expect(f.fetch).toHaveBeenCalledTimes(1)
      expect(f.get).toHaveBeenCalledTimes(2)
    },
  )
  it.each(['/files/read/attachments/', '/private/files/read/attachments/'])('gates the %s alias', async (prefix) => {
    const f = fixture()
    f.deselectEurope()
    expect((await files.fetch(request('updates.example.com', prefix), f.env, f.ctx)).status).toBe(403)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not serve an old warm URL when policy is unavailable', async () => {
    const f = fixture()
    f.get.mockRejectedValue(new Error('Synthetic unavailable policy'))
    expect((await files.fetch(request('files.capgo.app'), f.env, f.ctx)).status).toBe(503)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('does not allow an unscoped old key to guess an app from a query parameter', async () => {
    const f = fixture()
    expect((await files.fetch(request('files.capgo.app', undefined, 'CDG', 'legacy.zip'), f.env, f.ctx)).status).toBe(503)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  const colos = { EU: 'CDG', NA: 'EWR', SA: 'GRU', OC: 'SYD', AS_INDIA: 'BOM', AS_JAPAN: 'NRT', HK: 'HKG', AF: 'JNB', ME: 'DXB' }
  it.each(SERVING_REGIONS)('allows selected %s then denies its old URL after deselection', async (region) => {
    const f = fixture()
    const req = () => request('updates.example.com', undefined, colos[region])
    const allowed = await files.fetch(req(), f.env, f.ctx)
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('cache-control')).toContain('no-store')
    f.get.mockResolvedValue({ json: async () => ({ f: 1, app_id: appId, generation: '2', policy: { regions: SERVING_REGIONS.filter(item => item !== region), mode: 'route' } }) })
    expect((await files.fetch(req(), f.env, f.ctx)).status).toBe(403)
    expect(f.fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['HEAD', 'GET'])('gates %s and range downloads before any inner handler', async (method) => {
    const f = fixture()
    f.deselectEurope()
    const req = request('updates.example.com', undefined, 'CDG', path, method)
    req.headers.set('range', 'bytes=0-15')
    expect((await files.fetch(req, f.env, f.ctx)).status).toBe(403)
    expect(f.fetch).not.toHaveBeenCalled()
  })
  it('fails unavailable on unknown ingress and restores access only after a new policy read', async () => {
    const f = fixture()
    f.deselectEurope()
    expect((await files.fetch(request('files.capgo.app', undefined, 'UNKNOWN'), f.env, f.ctx)).status).toBe(503)
    expect(f.fetch).not.toHaveBeenCalled()
    f.get.mockResolvedValue({ json: async () => ({ f: 1, app_id: appId, generation: '3', policy: { regions: [...SERVING_REGIONS], mode: 'route' } }) })
    expect((await files.fetch(request('files.capgo.app'), f.env, f.ctx)).status).toBe(200)
  })
  it('retains legacy cache behavior with zero policy reads in the disabled build', async () => {
    rollout.epoch = null
    const f = fixture()
    const response = await files.fetch(request('files.capgo.app'), f.env, f.ctx)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(f.get).not.toHaveBeenCalled()
  })

  it('denies old public preview URLs before their managed byte cache', async () => {
    const f = fixture()
    f.deselectEurope()
    const req = request('123-com-0example-0delivery.preview.capgo.app', '/', 'CDG', 'index.html')
    expect((await files.fetch(req, f.env, f.ctx)).status).toBe(403)
    expect(f.fetch).not.toHaveBeenCalled()
    // Even an allowed device cannot reach preview's unrestricted DB lane.
    const allowedRegion = request('123-com-0example-0delivery.preview.capgo.app', '/', 'EWR', 'index.html')
    expect((await files.fetch(allowedRegion, f.env, f.ctx)).status).toBe(503)
    expect(f.fetch).not.toHaveBeenCalled()
  })

})
