import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { purgeLocalTaggedKeys } from '../supabase/functions/_backend/plugin_runtime/utils/cache.ts'
import { createLazyPgClient, getDrizzleClient, getEffectiveDeviceChannelNamePostgres, getLazyPgQueryCount, isLazyPgConnectError } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { getAppOwnerWithEdgeCache, getAppVersionWithEdgeCache, getChannelByNameWithEdgeCache, getCompatibleChannelsWithEdgeCache } from '../supabase/functions/_backend/plugin_runtime/utils/pluginEdgeCacheReads.ts'
import { updatesCacheTagForScope } from '../supabase/functions/_backend/plugin_runtime/utils/updatesCacheTag.ts'
import { getCachedAppOwner, getCachedAppVersion, getCachedChannelLookup, getCachedDefaultChannel, getUpdatesEdgeCacheBps, getUpdatesEdgeCacheTtlSeconds, isUpdatesEdgeCacheEnabled, planValidityTtlCapSeconds, shouldUseUpdatesEdgeCache, updatesAppCacheTag, updatesCacheTags, updatesEdgeCacheBucket, updatesVersionsCacheTag } from '../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts'
import { chunk, drainUpdatesCachePurge, purgeUpdatesCacheTags, resetPurgeZoneCache, shouldForwardPurge } from '../supabase/functions/_backend/triggers/updates_cache_purge.ts'

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

  it('builds a separate versions tag and maps purge scopes to tags', () => {
    expect(updatesVersionsCacheTag('com.Example.App')).toBe('capgo-updates-com.example.app-versions')
    expect(updatesCacheTagForScope('com.example.app', 'versions')).toBe('capgo-updates-com.example.app-versions')
    expect(updatesCacheTagForScope('com.example.app', 'app')).toBe('capgo-updates-com.example.app')
    // Rows claimed before the scope column existed purge the main tag.
    expect(updatesCacheTagForScope('com.example.app', undefined)).toBe('capgo-updates-com.example.app')
    expect(updatesCacheTagForScope('com.example.app', 'unknown')).toBe('capgo-updates-com.example.app')
  })

  it('is off unless UPDATES_EDGE_CACHE=on and clamps the TTL', () => {
    const c = makeContext()
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(false)
    expect(updatesCacheTags(c, 'com.example.app')).toBeUndefined()
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(true)
    expect(updatesCacheTags(c, 'com.example.app')).toEqual(['capgo-updates-com.example.app'])
    // Purges are proven: one hour by default, up to a day.
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(3600)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', '1')
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(10)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', '300')
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(300)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', '999999')
    expect(getUpdatesEdgeCacheTtlSeconds(c)).toBe(86400)
    vi.stubEnv('UPDATES_EDGE_CACHE_TTL_SECONDS', 'garbage')
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
    // Malformed values stay off instead of taking a numeric prefix.
    expect(bps('1abc')).toBe(0)
    expect(bps('5%%')).toBe(0)
    vi.stubEnv('UPDATES_EDGE_CACHE', '1%')
    // Any share turns tagging on so purges also clear the non-sampled path.
    expect(isUpdatesEdgeCacheEnabled(c)).toBe(true)
  })

  it('stays off without a purge target, whatever UPDATES_EDGE_CACHE says', () => {
    const c = makeContext()
    vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    vi.stubEnv('CF_ANALYTICS_TOKEN', '')
    vi.stubEnv('UPDATES_CACHE_LOCAL_PURGE_URL', '')
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
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=3600')
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

  it('caches bundle-name lookups under the versions tag, missing bundles for a shorter time', async () => {
    const { store } = stubCaches()
    const c = makeContext()
    const load = vi.fn().mockResolvedValue({ id: 7, owner_org: 'org-1' })
    const missing = vi.fn().mockResolvedValue(null)

    await expect(getCachedAppVersion(c, 'com.example.app', '1.0.0', load)).resolves.toEqual({ value: { id: 7, owner_org: 'org-1' }, hit: false })
    await expect(getCachedAppVersion(c, 'com.example.app', '1.0.0', load)).resolves.toEqual({ value: { id: 7, owner_org: 'org-1' }, hit: true })
    await expect(getCachedAppVersion(c, 'com.example.app', '9.9.9', missing)).resolves.toEqual({ value: null, hit: false })
    await expect(getCachedAppVersion(c, 'com.example.app', '9.9.9', missing)).resolves.toEqual({ value: null, hit: true })
    expect(load).toHaveBeenCalledTimes(1)
    expect(missing).toHaveBeenCalledTimes(1)
    const entries = [...store.values()]
    expect(entries.map(entry => entry.headers.get('Cache-Tag'))).toEqual(['capgo-updates-com.example.app-versions', 'capgo-updates-com.example.app-versions'])
    expect(entries.map(entry => entry.headers.get('Cache-Control'))).toEqual(['public, s-maxage=3600', 'public, s-maxage=60'])
  })

  it('keys channel lookups by lookup kind and inputs, under the app tag', async () => {
    const { store } = stubCaches()
    const c = makeContext()
    const load = vi.fn().mockResolvedValue({ id: 1, name: 'production' })

    await getCachedChannelLookup(c, 'com.example.app', 'by_name', { name: 'production' }, load)
    await getCachedChannelLookup(c, 'com.example.app', 'by_name', { name: 'production' }, load)
    await getCachedChannelLookup(c, 'com.example.app', 'by_name', { name: 'beta' }, load)
    await getCachedChannelLookup(c, 'com.example.app', 'effective_by_name', { name: 'production', platform: 'ios' }, load)
    await getCachedChannelLookup(c, 'com.example.app', 'effective_by_name', { name: 'production', platform: 'android' }, load)
    await getCachedChannelLookup(c, 'com.other.app', 'by_name', { name: 'production' }, load)
    expect(load).toHaveBeenCalledTimes(5)
    expect(new Set([...store.values()].map(entry => entry.headers.get('Cache-Tag')))).toEqual(new Set(['capgo-updates-com.example.app', 'capgo-updates-com.other.app']))
  })

  it('purging one tag of an app keeps the entries of its other tag', async () => {
    const { store } = stubCaches()
    const c = makeContext({ ENV_NAME: 'capgo_plugin-local' })
    const owner = vi.fn().mockResolvedValue({ owner_org: 'org-1' })
    const version = vi.fn().mockResolvedValue({ id: 3, owner_org: 'org-1' })
    await getCachedAppOwner(c, 'com.scope.app', 'mau', owner)
    await getCachedAppVersion(c, 'com.scope.app', '1.0.0', version)
    expect(store.size).toBe(2)

    // An upload (versions scope) leaves the owner and /updates entries alone.
    await expect(purgeLocalTaggedKeys([updatesVersionsCacheTag('com.scope.app')])).resolves.toBe(1)
    await getCachedAppOwner(c, 'com.scope.app', 'mau', owner)
    expect(owner).toHaveBeenCalledTimes(1)
    await getCachedAppVersion(c, 'com.scope.app', '1.0.0', version)
    expect(version).toHaveBeenCalledTimes(2)

    // A channel or plan change (app scope) leaves bundle-name lookups alone.
    await expect(purgeLocalTaggedKeys([updatesAppCacheTag('com.scope.app')])).resolves.toBe(1)
    await getCachedAppVersion(c, 'com.scope.app', '1.0.0', version)
    expect(version).toHaveBeenCalledTimes(2)
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

    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toMatchObject({ calls: 2, failed: 0 })
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
    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toMatchObject({ calls: 1, failed: 0 })
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

  it('chunks tags', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('purges every zone in chunks of 100 tags', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a, zone-b')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const tags = Array.from({ length: 150 }, (_, i) => `capgo-updates-app${i}`)

    await expect(purgeUpdatesCacheTags(makeContext(), tags)).resolves.toMatchObject({ calls: 4, failed: 0 })
    const urls = fetchMock.mock.calls.map(call => call[0])
    expect(urls.filter(url => url.endsWith('/zones/zone-a/purge_cache'))).toHaveLength(2)
    expect(urls.filter(url => url.endsWith('/zones/zone-b/purge_cache'))).toHaveLength(2)
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer token')
    expect(JSON.parse(init.body).tags).toHaveLength(100)
  })

  it('does not retry in the worker and reports Retry-After for requeuing', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ configured: true, calls: 1, failed: 1, retryAfterSeconds: 7 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('treats a token with no discoverable plugin zone as a failure to retry', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', '')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toMatchObject({ configured: true, calls: 0, failed: 1, retryAfterSeconds: 30 })
  })

  it('does nothing when no purge target is configured', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    vi.stubEnv('CF_ANALYTICS_TOKEN', '')
    vi.stubEnv('UPDATES_CACHE_LOCAL_PURGE_URL', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(purgeUpdatesCacheTags(makeContext(), ['capgo-updates-a'])).resolves.toEqual({ configured: false, calls: 0, failed: 0, retryAfterSeconds: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('updates cache purge drain', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetPurgeZoneCache()
  })

  function rpcFrom(claims: unknown[]) {
    const calls: { fn: string, args: Record<string, unknown> }[] = []
    const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (fn === 'claim_updates_cache_purge')
        return { data: claims.shift() ?? { status: 'empty' }, error: null }
      return { data: null, error: null }
    })
    return { rpc, calls }
  }

  it('waits out the claim throttle, purges, and settles each lease', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
    const sleep = vi.fn(async () => {})
    const { rpc, calls } = rpcFrom([
      { status: 'throttled', wait_ms: 400 },
      { status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.a', initial: true }, { app_id: 'com.b', initial: false }], has_more: true },
      { status: 'ok', lease_token: 'lease-2', apps: [{ app_id: 'com.c', initial: true }], has_more: false },
    ])

    await expect(drainUpdatesCachePurge(makeContext(), rpc, { sleep })).resolves.toEqual({ purgedApps: 3 })
    expect(sleep).toHaveBeenCalledWith(450)
    const acks = calls.filter(call => call.fn === 'ack_updates_cache_purge').map(call => call.args)
    // Re-purges for first purges are scheduled in SQL from the leased rows.
    expect(acks).toEqual([
      { p_lease_token: 'lease-1', p_success: true, p_retry_after_seconds: 5 },
      { p_lease_token: 'lease-2', p_success: true, p_retry_after_seconds: 5 },
    ])
  })

  it('puts a failed batch back at its Retry-After instead of dropping it', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '12' } })))
    const { rpc, calls } = rpcFrom([{ status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.a', initial: true }], has_more: false }])

    await expect(drainUpdatesCachePurge(makeContext(), rpc)).resolves.toEqual({ purgedApps: 0 })
    expect(calls.find(call => call.fn === 'ack_updates_cache_purge')?.args).toEqual({ p_lease_token: 'lease-1', p_success: false, p_retry_after_seconds: 12 })
  })

  it('treats a 200 answer with success: false as a failed purge', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false, errors: [{ code: 1134 }] }), { status: 200 })))
    const { rpc, calls } = rpcFrom([{ status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.a', initial: true }], has_more: false }])

    await drainUpdatesCachePurge(makeContext(), rpc)
    expect(calls.find(call => call.fn === 'ack_updates_cache_purge')?.args).toMatchObject({ p_lease_token: 'lease-1', p_success: false })
  })

  it('does not claim (so drops nothing) when no purge target is configured', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', '')
    vi.stubEnv('CF_ANALYTICS_TOKEN', '')
    vi.stubEnv('UPDATES_CACHE_LOCAL_PURGE_URL', '')
    const { rpc, calls } = rpcFrom([{ status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.a', initial: true }] }])
    await drainUpdatesCachePurge(makeContext(), rpc)
    expect(calls).toHaveLength(0)
  })

  it('waits out the throttle once before its first claim, then leaves the drain to the active caller', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    const sleep = vi.fn(async () => {})
    const { rpc, calls } = rpcFrom([
      { status: 'throttled', wait_ms: 900 },
      { status: 'throttled', wait_ms: 700 },
      { status: 'ok', apps: [{ app_id: 'com.never', initial: true }], has_more: false },
    ])
    await expect(drainUpdatesCachePurge(makeContext(), rpc, { sleep })).resolves.toEqual({ purgedApps: 0 })
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(calls.filter(call => call.fn === 'claim_updates_cache_purge')).toHaveLength(2)
  })

  it('stops when another caller is draining', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    const { rpc, calls } = rpcFrom([{ status: 'busy' }])
    await drainUpdatesCachePurge(makeContext(), rpc)
    expect(calls).toHaveLength(1)
  })
})

