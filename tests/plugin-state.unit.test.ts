import type { PluginStateAppDoc, PluginStateChannelRow, PluginStateManifestDoc } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getManifestDownloadSize } from '../supabase/functions/_backend/plugin_runtime/utils/manifest_size.ts'
import { getAppVersionsByAppIdPg } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { abandonPluginStateRequest, createPluginStateDatabase, PluginStateMiss, PluginStateSession, shouldUsePluginState, startPluginStateRequest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginState.ts'
import { evalAppVersion, evalChannelById, evalChannelDevice, evalCompatibleChannels, evalDefaultChannel, evalManifestSizeLookup, evalManifestVersionSizes, evalPlanValid } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateEval.ts'
import { pluginStateAppKey, pluginStateDeviceKey, pluginStateDeviceKeyPrefix, pluginStateManifestKey, pluginStateVersionKey, pluginStateVersionKeyPrefix } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { parsePluginStateShareBps, pluginStateBucket } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateSwitch.ts'
import { parsePluginStateApp, parsePluginStateManifest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateValidation.ts'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts', () => ({
  readPublishedPluginState: async (_context: unknown, store: { get: (key: string, options: object) => unknown }, key: string) => ({ value: await store.get(key, { type: 'json', cacheTtl: 30 }), revision: null }),
}))

const APP_ID = 'com.example.pluginstate'
const ORG_ID = '00000000-0000-4000-8000-000000000001'
const NOW = Date.UTC(2026, 10, 6, 23, 59)

function channel(overrides: Record<string, unknown> = {}): PluginStateChannelRow {
  return {
    channels: {
      id: 1,
      name: 'production',
      app_id: APP_ID,
      public: true,
      ios: true,
      android: true,
      electron: true,
      allow_device_self_set: true,
      allow_emulator: false,
      allow_device: true,
      allow_dev: false,
      allow_prod: true,
      ...overrides,
    },
    version_ref: 11,
    version: { id: 11, name: '1.0.0', comment: 'release notes', link: 'https://example.com/release' },
    rolloutVersion: { id: null },
    owner_org: ORG_ID,
  }
}

function appDoc(channels: PluginStateChannelRow[] = [channel()]): PluginStateAppDoc {
  return {
    f: 1,
    app_id: APP_ID,
    built_at: NOW,
    exists: true,
    owner: { owner_org: ORG_ID, block_provider_infra_requests: false },
    plan: { has_credits: false, customer_id: null, stripe: null },
    channels,
    overrides: {},
  }
}

function manifest(overrides: Partial<PluginStateManifestDoc> = {}): PluginStateManifestDoc {
  return { f: 1, built_at: NOW, version_id: 11, app_id: APP_ID, deleted: false, entries: [], sizes: [['shared', '100'], ['shared', '200'], ['unknown', null]], ...overrides }
}

beforeEach(() => {
  vi.stubEnv('PLUGIN_STATE_KV', 'on')
  vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', 'true')
  vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('plugin state rollout', () => {
  it.each([
    ['off', 0], ['invalid', 0], ['-1', 0], ['', 0], ['on', 10_000],
    ['0.5%', 50], ['1', 100], ['25%', 2500], ['100', 10_000], ['120%', 10_000],
  ])('parses %s safely', (value, expected) => expect(parsePluginStateShareBps(value)).toBe(expected))

  it('uses stable nested device cohorts as the rollout grows', () => {
    const buckets = Array.from({ length: 1000 }, (_, index) => pluginStateBucket(APP_ID, `device-${index}`))
    expect(buckets.every(bucket => bucket >= 0 && bucket < 10_000)).toBe(true)
    expect(buckets).toEqual(Array.from({ length: 1000 }, (_, index) => pluginStateBucket(APP_ID, `device-${index}`)))
    expect(buckets.filter(bucket => bucket < 100).every(bucket => bucket < 1000)).toBe(true)
    expect(new Set(buckets).size).toBeGreaterThan(900)
  })

  it('keeps requests without a device id out of percentage canaries', async () => {
    const app = new Hono()
    app.get('/', c => c.json({ selected: shouldUsePluginState(c, APP_ID, '') }))
    for (const percentage of ['0.1%', '1%', '99.99%']) {
      vi.stubEnv('PLUGIN_STATE_KV', percentage)
      expect(await (await app.request('/', undefined, { PLUGIN_STATE: {} })).json()).toEqual({ selected: false })
    }
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    expect(await (await app.request('/', undefined, { PLUGIN_STATE: {} })).json()).toEqual({ selected: true })
  })

  it('ignores per-request forced modes outside local workers', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'off')
    vi.stubEnv('ENV_NAME', 'capgo-prod')
    const app = new Hono()
    app.get('/', c => c.json({ enabled: shouldUsePluginState(c, APP_ID, 'device') }))
    const response = await app.request('/', { headers: { 'x-capgo-plugin-state': 'kv' } }, { ENV_NAME: 'capgo-prod', PLUGIN_STATE_KV: 'off', PLUGIN_STATE: {} })
    expect(await response.json()).toEqual({ enabled: false })
  })
})

describe('plugin state storage and selection boundaries', () => {
  it('bounds long app prefixes and long names without changing their listing scope', async () => {
    const appId = `com.${'a'.repeat(506)}`
    const otherApp = `${appId.slice(0, -1)}b`
    const versionPrefix = await pluginStateVersionKeyPrefix(appId)
    const devicePrefix = await pluginStateDeviceKeyPrefix(appId)
    const keys = [await pluginStateVersionKey(appId, '界'.repeat(1000)), await pluginStateDeviceKey(appId, 'x'.repeat(1000))]
    expect(keys[0].startsWith(versionPrefix)).toBe(true)
    expect(keys[1].startsWith(devicePrefix)).toBe(true)
    expect(keys.every(key => new TextEncoder().encode(key).length <= 512)).toBe(true)
    expect(await pluginStateVersionKeyPrefix(otherApp)).not.toBe(versionPrefix)
  })

  it('honors local DB forcing while KV is enabled', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_plugin-local')
    const get = vi.fn(() => appDoc())
    const app = new Hono()
    app.get('/', async c => c.json({ source: await startPluginStateRequest(c, APP_ID, 'device') ? 'kv' : 'db' }))
    const env = { PLUGIN_STATE: { get } }
    const db = await app.request('/', { headers: { 'x-capgo-plugin-state': 'db' } }, env)
    expect(await db.json()).toEqual({ source: 'db' })
    expect(get).not.toHaveBeenCalled()
    expect(await (await app.request('/', undefined, env)).json()).toEqual({ source: 'kv' })
  })

  it('selects nested percentage cohorts through the request selector', async () => {
    const devices = Array.from({ length: 1000 }, (_, i) => `selected-${i}`)
    const app = new Hono()
    app.get('/', c => c.json({ selected: shouldUsePluginState(c, APP_ID, c.req.query('device') ?? '') }))
    const select = async (percentage: string) => {
      vi.stubEnv('PLUGIN_STATE_KV', percentage)
      return Promise.all(devices.map(async (device) => {
        const result = await app.request(`/?device=${device}`, undefined, { PLUGIN_STATE: {} })
        const body = await result.json<{ selected: boolean }>()
        return body.selected
      }))
    }
    const low = await select('1%')
    const high = await select('10%')
    expect(low.some(Boolean)).toBe(true)
    expect(low.some(value => !value)).toBe(true)
    expect(low.every((selected, i) => !selected || high[i])).toBe(true)
    devices.forEach((device, i) => expect(low[i]).toBe(pluginStateBucket(APP_ID, device) < 100))
  })

  it('rejects a missing provider-block flag instead of accepting malformed app state', () => {
    expect(() => parsePluginStateApp({ ...appDoc(), owner: { owner_org: ORG_ID } })).toThrow()
  })

  it('rejects a missing bundle key even in authoritative app mode', async () => {
    const appKey = await pluginStateAppKey(APP_ID)
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      await expect(session?.versionByName('not-yet-propagated')).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    expect((await app.request('/', undefined, { PLUGIN_STATE: { get: (key: string) => key === appKey ? appDoc() : null } })).status).toBe(200)
  })

  it('distinguishes an unsynced device override from an explicit no-override tombstone', async () => {
    const appKey = await pluginStateAppKey(APP_ID)
    for (const known of [false, true]) {
      const app = new Hono()
      app.get('/', async (c) => {
        const session = await startPluginStateRequest(c, APP_ID, 'device')
        if (known)
          expect(await session?.overrideChannelId('device')).toBeNull()
        else
          await expect(session?.overrideChannelId('device')).rejects.toBeInstanceOf(PluginStateMiss)
        return c.json({ done: true })
      })
      const response = await app.request('/', undefined, { PLUGIN_STATE: { get: (key: string) => key === appKey ? { ...appDoc(), overrides: null } : known ? { channel_id: null } : null } })
      expect(response.status).toBe(200)
    }
  })

  it('does not load an unused fallback manifest when all requested files are version scoped', async () => {
    const appKey = await pluginStateAppKey(APP_ID)
    const read = vi.fn((key: string) => key === appKey ? appDoc() : key === pluginStateManifestKey(11) ? manifest({ sizes: [['a', '10']] }) : key === pluginStateManifestKey(12) ? manifest({ version_id: 12, sizes: [['b', '20']] }) : null)
    const app = new Hono()
    app.get('/', async c => c.json(await getManifestDownloadSize(c, APP_ID, 'unused', 99, [
      { file_name: 'a.js', file_hash: 'a', download_url: 'https://example.com/read?key=11' },
      { file_name: 'b.js', file_hash: 'b', download_url: 'https://example.com/read?key=12' },
    ], 'device')))
    const response = await app.request('/', undefined, { PLUGIN_STATE: { get: read } })
    expect(await response.json()).toMatchObject({ totalSize: 30, knownFiles: 2 })
    expect(read.mock.calls.some(([key]) => key === pluginStateManifestKey(99))).toBe(false)
  })

  it('excludes a deleted manifest even when its bundle-name record is stale', () => {
    const version = { id: 11, owner_org: ORG_ID, deleted: false }
    expect(evalManifestSizeLookup(APP_ID, [{ file_hash: 'shared', version_id: null }], { versionName: '1.0.0', version }, new Map([[11, manifest({ deleted: true })]]))).toEqual([])
  })

  it.each(['kv_value_limit', 'worker_memory_limit'])('falls back intentionally for a %s manifest marker', async (reason) => {
    const appKey = await pluginStateAppKey(APP_ID)
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      await expect(session?.manifest(11)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    expect((await app.request('/', undefined, { PLUGIN_STATE: { get: (key: string) => key === appKey ? appDoc() : { f: 1, built_at: NOW, version_id: 11, app_id: APP_ID, fallback: 'replica', reason } } })).status).toBe(200)
  })
})

describe('plugin state query parity', () => {
  it('keeps subscription limits, null flags, credits and UTC trial boundaries', () => {
    const plan = { has_credits: false, customer_id: 'example-customer', stripe: { status: 'succeeded', trial_at: null, trial_date: null, mau_exceeded: false, bandwidth_exceeded: false, storage_exceeded: true } }
    expect(evalPlanValid(plan, ['mau', 'bandwidth'], NOW)).toBe(true)
    expect(evalPlanValid(plan, ['storage'], NOW)).toBe(false)
    expect(evalPlanValid({ ...plan, stripe: { ...plan.stripe, mau_exceeded: null } }, ['mau'], NOW)).toBe(false)
    expect(evalPlanValid({ ...plan, has_credits: true }, ['storage'], NOW)).toBe(true)
    expect(evalPlanValid({ ...plan, stripe: { ...plan.stripe, trial_date: '2026-11-07' } }, ['storage'], NOW)).toBe(true)
    expect(evalPlanValid({ ...plan, stripe: { ...plan.stripe, trial_date: '2026-11-06' } }, ['storage'], NOW)).toBe(false)
  })

  it('preserves built-in left joins and rejects deleted channel bundle joins', () => {
    const builtin = { ...channel(), version_ref: null, version: { id: null, name: 'builtin' } }
    const deleted = { ...channel({ id: 2 }), version_ref: 12, version: { id: null, name: null } }
    expect(evalDefaultChannel(appDoc([builtin]), 'ios', null, false)?.version.name).toBe('builtin')
    expect(evalChannelById(appDoc([builtin]), 1, false)).toBeUndefined()
    expect(evalDefaultChannel(appDoc([deleted]), 'ios', null, false)).toBeUndefined()
    expect(evalChannelDevice(appDoc([deleted]), APP_ID, 'device', 2, false)).toBeUndefined()
  })

  it('keeps private override channels and removes optional metadata', () => {
    const doc = appDoc([channel({ public: false, allow_device_self_set: false })])
    expect(evalDefaultChannel(doc, 'ios', null, false)).toBeUndefined()
    expect(evalChannelDevice(doc, APP_ID, 'device', 1, false)?.version).toEqual({ id: 11, name: '1.0.0' })
    expect(evalChannelDevice(doc, APP_ID, 'device', 1, true)?.version.comment).toBe('release notes')
    expect(evalCompatibleChannels(doc, 'ios', false, true)).toEqual([])
  })

  it('applies every channel compatibility dimension', () => {
    const doc = appDoc([channel()])
    expect(evalCompatibleChannels(doc, 'ios', false, true)).toHaveLength(1)
    expect(evalCompatibleChannels(doc, 'ios', true, true)).toEqual([])
    expect(evalCompatibleChannels(doc, 'ios', false, false)).toEqual([])
    expect(evalCompatibleChannels(appDoc([channel({ android: false })]), 'android', false, true)).toEqual([])
  })

  it('preserves source channel list order independently of channel selection order', () => {
    const doc = appDoc([channel({ id: 2, name: 'beta' }), channel({ id: 1, name: 'production' })])
    doc.channel_list_ids = [1, 2]
    expect(evalCompatibleChannels(doc, 'ios', false, true).map(row => row.name)).toEqual(['production', 'beta'])
    expect(evalDefaultChannel(doc, 'ios', null, false)?.channels.name).toBe('beta')
  })

  it('resolves deleted versions for stats while respecting explicit deleted filters', () => {
    const version = { id: 11, owner_org: ORG_ID, deleted: true }
    expect(evalAppVersion(version, undefined)).toEqual({ id: 11, owner_org: ORG_ID })
    expect(evalAppVersion(version, false)).toBeNull()
    expect(evalAppVersion(null, undefined)).toBeNull()
  })

  it('scopes manifest sizes to the app and live bundle and takes bigint MAX per hash', () => {
    const docs = new Map([[11, manifest()], [12, manifest({ version_id: 12, deleted: true })], [13, manifest({ version_id: 13, app_id: 'com.example.other' })]])
    expect(evalManifestVersionSizes(APP_ID, [11, 12, 13], docs)).toEqual([
      { file_hash: 'shared', version_id: '11', file_size: '200' },
      { file_hash: 'unknown', version_id: '11', file_size: null },
    ])
    expect(evalManifestSizeLookup(APP_ID, [{ file_hash: 'shared', version_id: null }], { versionId: 11 }, docs)).toEqual([{ file_hash: 'shared', version_id: '11', file_size: '200' }])
    expect(evalManifestVersionSizes(APP_ID, [11], new Map([[11, manifest({ sizes: [['big', '9007199254740993'], ['big', '9007199254740992']] })]]))[0].file_size).toBe('9007199254740993')
  })
})

describe('state read failures and boundaries', () => {
  it.each(['true', 'false'])('falls back for an unsynced manifest with authoritative apps %s', async (authoritative) => {
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', authoritative)
    const appKey = await pluginStateAppKey(APP_ID)
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      expect(session).toBeInstanceOf(PluginStateSession)
      await expect(session?.manifest(11)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE_KV: 'on',
      PLUGIN_STATE_KV_AUTHORITATIVE: authoritative,
      PLUGIN_STATE: { get: (key: string) => key === appKey ? appDoc() : null },
    })
    expect(response.status).toBe(200)
  })

  it('serves a warm KV size map without reading KV and bounds its cached lifetime', async () => {
    const entries = new Map<string, Response>()
    const cache = {
      match: async (request: Request) => entries.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()) },
    }
    vi.stubGlobal('caches', { open: async () => cache })
    const appKey = await pluginStateAppKey(APP_ID)
    const get = vi.fn((key: string) => {
      if (key === appKey)
        return appDoc()
      if (key === pluginStateManifestKey(11))
        return manifest({ sizes: [['shared', '200']] })
      throw new Error('Unexpected KV read')
    })
    const app = new Hono()
    app.get('/', async c => c.json(await getManifestDownloadSize(c, APP_ID, '1.0.0', 11, [
      { file_name: 'index.js', file_hash: 'shared', download_url: 'https://example.com/files/read?key=11' },
    ], 'device')))
    const env = { PLUGIN_STATE: { get } }
    const cold = await app.request('/', undefined, env)
    expect(await cold.json()).toMatchObject({ totalSize: 200, knownFiles: 1, unknownFiles: 0 })
    expect(get).toHaveBeenCalledTimes(2)
    const sizeEntry = [...entries].find(([url]) => url.includes('/.plugin-state-manifest-sizes-v1?'))?.[1]
    expect(sizeEntry?.headers.get('Cache-Control')).toBe('public, s-maxage=30')
    expect(sizeEntry?.headers.get('Cache-Tag')).toBe(`capgo-plugin-state-${APP_ID}`)
    get.mockImplementation(() => { throw new Error('KV unavailable') })
    const warm = await app.request('/', undefined, env)
    expect(await warm.json()).toMatchObject({ totalSize: 200, knownFiles: 1, unknownFiles: 0 })
    expect(warm.headers.get('X-Plugin-State')).toBe('kv')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it.each([
    () => { throw new Error('KV unavailable') },
    () => ({ f: 2, app_id: APP_ID, exists: true }),
    () => ({ ...appDoc(), app_id: 'com.example.other' }),
    () => ({ ...appDoc(), plan: undefined }),
  ])('falls back on unavailable or invalid app state even in authoritative mode', async (get) => {
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      return c.json({ served: session !== null })
    })
    const response = await app.request('/', undefined, { PLUGIN_STATE: { get }, PLUGIN_STATE_KV: 'on', PLUGIN_STATE_KV_AUTHORITATIVE: 'true' })
    expect(await response.json()).toEqual({ served: false })
    expect(response.headers.get('X-Plugin-State')).toBe('error')
  })

  it('uses tombstones for known deleted apps and a replica for unsynced apps', async () => {
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', 'false')
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      return c.json({ exists: session?.exists ?? null })
    })
    const env = { PLUGIN_STATE: { get: () => null }, PLUGIN_STATE_KV: 'on' }
    expect(await (await app.request('/', undefined, env)).json()).toEqual({ exists: null })
    expect(await (await app.request('/', undefined, { ...env, PLUGIN_STATE: { get: () => ({ f: 1, app_id: APP_ID, built_at: NOW, exists: false }) } })).json()).toEqual({ exists: false })
  })

  it('surfaces dependent-read failures and clears the request before fallback', async () => {
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      expect(session).toBeInstanceOf(PluginStateSession)
      await expect(session?.versionByName('1.0.0')).rejects.toBeInstanceOf(PluginStateMiss)
      abandonPluginStateRequest(c)
      expect(await startPluginStateRequest(c, APP_ID, 'device')).toBeNull()
      return c.json({ done: true })
    })
    const key = await pluginStateAppKey(APP_ID)
    const response = await app.request('/', undefined, { PLUGIN_STATE: { get: (lookup: string) => { if (lookup === key) return appDoc(); throw new Error('read failed') } }, PLUGIN_STATE_KV: 'on', PLUGIN_STATE_KV_AUTHORITATIVE: 'true' })
    expect(await response.json()).toEqual({ done: true })
    expect(response.headers.get('X-Plugin-State')).toBe('fallback')
  })

  it('validates complete app and manifest documents at the storage boundary', () => {
    expect(parsePluginStateApp(appDoc())).toEqual(appDoc())
    expect(() => parsePluginStateApp({ ...appDoc(), channels: [{}] })).toThrow()
    expect(() => parsePluginStateManifest({ ...manifest(), sizes: [['hash', 'not-a-bigint']] })).toThrow()
    expect(parsePluginStateManifest(manifest())).toEqual(manifest())
  })

  it('makes an uncovered query fail strict mode before opening Postgres', async () => {
    vi.stubEnv('PLUGIN_STATE_KV_STRICT', 'true')
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, APP_ID, 'device')
      if (!session)
        throw new Error('Expected state session')
      const { drizzle, lazy } = createPluginStateDatabase(c, session)
      // This helper deliberately has no state implementation. Its legacy
      // catch must not turn a prohibited connection into an empty success.
      await expect(getAppVersionsByAppIdPg(c, APP_ID, '1.0.0', drizzle, ['mau'])).rejects.toMatchObject({ cause: expect.any(PluginStateMiss) })
      expect(lazy.isConnected()).toBe(false)
      await lazy.close()
      return c.json({ done: true })
    })
    const response = await app.request('/', undefined, { PLUGIN_STATE: { get: () => appDoc() } })
    expect(await response.json()).toEqual({ done: true })
  })

  it('keeps app, device and bundle keys distinct and within the KV limit', async () => {
    const long = 'é'.repeat(1000)
    const keys = await Promise.all([pluginStateAppKey(long), pluginStateDeviceKey(APP_ID, long), pluginStateVersionKey(APP_ID, long)])
    expect(keys.every(key => new TextEncoder().encode(key).length <= 512)).toBe(true)
    expect(new Set(keys).size).toBe(3)
  })
})
