import { Hono } from 'hono/tiny'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app as cacheInvalidateFanout, parsePluginInvalidateUrls } from '../supabase/functions/_backend/triggers/cache_invalidate.ts'
import { app as cacheInvalidateRoute } from '../supabase/functions/_backend/private/cache_invalidate.ts'
import { bumpAppCacheToken, cachedGetAppOwner, cachedRequestInfos, isUpdatesCacheEnabled } from '../supabase/functions/_backend/utils/updates_colo_cache.ts'

type CacheKey = Request | string

function cacheKeyToString(key: CacheKey) {
  return typeof key === 'string' ? key : key.url
}

function createMemoryCache() {
  const store = new Map<string, Response>()
  return {
    store,
    match: vi.fn(async (key: CacheKey) => store.get(cacheKeyToString(key))?.clone()),
    put: vi.fn(async (key: CacheKey, response: Response) => {
      store.set(cacheKeyToString(key), response.clone())
    }),
    delete: vi.fn(async (key: CacheKey) => store.delete(cacheKeyToString(key))),
  }
}

const APP_OWNER = {
  owner_org: 'org-1',
  plan_valid: true,
  channel_device_count: 0,
  manifest_bundle_count: 0,
  rollout_channel_count: 0,
  rollout_paused_version_names: [] as string[],
  expose_metadata: false,
  allow_device_custom_id: true,
  block_provider_infra_requests: false,
  orgs: { created_by: 'user-1', id: 'org-1', management_email: 'a@b.c' },
}

const CHANNEL_ROW = {
  version: { id: 42, name: '1.2.3', checksum: 'abc', storage_provider: 'r2', manifest_count: 0, r2_path: 'p.zip', external_url: null, min_update_version: null, session_key: null, key_id: null },
  channels: { id: 7, name: 'production', app_id: 'com.demo.app', ios: true, android: true, public: true, allow_device_self_set: false },
}

// The pg loaders are stubbed: these tests exercise the cache semantics, not
// the SQL (covered by the existing update tests with the flag off).
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getAppOwnerPostgres: vi.fn(async () => structuredClone(APP_OWNER)),
  requestInfosChannelPostgres: vi.fn(async () => structuredClone(CHANNEL_ROW)),
  requestInfosChannelPostgresRollout: vi.fn(async () => structuredClone(CHANNEL_ROW)),
  requestInfosChannelDevicePostgres: vi.fn(async () => null),
  requestInfosChannelDevicePostgresRollout: vi.fn(async () => null),
  requestInfosChannelByIdPostgres: vi.fn(async () => structuredClone(CHANNEL_ROW)),
  requestInfosChannelByIdPostgresRollout: vi.fn(async () => structuredClone(CHANNEL_ROW)),
  requestManifestEntriesPostgres: vi.fn(async () => []),
}))

const pg = await import('../supabase/functions/_backend/utils/pg.ts')

function makeContext() {
  return {
    env: {},
    get: () => 'test-request',
    set: () => {},
    header: () => {},
    req: { url: 'https://plugin.capgo.app/updates', raw: new Request('https://plugin.capgo.app/updates') },
    res: { headers: new Headers() },
  } as any
}

