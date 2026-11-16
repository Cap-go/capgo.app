import { app as updates } from '../supabase/functions/_backend/plugin_runtime/plugins/updates.ts'
import { app as stats } from '../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { app as channelSelf } from '../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts'
import { resetReplicationLagMemory, setReplicationLagMemoryEntry } from '../supabase/functions/_backend/plugin_runtime/utils/replicaFreshness.ts'
import { Hono } from 'hono'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/snippet/index.js'
import { CacheHelper } from '../supabase/functions/_backend/plugin_runtime/utils/cache.ts'
import { getDatabaseURL } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { enforceServingPolicy, signServingIngress } from '../supabase/functions/_backend/plugin_runtime/utils/servingPolicy.ts'
import { parseServingPolicy, SERVING_REGIONS } from '../supabase/functions/_backend/plugin_runtime/utils/servingRegions.ts'
import { createPluginStateSyncStore } from '../supabase/functions/_backend/triggers/plugin_state_sync.ts'
import { publicationProviders } from './plugin-state-publication-fixture.ts'

vi.mock('hono/adapter', async (original) => ({ ...await original<typeof import('hono/adapter')>(), getRuntimeKey: () => 'workerd' }))
const appId = 'com.example.serving'
const secret = 'local-serving-region-test-secret-32-characters'
function document(regions: string[] = [...SERVING_REGIONS], mode = 'route', generation = '1') {
  return { f: 1, app_id: appId, generation, policy: { regions, mode } }
}
function request(path = '/', colo = 'CDG', headers = {}) {
  const req = new Request('https://plugin.eu.capgo.app' + path, { headers: { 'cf-connecting-ip': '192.0.2.1', ...headers } })
  Object.defineProperty(req, 'cf', { value: { colo } })
  return req
}
function harness(value: () => unknown) {
  const dataAccess = vi.fn()
  const get = vi.fn(async () => ({ json: async () => value() }))
  const app = new Hono()
  app.get('/', async (c) => {
    await enforceServingPolicy(c, appId)
    dataAccess()
    return c.json({ url: getDatabaseURL(c, true), key: new CacheHelper(c).buildRequest('/cached').url })
  })
  app.get('/receipt', async c => c.json({ receipt: await signServingIngress(c, appId) }))
  const env = {
    ENV_NAME: 'capgo_plugin-eu-prod', PLUGIN_STATE_KV: 'off', SERVING_REGION_SIGNING_KEY: secret,
    PLUGIN_STATE_POINTERS: { get },
    HYPERDRIVE_CAPGO_READ_EU: { connectionString: 'postgres://eu' },
    HYPERDRIVE_CAPGO_READ_NA: { connectionString: 'postgres://na' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://forbidden-primary' },
  }
  return { app, env, get, dataAccess }
}

beforeEach(() => vi.stubEnv('ENV_NAME', 'capgo_plugin-eu-prod'))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetReplicationLagMemory() })

