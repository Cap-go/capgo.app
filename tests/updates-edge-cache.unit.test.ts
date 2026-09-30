import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeLocalTaggedKeys } from '../supabase/functions/_backend/plugin_runtime/utils/cache.ts'
import { createLazyPgClient, getLazyPgQueryCount } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { getCachedAppOwner, getCachedDefaultChannel, getUpdatesEdgeCacheBps, getUpdatesEdgeCacheTtlSeconds, isUpdatesEdgeCacheEnabled, shouldUseUpdatesEdgeCache, updatesAppCacheTag, updatesCacheTags, updatesEdgeCacheBucket } from '../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts'
import { chunk, parseAppIds, purgeUpdatesCacheTags, resetPurgeZoneCache, shouldForwardPurge } from '../supabase/functions/_backend/triggers/updates_cache_purge.ts'

function makeContext(env: Record<string, string> = {}) {
  const raw = new Request('https://plugin.capgo.test/updates', { method: 'POST' })
  return {
    env,
    req: { url: raw.url, raw, header: () => undefined },
    res: { headers: new Headers() },
    get: (key: string) => key === 'requestId' ? 'req-edge-cache' : undefined,
    set: () => {},
    header: () => {},
  } as any
}

/** In-memory Cache API stand-in that keeps the stored headers. */
function stubCaches() {
  const store = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response.clone())
    }),
    delete: vi.fn(async (request: Request) => store.delete(request.url)),
  }
  vi.stubGlobal('caches', { default: cache, open: vi.fn().mockResolvedValue(cache) })
  return { cache, store }
}