describe('updates colo cache', () => {
  let cache: ReturnType<typeof createMemoryCache>

  beforeEach(() => {
    cache = createMemoryCache()
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    vi.stubEnv('UPDATES_CACHE_MODE', 'on')
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('is gated by UPDATES_CACHE_MODE', () => {
    expect(isUpdatesCacheEnabled(makeContext())).toBe(true)
    vi.stubEnv('UPDATES_CACHE_MODE', 'off')
    expect(isUpdatesCacheEnabled(makeContext())).toBe(false)
  })

  it('caches app owner: one loader call for repeated reads', async () => {
    const c = makeContext()
    const first = await cachedGetAppOwner(c, 'com.demo.app', {} as any, ['mau'])
    const second = await cachedGetAppOwner(c, 'com.demo.app', {} as any, ['mau'])
    expect(first?.owner_org).toBe('org-1')
    expect(second?.owner_org).toBe('org-1')
    expect(pg.getAppOwnerPostgres).toHaveBeenCalledTimes(1)
  })

  it('caches negative owner results (unknown app)', async () => {
    ;(pg.getAppOwnerPostgres as any).mockResolvedValueOnce(null)
    const c = makeContext()
    expect(await cachedGetAppOwner(c, 'com.ghost.app', {} as any, ['mau'])).toBeNull()
    expect(await cachedGetAppOwner(c, 'com.ghost.app', {} as any, ['mau'])).toBeNull()
    expect(pg.getAppOwnerPostgres).toHaveBeenCalledTimes(1)
  })

  it('token bump invalidates every cached payload of the app', async () => {
    const c = makeContext()
    await cachedGetAppOwner(c, 'com.demo.app', {} as any, ['mau'])
    expect(await bumpAppCacheToken(c, 'com.demo.app')).toBe(true)
    await cachedGetAppOwner(c, 'com.demo.app', {} as any, ['mau'])
    expect(pg.getAppOwnerPostgres).toHaveBeenCalledTimes(2)
  })

  it('caches the channel lookup but never the per-device override', async () => {
    const c = makeContext()
    const options = {
      c,
      platform: 'ios',
      app_id: 'com.demo.app',
      device_id: 'device-1',
      defaultChannel: '',
      drizzleClient: {} as any,
      channelDeviceCount: 1,
      manifestBundleCount: 0,
      rolloutChannelCount: 0,
      rolloutPausedVersionNames: [],
      currentVersionName: '1.0.0',
    }
    const first = await cachedRequestInfos(options)
    const second = await cachedRequestInfos({ ...options, device_id: 'device-2' })
    expect(first.channelData.channels.name).toBe('production')
    expect(second.channelData.channels.name).toBe('production')
    expect(pg.requestInfosChannelPostgres).toHaveBeenCalledTimes(1)
    // override lookup runs per device, uncached
    expect(pg.requestInfosChannelDevicePostgres).toHaveBeenCalledTimes(2)
  })

  it('skips the override lookup entirely when the app has no overrides', async () => {
    const c = makeContext()
    const result = await cachedRequestInfos({
      c,
      platform: 'ios',
      app_id: 'com.demo.app',
      device_id: 'device-1',
      defaultChannel: '',
      drizzleClient: {} as any,
      channelDeviceCount: 0,
      manifestBundleCount: 0,
      rolloutChannelCount: 0,
      rolloutPausedVersionNames: [],
      currentVersionName: '1.0.0',
    })
    expect(result.channelOverride).toBeNull()
    expect(pg.requestInfosChannelDevicePostgres).not.toHaveBeenCalled()
  })

  it('caches null channel results without breaking the miss path', async () => {
    ;(pg.requestInfosChannelPostgres as any).mockResolvedValueOnce(null)
    const c = makeContext()
    const options = {
      c,
      platform: 'ios',
      app_id: 'com.demo.app',
      device_id: 'device-1',
      defaultChannel: '',
      drizzleClient: {} as any,
      channelDeviceCount: 0,
      manifestBundleCount: 0,
      rolloutChannelCount: 0,
      rolloutPausedVersionNames: [],
      currentVersionName: '1.0.0',
    }
    const first = await cachedRequestInfos(options)
    const second = await cachedRequestInfos(options)
    expect(first.channelData ?? null).toBeNull()
    expect(second.channelData ?? null).toBeNull()
    expect(pg.requestInfosChannelPostgres).toHaveBeenCalledTimes(1)
  })

  it('separates cache entries per platform and defaultChannel', async () => {
    const c = makeContext()
    const base = {
      c,
      app_id: 'com.demo.app',
      device_id: 'device-1',
      drizzleClient: {} as any,
      channelDeviceCount: 0,
      manifestBundleCount: 0,
      rolloutChannelCount: 0,
      rolloutPausedVersionNames: [],
      currentVersionName: '1.0.0',
    }
    await cachedRequestInfos({ ...base, platform: 'ios', defaultChannel: '' })
    await cachedRequestInfos({ ...base, platform: 'android', defaultChannel: '' })
    await cachedRequestInfos({ ...base, platform: 'ios', defaultChannel: 'beta' })
    expect(pg.requestInfosChannelPostgres).toHaveBeenCalledTimes(3)
  })

  it('rollout path decides per device on top of the cached channel row', async () => {
    ;(pg.requestInfosChannelPostgresRollout as any).mockResolvedValue({
      ...structuredClone(CHANNEL_ROW),
      rolloutVersion: { id: 43, name: '1.2.4', manifest_count: 0 },
      channels: { ...structuredClone(CHANNEL_ROW.channels), rollout_version: 43, rollout_enabled: true, rollout_percentage_bps: 10000, rollout_id: 'r-1', rollout_paused_at: null, rollout_cache_ttl_seconds: 2592000 },
    })
    const c = makeContext()
    const options = {
      c,
      platform: 'ios',
      app_id: 'com.demo.app',
      device_id: 'device-1',
      defaultChannel: '',
      drizzleClient: {} as any,
      channelDeviceCount: 0,
      manifestBundleCount: 0,
      rolloutChannelCount: 1,
      rolloutPausedVersionNames: [],
      currentVersionName: '1.0.0',
    }
    const first = await cachedRequestInfos(options)
    const second = await cachedRequestInfos({ ...options, device_id: 'device-2' })
    // 100% rollout: both devices land on the rollout version
    expect(first.channelData.version.name).toBe('1.2.4')
    expect(second.channelData.version.name).toBe('1.2.4')
    // channel row cached once, decision computed per device
    expect(pg.requestInfosChannelPostgresRollout).toHaveBeenCalledTimes(1)
  })
})

describe('cache invalidate route (plugin worker)', () => {
  let cache: ReturnType<typeof createMemoryCache>

  function buildApp() {
    const app = new Hono()
    app.route('/cache_invalidate', cacheInvalidateRoute)
    return app
  }

  beforeEach(() => {
    cache = createMemoryCache()
    vi.stubGlobal('caches', { open: vi.fn(async () => cache) })
    vi.stubEnv('CACHE_INVALIDATE_SECRET', 's3cret')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('rejects when the secret is missing or wrong', async () => {
    const app = buildApp()
    const wrong = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'x-cache-invalidate-secret': 'nope', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app'] }),
    })
    expect(wrong.status).toBe(401)

    vi.unstubAllEnvs()
    const disabled = await buildApp().request('/cache_invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app'] }),
    })
    expect(disabled.status).toBe(503)
  })

  it('bumps tokens for each app', async () => {
    const app = buildApp()
    const response = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'x-cache-invalidate-secret': 's3cret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app', 'com.other.app'] }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ bumped: 2 })
    expect(cache.put).toHaveBeenCalledTimes(2)
  })

  it('rejects empty app_ids', async () => {
    const app = buildApp()
    const response = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'x-cache-invalidate-secret': 's3cret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: [] }),
    })
    expect(response.status).toBe(400)
  })
})