describe('serving policy', () => {
  it.each([
    ['POST', '/updates'], ['POST', '/updates/manifest_size'], ['POST', '/plugin/updates'],
    ['POST', '/stats'], ['POST', '/plugin/stats'], ['POST', '/channel_self'],
    ['PUT', '/channel_self'], ['GET', '/channel_self'], ['DELETE', '/channel_self'],
  ])('gates shared %s %s before app-cache or database access', async (method, path) => {
    const app = new Hono()
    app.route('/updates', updates)
    app.route('/plugin/updates', updates)
    app.route('/stats', stats)
    app.route('/plugin/stats', stats)
    app.route('/channel_self', channelSelf)
    const match = vi.fn()
    vi.stubGlobal('caches', { default: { match } })
    const get = vi.fn(async () => null)
    const body = { app_id: appId, device_id: '00000000-0000-4000-8000-000000000001', channel: 'production',
      platform: 'ios', version_name: '1.0.0', version_build: '1.0.0', version_os: '18',
      plugin_version: '8.35.0', is_prod: true, is_emulator: false, action: 'ping' }
    const query = new URLSearchParams(Object.fromEntries(Object.entries(body).map(([key, value]) => [key, String(value)])))
    const req = new Request('https://plugin.eu.capgo.app' + path + ((method === 'GET' || method === 'DELETE') ? '?' + query : ''), {
      method, headers: { 'content-type': 'application/json' },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body),
    })
    expect((await app.fetch(req, { PLUGIN_STATE_POINTERS: { get }, PLUGIN_STATE_KV: 'off' })).status).toBe(503)
    expect(get).toHaveBeenCalledTimes(1)
    expect(match).not.toHaveBeenCalled()
  })

  it('defaults only absent legacy fields and rejects supplied malformed policies', () => {
    expect(parseServingPolicy(undefined, undefined)).toEqual({ regions: SERVING_REGIONS, mode: 'route' })
    for (const value of [null, [], ['EU', 'EU'], ['UNSUPPORTED'], 'EU'])
      expect(() => parseServingPolicy(value, 'route')).toThrow()
    expect(() => parseServingPolicy(['EU'], null)).toThrow()
  })

  it('tightens before warm cache/data access with the KV canary off', async () => {
    let doc = document()
    const { app, env, dataAccess, get } = harness(() => doc)
    expect((await app.fetch(request(), env)).status).toBe(200)
    doc = document(['NA'], 'block', '2')
    const blocked = await app.fetch(request(), env)
    expect(blocked.status).toBe(403)
    expect(dataAccess).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('routes a request on a disabled Worker region to an allowed DB binding and cache partition', async () => {
    const { app, env } = harness(() => document(['NA']))
    Object.defineProperty(env, 'HYPERDRIVE_CAPGO_READ_EU', { get: () => { throw new Error('Forbidden replica selected') } })
    Object.defineProperty(env, 'HYPERDRIVE_CAPGO_DIRECT_EU', { get: () => { throw new Error('Forbidden primary selected') } })
    const response = await app.fetch(request(), env)
    expect(await response.json()).toEqual({ url: 'postgres://na', key: 'https://plugin.eu.capgo.app/cached?serving_regions=NA' })
  })

  it.each([null, { ...document(), policy: { regions: null, mode: 'route' } }])('fails closed before data for unavailable/invalid policy %j', async (doc) => {
    const { app, env, dataAccess } = harness(() => doc)
    expect((await app.fetch(request(), env)).status).toBe(503)
    expect(dataAccess).not.toHaveBeenCalled()
  })

  it('does not escape to EU during lag and chooses another allowed replica', async () => {
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_NA', { status: 'lagging', max_lag_seconds: 2400 })
    const { app, env } = harness(() => document(['NA', 'HK']))
    const withHk = { ...env, HYPERDRIVE_CAPGO_READ_HK: { connectionString: 'postgres://hk' } }
    const result = await (await app.fetch(request(), withHk)).json()
    assert(result && typeof result === 'object' && 'url' in result)
    expect(result.url).toBe('postgres://hk')
    expect((await app.fetch(request(), env)).status).toBe(503)
  })

  it('never falls back to EU/primary when the only allowed replica binding is absent', async () => {
    const { app, env } = harness(() => document(['HK']))
    expect((await app.fetch(request(), env)).status).toBe(503)
  })

  it('rejects spoofed ingress and accepts only signed matching app receipts', async () => {
    const { app, env, dataAccess } = harness(() => document(['NA'], 'block'))
    expect((await app.fetch(request('/', 'CDG', { 'X-Region': 'NA', 'x-capgo-serving-ingress': 'fake' }), env)).status).toBe(503)
    expect(dataAccess).not.toHaveBeenCalled()
    const signed = await (await app.fetch(request('/receipt', 'IAD'), env)).json()
    assert(signed && typeof signed === 'object' && 'receipt' in signed && typeof signed.receipt === 'string')
    const { receipt } = signed
    expect((await app.fetch(request('/', 'CDG', { 'x-capgo-serving-ingress': receipt }), env)).status).toBe(200)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000)
    expect((await app.fetch(request('/', 'CDG', { 'x-capgo-serving-ingress': receipt }), env)).status).toBe(503)
    vi.restoreAllMocks()
    const tampered = receipt.replace('NA', 'EU')
    expect((await app.fetch(request('/', 'CDG', { 'x-capgo-serving-ingress': tampered }), env)).status).toBe(503)
  })

  it('fences an old publisher and requires ingress readiness before restricting', async () => {
    const providers = publicationProviders()
    const old = createPluginStateSyncStore(providers.namespace, providers.pointers, '1')
    const latest = createPluginStateSyncStore(providers.namespace, providers.pointers, '2')
    await expect(latest.publishServingPolicy(appId, ['NA'], 'route')).rejects.toThrow('ready')
    providers.objects.set('sr1:ready', { body: '{"f":1}', etag: 'ready' })
    await latest.publishServingPolicy(appId, ['NA'], 'route')
    await old.publishServingPolicy(appId, ['EU'], 'route')
    expect(JSON.parse(providers.objects.get('sr1:' + appId)!.body).policy.regions).toEqual(['NA'])
    expect(providers.namespace.get).not.toHaveBeenCalled()
  })

  it('blocks before any snippet cache or backend call after tightening', async () => {
    const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() }
    vi.stubGlobal('caches', { default: cache })
    const fetcher = vi.fn(async () => Response.json({ ...document(['NA'], 'block'), receipt: 'signed' }))
    vi.stubGlobal('fetch', fetcher)
    const req = new Request('https://plugin.capgo.app/stats', { method: 'POST', body: JSON.stringify({ app_id: appId, device_id: 'device', action: 'ping' }) })
    Object.defineProperty(req, 'cf', { value: { colo: 'CDG' } })
    expect((await snippet.fetch(req)).status).toBe(403)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(cache.match).not.toHaveBeenCalled()
  })

  it('filters every snippet retry and never uses original origin, staying under five subrequests', async () => {
    const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() }
    vi.stubGlobal('caches', { default: cache })
    const targets: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: Request | string) => {
      const url = typeof input === 'string' ? input : input.url
      targets.push(url)
      return url.includes('/serving_policy/') ? Response.json({ ...document(['NA']), receipt: 'signed' }) : Response.json({ error: 'offline' }, { status: 503 })
    }))
    const req = new Request('https://plugin.capgo.app/updates', { method: 'POST', body: JSON.stringify({ app_id: appId }) })
    Object.defineProperty(req, 'cf', { value: { colo: 'CDG' } })
    expect((await snippet.fetch(req)).status).toBe(503)
    expect(targets.slice(1).every(url => url.startsWith('https://plugin.na.capgo.app/'))).toBe(true)
    expect(targets.length).toBeGreaterThan(1)
    expect(targets.length + cache.match.mock.calls.length + cache.put.mock.calls.length + cache.delete.mock.calls.length).toBeLessThanOrEqual(5)
  })
})