describe('updates edge cache', () => {
  beforeEach(() => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'mock-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('builds one lowercase, comma-free tag per app', () => {
    expect(updatesAppCacheTag('com.Example.App')).toBe('capgo-updates-com.example.app')
    expect(updatesAppCacheTag('com.example,app x')).toBe('capgo-updates-com.example_app_x')
  })

  it('is off unless UPDATES_EDGE_CACHE=on and clamps the TTL', () => {
    const c = makeContext()
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(false)
    expect(updatesCacheTags(c, 'com.example.app')).toBeUndefined()
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(true)
    expect(updatesCacheTags(c, 'com.example.app')).toEqual(['capgo-updates-com.example.app'])
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(300)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', '1')
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(10)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', '999999')
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(3600)
  })

  it('parses off, on and percentages', () => {
    const c = makeContext()
    const bps = (value: string) => {
      vi.stubEnv('UPDATES_EDGE_CACHE', value)
      return getUpdatesEdgeCacheBps(c)
    }
    expect(bps('off')).toBe(0)
    expect(bps('')).toBe(0)
    expect(bps('garbage')).toBe(0)
    expect(bps('on')).toBe(10_000)
    expect(bps('1%')).toBe(100)
    expect(bps('0.1')).toBe(10)
    expect(bps(' 25 % ')).toBe(2500)
    expect(bps('25%')).toBe(2500)
    expect(bps('250')).toBe(10_000)
    vi.stubEnv('UPDATES_EDGE_CACHE', '1%')
    // Any share turns tagging on so purges also clear the non-sampled path.
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(true)
  })

  it('stays off without a purge target, whatever UPDATES_EDGE_CACHE says', () => {
    const c = makeContext()
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    expect(getUpdatesEdgeCacheBps(c)).toBe(0)
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(false)
    expect(shouldUseUpdatesEdgeCache(makeContext(), 'com.example.app', 'device-1')).toBe(false)
    // Zone ids alone carry no credentials: still off.
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a,zone-b')
    expect(getUpdatesEdgeCacheBps(c)).toBe(0)
    // The token alone (deployed with the Cloudflare env file) is enough.
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', '')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    expect(getUpdatesEdgeCacheBps(c)).toBe(10_000)
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    vi.stubEnv('CF_ANALYTICS_TOKEN', 'analytics-token')
    expect(getUpdatesEdgeCacheBps(c)).toBe(10_000)
  })

  it('samples a stable ~1% of devices and remembers the choice per request', () => {
    vi.stubEnv('UPDATES_EDGE_CACHE', '1%')
    let sampled = 0
    for (let i = 0; i < 20_000; i++) {
      if (shouldUseUpdatesEdgeCache(makeContext(), 'com.example.app', `device-${i}`))
        sampled++
    }
    expect(sampled).toBeGreaterThan(120)
    expect(sampled).toBeLessThan(280)
    expect(updatesEdgeCacheBucket('com.example.app', 'device-1')).toBe(updatesEdgeCacheBucket('com.example.app', 'device-1'))

    const c = makeContext()
    const first = shouldUseUpdatesEdgeCache(c, 'com.example.app', 'device-42')
    vi.stubEnv('UPDATES_EDGE_CACHE', first ? 'off' : 'on')
    expect(shouldUseUpdatesEdgeCache(c, 'com.example.app', 'device-42')).toBe(first)
    vi.stubEnv('UPDATES_EDGE_CACHE', 'off')
    expect(shouldUseUpdatesEdgeCache(makeContext(), 'com.example.app', 'device-42')).toBe(false)
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    expect(shouldUseUpdatesEdgeCache(makeContext(), 'com.example.app', 'device-42')).toBe(true)
  })

  it('loads the owner once, then serves it from the cache with the app tag', async () => {
    const { store } = stubCaches()
    const c = makeContext()
    const load = vi.fn().mockResolvedValue({ owner_org: 'org-1', plan_valid: true })

    await expect(getCachedAppOwner(c, 'com.example.app', 'mau,bandwidth', load)).resolves.toEqual({ value: { owner_org: 'org-1', plan_valid: true }, hit: false })
    await expect(getCachedAppOwner(c, 'com.example.app', 'mau,bandwidth', load)).resolves.toEqual({ value: { owner_org: 'org-1', plan_valid: true }, hit: true })
    expect(load).toHaveBeenCalledTimes(1)

    const [stored] = [...store.values()]
    expect(stored.headers.get('Cache-Tag')).toBe('capgo-updates-com.example.app')
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=300')
  })

  it('caches a missing app for a shorter time', async () => {
    const { store } = stubCaches()
    const c = makeContext()
    const load = vi.fn().mockResolvedValue(null)

    await expect(getCachedAppOwner(c, 'com.missing.app', 'mau', load)).resolves.toEqual({ value: null, hit: false })
    await expect(getCachedAppOwner(c, 'com.missing.app', 'mau', load)).resolves.toEqual({ value: null, hit: true })
    expect(load).toHaveBeenCalledTimes(1)
    expect([...store.values()][0].headers.get('Cache-Control')).toBe('public, s-maxage=60')
  })

  it('never caches a failed read', async () => {
    const { cache } = stubCaches()
    const c = makeContext()
    const load = vi.fn().mockRejectedValue(new Error('replica down'))

    await expect(getCachedAppOwner(c, 'com.example.app', 'mau', load)).rejects.toThrow('replica down')
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('keys the default channel by platform, channel, mode and metadata', async () => {
    stubCaches()
    const c = makeContext()
    const load = vi.fn().mockResolvedValue({ channels: { id: 1 } })
    const key = { appId: 'com.example.app', platform: 'ios', defaultChannel: '', mode: 'standard' as const, includeMetadata: false }

    await getCachedDefaultChannel(c, key, load)
    await getCachedDefaultChannel(c, key, load)
    await getCachedDefaultChannel(c, { ...key, platform: 'android' }, load)
    await getCachedDefaultChannel(c, { ...key, defaultChannel: 'beta' }, load)
    await getCachedDefaultChannel(c, { ...key, mode: 'rollout' }, load)
    await getCachedDefaultChannel(c, { ...key, includeMetadata: true }, load)
    expect(load).toHaveBeenCalledTimes(5)
  })

  it('local purge deletes every entry of the tag', async () => {
    const { store } = stubCaches()
    const c = makeContext({ ENV_NAME: 'capgo_plugin-local' })
    const load = vi.fn().mockResolvedValue({ owner_org: 'org-1' })
    await getCachedAppOwner(c, 'com.purge.app', 'mau', load)
    await getCachedDefaultChannel(c, { appId: 'com.purge.app', platform: 'ios', defaultChannel: '', mode: 'standard', includeMetadata: false }, load)
    expect(store.size).toBe(2)

    await expect(purgeLocalTaggedKeys([updatesAppCacheTag('com.purge.app')])).resolves.toBe(2)
    expect(store.size).toBe(0)
    await getCachedAppOwner(c, 'com.purge.app', 'mau', load)
    expect(load).toHaveBeenCalledTimes(3)
  })
})

describe('lazy pg client', () => {
  it('does not connect until the first query and counts queries per request', async () => {
    const c = makeContext()
    const lazy = createLazyPgClient(c, true)
    expect(lazy.isConnected()).toBe(false)
    expect(getLazyPgQueryCount(c)).toBe(0)
    await lazy.close()
    expect(lazy.isConnected()).toBe(false)
  })
})

describe('updates cache purge trigger', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetPurgeZoneCache()
  })

  it('purges only the plugin zones among those the token sees, and caches the lookup', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', '')
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/zones?'))
        return new Response(JSON.stringify({ result: [{ id: 'zone-1', name: 'capgo.app' }, { id: 'zone-2', name: 'usecapgo.com' }, { id: 'zone-3', name: 'unrelated.example' }], result_info: { total_pages: 1 } }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ calls: 2, failed: 0 })
    await purgeUpdatesCacheTags(makeContext(), ['capgo-updates-b'])
    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls.filter(url => url.includes('/zones?'))).toHaveLength(1)
    expect(urls.filter(url => url.endsWith('/zones/zone-1/purge_cache'))).toHaveLength(2)
    expect(urls.filter(url => url.endsWith('/zones/zone-2/purge_cache'))).toHaveLength(2)
    // A token scoped to every zone still only purges the plugin's zones.
    expect(urls.filter(url => url.endsWith('/zones/zone-3/purge_cache'))).toHaveLength(0)
  })

  it('shares one zone lookup between concurrent purges', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', '')
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/zones?'))
        return new Response(JSON.stringify({ result: [{ id: 'zone-1', name: 'capgo.app' }], result_info: { total_pages: 1 } }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await Promise.all([
      purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a']),
      purgeUpdatesCacheTags(makeContext(), ['capgo-updates-b']),
      purgeUpdatesCacheTags(makeContext(), ['capgo-updates-c']),
    ])
    expect(fetchMock.mock.calls.filter(call => call[0].includes('/zones?'))).toHaveLength(1)
  })

  it('falls back to the existing analytics token', async () => {
    vi.stubEnv('CF_ANALYTICS_TOKEN', 'analytics-token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ calls: 1, failed: 0 })
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer analytics-token')
  })

  it('forwards to the Cloudflare API worker only when it has no token and was not forwarded already', () => {
    vi.stubEnv('CF_ANALYTICS_TOKEN', '')
    const c = makeContext()
    expect(shouldForwardPurge(c)).toBe(false)
    vi.stubEnv('CLOUDFLARE_FUNCTION_URL', 'https://api.capgo.test')
    expect(shouldForwardPurge(c)).toBe(true)
    const forwarded = { ...makeContext(), req: { ...makeContext().req, header: (name: string) => name === 'x-capgo-purge-forwarded' ? '1' : undefined } }
    expect(shouldForwardPurge(forwarded)).toBe(false)
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    expect(shouldForwardPurge(c)).toBe(false)
  })

  it('dedupes and bounds app ids', () => {
    expect(parseAppIds({ app_ids: ['a', 'a', '', 1, 'b'] })).toEqual(['a', 'b'])
    expect(parseAppIds({})).toEqual([])
    expect(parseAppIds({ app_ids: Array.from({ length: 1500 }, (_, i) => `app${i}`) })).toHaveLength(1000)
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('purges every zone in chunks of 100 tags', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a, zone-b')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tags = Array.from({ length: 150 }, (_, i) => `capgo-updates-app${i}`)

    await expect(purgeUpdatesCacheTags(makeContext(), tags)).resolves.toEqual({ calls: 4, failed: 0 })
    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls.filter(url => url.endsWith('/zones/zone-a/purge_cache'))).toHaveLength(2)
    expect(urls.filter(url => url.endsWith('/zones/zone-b/purge_cache'))).toHaveLength(2)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer token')
    expect(JSON.parse(init.body).tags).toHaveLength(100)
  })

  it('retries once on 429 and reports failures', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ calls: 1, failed: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does nothing when no purge target is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ calls: 0, failed: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