describe('cache invalidate fanout (triggers)', () => {
  function buildApp() {
    const app = new Hono()
    app.route('/cache_invalidate', cacheInvalidateFanout)
    return app
  }

  function stubFullEnv() {
    vi.stubEnv('API_SECRET', 'api-secret')
    vi.stubEnv('PLUGIN_INVALIDATE_URLS', 'https://plugin.eu.capgo.app, https://plugin.na.capgo.app/')
    vi.stubEnv('CACHE_INVALIDATE_SECRET', 's3cret')
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('parses and normalizes the regional url list', () => {
    expect(parsePluginInvalidateUrls('https://a.com, https://b.com/ ,')).toEqual(['https://a.com', 'https://b.com'])
  })

  it('fans out one call per regional worker with the shared secret', async () => {
    stubFullEnv()
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()
    const response = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'apisecret': 'api-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app'] }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ regions: 2, succeeded: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[0] as any
    expect(url).toBe('https://plugin.eu.capgo.app/cache_invalidate')
    expect(init.headers['x-cache-invalidate-secret']).toBe('s3cret')
    expect(JSON.parse(init.body)).toEqual({ app_ids: ['com.demo.app'] })
  })

  it('soft-skips when env is missing (TTL is the backstop)', async () => {
    vi.stubEnv('API_SECRET', 'api-secret')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const app = buildApp()
    const response = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'apisecret': 'api-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app'] }),
    })
    expect(response.status).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects without the api secret', async () => {
    stubFullEnv()
    const app = buildApp()
    const response = await app.request('/cache_invalidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_ids: ['com.demo.app'] }),
    })
    expect(response.status).toBe(400)
  })
})