describe('edge cache safety', () => {
  it('recognizes a lazy connect failure wrapped by Drizzle', async () => {
    // The plugin worker requires a read replica; none is configured here, so
    // opening the lazy connection fails (the production failure mode).
    const base = makeContext()
    const c = { ...base, get: (key: string) => key === 'requireReadReplica' ? true : base.get(key) }
    const lazy = createLazyPgClient(c, true)
    const connectError = await (lazy.client as unknown as { query: (sql: string) => Promise<unknown> }).query('SELECT 1').catch((error: unknown) => error)
    expect(isLazyPgConnectError(connectError)).toBe(true)
    // Drizzle rethrows client rejections as DrizzleQueryError with the original as cause.
    const wrapped = new Error('Failed query: SELECT 1', { cause: connectError })
    expect(isLazyPgConnectError(wrapped)).toBe(true)
    expect(isLazyPgConnectError(new Error('outer', { cause: wrapped }))).toBe(true)
    expect(isLazyPgConnectError(new Error('query error'))).toBe(false)
    expect(isLazyPgConnectError(new Error('wrapped', { cause: new Error('query error') }))).toBe(false)
  })

  it('caps the owner TTL at the end of a trial that keeps the plan valid', () => {
    const now = Date.UTC(2026, 8, 30, 23, 59, 0)
    expect(planValidityTtlCapSeconds({ plan_valid: true, plan_trial_at: '2026-10-01 10:00:00+00' }, now)).toBe(60)
    expect(planValidityTtlCapSeconds({ plan_valid: true, plan_trial_at: '2026-09-30T08:00:00Z' }, now)).toBeUndefined()
    expect(planValidityTtlCapSeconds({ plan_valid: false, plan_trial_at: '2026-10-01 10:00:00+00' }, now)).toBeUndefined()
    expect(planValidityTtlCapSeconds({ plan_valid: true, plan_trial_at: null }, now)).toBeUndefined()
  })
})

/** Drizzle over a fake pg client: every select answers `rows` (array mode). */
function fakeDrizzle(rows: unknown[][] | Error) {
  const query = vi.fn(async () => {
    if (rows instanceof Error)
      throw rows
    return { rows, fields: [] }
  })
  return { query, drizzle: getDrizzleClient({ query } as any, { logger: false }) }
}

describe('edge-cached plugin reads', () => {
  beforeEach(() => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'mock-token')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function connectFailingDrizzle() {
    const base = makeContext()
    const c = { ...base, get: (key: string) => key === 'requireReadReplica' ? true : base.get(key) }
    return getDrizzleClient(createLazyPgClient(c, true).client, { logger: false })
  }

  it('serves a bundle by name from the cache after the first read', async () => {
    stubCaches()
    const c = makeContext()
    const { query, drizzle } = fakeDrizzle([[7, 'org-1']])
    await expect(getAppVersionWithEdgeCache(c, 'com.example.app', '1.0.0', drizzle)).resolves.toEqual({ id: 7, owner_org: 'org-1' })
    await expect(getAppVersionWithEdgeCache(c, 'com.example.app', '1.0.0', drizzle)).resolves.toEqual({ id: 7, owner_org: 'org-1' })
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('answers a failed read like the uncached helper and never caches it', async () => {
    const { cache } = stubCaches()
    const c = makeContext()
    const { drizzle } = fakeDrizzle(new Error('statement timeout'))
    await expect(getAppVersionWithEdgeCache(c, 'com.example.app', '1.0.0', drizzle)).resolves.toBeNull()
    await expect(getAppOwnerWithEdgeCache(c, 'com.example.app', drizzle, ['mau'])).resolves.toEqual({ value: null, hit: false })
    await expect(getChannelByNameWithEdgeCache(c, 'com.example.app', 'production', drizzle)).resolves.toBeNull()
    await expect(getCompatibleChannelsWithEdgeCache(c, 'com.example.app', 'ios', false, true, drizzle)).resolves.toEqual([])
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('rethrows a connect failure instead of reporting a missing app, bundle or channel', async () => {
    const { cache } = stubCaches()
    const c = makeContext()
    await expect(getAppOwnerWithEdgeCache(c, 'com.example.app', connectFailingDrizzle(), ['mau', 'bandwidth'])).rejects.toSatisfy(isLazyPgConnectError)
    await expect(getAppVersionWithEdgeCache(c, 'com.example.app', '1.0.0', connectFailingDrizzle())).rejects.toSatisfy(isLazyPgConnectError)
    await expect(getChannelByNameWithEdgeCache(c, 'com.example.app', 'production', connectFailingDrizzle())).rejects.toSatisfy(isLazyPgConnectError)
    await expect(getCompatibleChannelsWithEdgeCache(c, 'com.example.app', 'ios', false, true, connectFailingDrizzle())).rejects.toSatisfy(isLazyPgConnectError)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('caches the app-level channel lookups of /stats but keeps device overrides live', async () => {
    const { store } = stubCaches()
    const c = makeContext()
    const { query, drizzle } = fakeDrizzle([[11, 'beta']])
    const lookup = () => getEffectiveDeviceChannelNamePostgres(c, 'com.example.app', 'device-1', 'beta', 'ios', false, drizzle, { edgeCache: true })

    await expect(lookup()).resolves.toEqual({ id: 11, name: 'beta' })
    await expect(lookup()).resolves.toEqual({ id: 11, name: 'beta' })
    expect(query).toHaveBeenCalledTimes(1)
    expect([...store.values()][0].headers.get('Cache-Tag')).toBe('capgo-updates-com.example.app')

    // channel_devices overrides are per device: read on every request.
    const overrides = () => getEffectiveDeviceChannelNamePostgres(c, 'com.example.app', 'device-1', 'beta', 'ios', true, drizzle, { edgeCache: true })
    await overrides()
    await overrides()
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('does not touch the cache when the edge cache is not used', async () => {
    const { cache } = stubCaches()
    const c = makeContext()
    const { query, drizzle } = fakeDrizzle([[11, 'beta']])
    await getEffectiveDeviceChannelNamePostgres(c, 'com.example.app', 'device-1', 'beta', 'ios', false, drizzle)
    await getEffectiveDeviceChannelNamePostgres(c, 'com.example.app', 'device-1', 'beta', 'ios', false, drizzle)
    expect(query).toHaveBeenCalledTimes(2)
    expect(cache.match).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })
})

describe('updates cache purge scopes', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetPurgeZoneCache()
  })

  it('purges the tag of each claimed scope', async () => {
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const apps = [
      { app_id: 'com.a', scope: 'app', initial: true },
      { app_id: 'com.a', scope: 'versions', initial: true },
      // Claimed by a database that predates the scope column.
      { app_id: 'com.b', initial: false },
    ]
    const rpc = vi.fn(async (fn: string) => fn === 'claim_updates_cache_purge'
      ? { data: { status: 'ok', lease_token: 'lease-1', has_more: false, apps }, error: null }
      : { data: null, error: null })

    await expect(drainUpdatesCachePurge(makeContext(), rpc)).resolves.toEqual({ purgedApps: 3 })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).tags).toEqual(['capgo-updates-com.a', 'capgo-updates-com.a-versions', 'capgo-updates-com.b'])
  })
})
