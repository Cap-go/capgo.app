import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import process from 'node:process'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app as prewarmRoute } from '../supabase/functions/_backend/plugin_runtime/private/plugin_state_prewarm.ts'
import { resetPluginStateMemory, startPluginStateRequest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginState.ts'
import { pluginStateAppKey, pluginStateImmutableKey, pluginStateManifestKey, pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { prewarmBundles, prewarmOperations, prewarmPluginStateApp, shouldReplaceCachedGeneration } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStatePrewarm.ts'
import { drainUpdatesCachePurge } from '../supabase/functions/_backend/triggers/updates_cache_purge.ts'
import { PLUGIN_REGIONS } from '../supabase/functions/_backend/utils/pluginRegionTargets.ts'
import { pluginStatePrewarmTargets, PrewarmNotConfigured, prewarmPluginStateRegions, schedulePluginStatePrewarm } from '../supabase/functions/_backend/utils/pluginStatePrewarm.ts'

const APP_ID = 'com.example.prewarm'
const OWNER = '00000000-0000-4000-8000-000000000001'
const APP_URL = `https://plugin.na.capgo.app/.plugin-state-app-v2?app_id=${APP_ID}`
// Region targets come from this file's stubs only, never from the parent environment.
const inheritedTargets = process.env.PLUGIN_REGION_TARGETS

beforeEach(() => {
  delete process.env.PLUGIN_REGION_TARGETS
  // crypto.subtle settles on the real event loop, outside fake timers, so a busy
  // CI runner could let the fake clock run ahead of it. Hash synchronously
  // instead: the same digest, settled within the awaited microtasks.
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toLowerCase().replace('-', '')
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const digest = createHash(name).update(Buffer.from(bytes)).digest()
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer
  })
})

afterEach(() => {
  // Undo this file's stubs first, then put back what the parent environment had.
  vi.unstubAllEnvs()
  if (inheritedTargets === undefined)
    delete process.env.PLUGIN_REGION_TARGETS
  else
    process.env.PLUGIN_REGION_TARGETS = inheritedTargets
  resetPluginStateMemory()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function channelRow(id: number, bundle: { id: number, name: string }, rollout: { id: number | null, name?: string } = { id: null }) {
  return {
    channels: { id, name: `channel-${id}`, allow_dev: true, allow_prod: true, allow_emulator: true, allow_device: true, ios: true, android: true, electron: true, public: id === 1, allow_device_self_set: false },
    version: { id: bundle.id, name: bundle.name },
    rolloutVersion: rollout,
    version_ref: bundle.id,
    owner_org: OWNER,
  }
}

function appDoc(channels = [channelRow(1, { id: 11, name: '1.0.0' }, { id: 12, name: '1.1.0' })], manifestIds = [11]) {
  return {
    f: 1,
    app_id: APP_ID,
    built_at: 1,
    exists: true,
    owner: { owner_org: OWNER, block_provider_infra_requests: false },
    plan: { has_credits: false, customer_id: null, stripe: null },
    channels,
    overrides: {},
    manifest_ids: manifestIds,
  }
}

/** R2 pointers and immutable KV values, published like the writer does. */
function providers() {
  const pointers = new Map<string, unknown>()
  const values = new Map<string, unknown>()
  const env = {
    PLUGIN_STATE: { get: vi.fn(async (key: string) => values.get(key) ?? null) },
    PLUGIN_STATE_POINTERS: { get: vi.fn(async (key: string) => pointers.has(key) ? { json: async () => pointers.get(key) } : null) },
  }
  async function publish(logicalKey: string, generation: string, value: unknown) {
    const kvKey = await pluginStateImmutableKey(logicalKey, generation)
    pointers.set(logicalKey, { f: 1, generation, kvKey })
    values.set(kvKey, value)
  }
  return { env, publish }
}

/** Cache API stand-in keyed by URL, keeping the stored headers. */
function memoryCache() {
  const entries = new Map<string, { body: string, headers: Headers }>()
  const cache = {
    match: vi.fn(async (request: Request) => {
      const entry = entries.get(request.url)
      return entry ? new Response(entry.body, { headers: entry.headers }) : undefined
    }),
    put: vi.fn(async (request: Request, response: Response) => { entries.set(request.url, { body: await response.text(), headers: new Headers(response.headers) }) }),
    delete: vi.fn(async (request: Request) => entries.delete(request.url)),
  }
  vi.stubGlobal('caches', { open: async () => cache, default: cache })
  return { cache, entries }
}

async function publishApp(publish: (key: string, generation: string, value: unknown) => Promise<void>, doc = appDoc()) {
  await publish(await pluginStateAppKey(APP_ID), '5', doc)
  await publish(await pluginStateVersionKey(APP_ID, '1.0.0'), '5', { id: 11, owner_org: OWNER, deleted: false })
  await publish(await pluginStateVersionKey(APP_ID, '1.1.0'), '5', { id: 12, owner_org: OWNER, deleted: false })
  await publish(pluginStateManifestKey(11), '5', { f: 1, built_at: 1, version_id: 11, app_id: APP_ID, deleted: false, entries: [], sizes: [] })
}

async function onRegionalHost<T>(env: Record<string, unknown>, run: (c: any) => Promise<T>) {
  const app = new Hono()
  let result: T | undefined
  app.all('*', async (c) => {
    result = await run(c)
    return c.json({ ok: true })
  })
  await app.request('https://plugin.na.capgo.app/updates', { method: 'POST' }, env)
  return result as T
}

describe('plugin state prewarm (regional worker)', () => {
  it('writes the app, bundle-name and manifest documents device requests read, then serves them without provider reads', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', '1%')
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)

    const result = await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    expect(result).toEqual({ app_id: APP_ID, revision: '5', cached: 4, error: undefined })
    expect(cache.put).toHaveBeenCalledTimes(4)

    // A device of this region, in the KV cohort, now reads only the cache.
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    env.PLUGIN_STATE_POINTERS.get.mockClear()
    env.PLUGIN_STATE.get.mockClear()
    const session = await onRegionalHost(env, c => startPluginStateRequest(c, APP_ID, 'device'))
    expect(session?.doc.app_id).toBe(APP_ID)
    expect(await session?.appVersion('1.1.0', false)).toMatchObject({ id: 12 })
    expect(await session?.manifestEntries(11)).toEqual([])
    expect(env.PLUGIN_STATE_POINTERS.get).not.toHaveBeenCalled()
    expect(env.PLUGIN_STATE.get).not.toHaveBeenCalled()
  })

  it('keeps entries that already hold the published generation', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    cache.put.mockClear()

    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ revision: '5', cached: 0 })
    expect(cache.put).not.toHaveBeenCalled()

    // A new publication replaces only what changed.
    await publish(await pluginStateAppKey(APP_ID), '6', { ...appDoc(), built_at: 2 })
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ revision: '6', cached: 1 })
  })

  it('counts only confirmed cache writes', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    cache.put.mockRejectedValue(new Error('cache unavailable'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ app_id: APP_ID, cached: 0, error: 'plugin state missing: cache write failed' })
  })

  it('never replaces a cached entry with an older or equal generation', async () => {
    expect(shouldReplaceCachedGeneration(undefined, null)).toBe(true)
    expect(shouldReplaceCachedGeneration(undefined, '5')).toBe(true)
    expect(shouldReplaceCachedGeneration(null, '5')).toBe(true)
    expect(shouldReplaceCachedGeneration(null, null)).toBe(false)
    expect(shouldReplaceCachedGeneration('5', null)).toBe(false)
    expect(shouldReplaceCachedGeneration('5', '5')).toBe(false)
    expect(shouldReplaceCachedGeneration('6', '5')).toBe(false)
    expect(shouldReplaceCachedGeneration('10', '9')).toBe(false)
    expect(shouldReplaceCachedGeneration('9', '10')).toBe(true)
    expect(shouldReplaceCachedGeneration('garbage', '5')).toBe(true)

    // A device request stored generation 6 while this prewarm still read generation 5.
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    const appRequestUrl = 'https://plugin.na.capgo.app/.plugin-state-app-v2?app_id=com.example.prewarm'
    entries.set(appRequestUrl, { body: JSON.stringify({ v: { ...appDoc(), built_at: 2 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
    await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    expect(entries.get(appRequestUrl)?.headers.get('X-Plugin-State-Revision')).toBe('6')
    expect(cache.put.mock.calls.some(([request]) => request.url === appRequestUrl)).toBe(false)
  })

  it('rewrites the newer generation when one lands between its lookup and its put', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    const appKey = await pluginStateAppKey(APP_ID)
    const appRequestUrl = 'https://plugin.na.capgo.app/.plugin-state-app-v2?app_id=com.example.prewarm'
    const match = cache.match.getMockImplementation()!
    let raced = false
    cache.match.mockImplementation(async (request: Request) => {
      const found = await match(request)
      if (request.url === appRequestUrl && !raced) {
        raced = true
        // After this lookup missed: generation 6 is published and a device request caches it.
        await publish(appKey, '6', { ...appDoc(), built_at: 6 })
        entries.set(appRequestUrl, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      }
      return found
    })

    // Four distinct keys (app, two bundle names, one manifest): the repaired app key counts once.
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ revision: '6', cached: 4, error: undefined })
    // The stale generation 5 put replaced 6 for a moment; the pointer check wrote 6 back.
    const appPuts = cache.put.mock.calls.filter(([request]) => request.url === appRequestUrl)
    expect(appPuts).toHaveLength(2)
    expect(entries.get(appRequestUrl)?.headers.get('X-Plugin-State-Revision')).toBe('6')
  })

  it('gives up with an error when the publication keeps moving', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { entries } = memoryCache()
    await publishApp(publish)
    const appKey = await pluginStateAppKey(APP_ID)
    let generation = 5
    const get = env.PLUGIN_STATE_POINTERS.get.getMockImplementation()!
    env.PLUGIN_STATE_POINTERS.get.mockImplementation(async (key: string) => {
      // Every read of the app pointer sees one newer publication.
      if (key === appKey)
        await publish(appKey, String(++generation), { ...appDoc(), built_at: generation })
      return get(key)
    })
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ error: 'plugin state missing: publication kept moving during the prewarm' })
    // Out of retries: nothing it wrote is left behind; devices refill from the pointer.
    expect(entries.has(APP_URL)).toBe(false)
  })

  it('deletes its entry when the pointer check after the write fails', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { entries } = memoryCache()
    await publishApp(publish)
    const appKey = await pluginStateAppKey(APP_ID)
    const get = env.PLUGIN_STATE_POINTERS.get.getMockImplementation()!
    let appReads = 0
    env.PLUGIN_STATE_POINTERS.get.mockImplementation(async (key: string) => {
      if (key === appKey && ++appReads === 2)
        throw new Error('R2 unavailable')
      return get(key)
    })
    // The written entry was removed, so nothing counts as warmed.
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ cached: 0, error: 'plugin state missing: publication check after write unavailable' })
    expect(entries.has(APP_URL)).toBe(false)
  })

  it('checks a write that lands after its timeout and replaces it when a newer generation exists', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    const appKey = await pluginStateAppKey(APP_ID)
    const put = cache.put.getMockImplementation()!
    let delayed = false
    cache.put.mockImplementation(async (request: Request, response: Response) => {
      if (request.url !== APP_URL || delayed)
        return put(request, response)
      delayed = true
      // Past the prewarm's 500 ms write timeout, generation 6 is published and cached...
      await new Promise(resolve => setTimeout(resolve, 550))
      await publish(appKey, '6', { ...appDoc(), built_at: 6 })
      entries.set(APP_URL, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      // ...then the stale generation 5 write finally lands over it.
      await new Promise(resolve => setTimeout(resolve, 50))
      return put(request, response)
    })
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    // Run past the delayed write (600 ms) and its background check.
    for (let step = 0; step < 80; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(25)
    }
    expect(await pending).toMatchObject({ error: 'plugin state missing: cache write timed out' })
    // The background check saw the pointer at 6, removed the stale 5 and wrote 6.
    expect(cache.delete).toHaveBeenCalledOnce()
    expect(entries.get(APP_URL)?.headers.get('X-Plugin-State-Revision')).toBe('6')
  })

  it('repairs a moved pointer by rewriting even when the delete fails', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    cache.delete.mockRejectedValue(new Error('delete failed'))
    const appKey = await pluginStateAppKey(APP_ID)
    const match = cache.match.getMockImplementation()!
    let raced = false
    cache.match.mockImplementation(async (request: Request) => {
      const found = await match(request)
      if (request.url === APP_URL && !raced) {
        raced = true
        await publish(appKey, '6', { ...appDoc(), built_at: 6 })
        entries.set(APP_URL, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      }
      return found
    })
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ revision: '6', error: undefined })
    expect(cache.delete).toHaveBeenCalled()
    expect(entries.get(APP_URL)?.headers.get('X-Plugin-State-Revision')).toBe('6')
  })

  it('says the entry was not removed when both the pointer check and the delete fail', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    cache.delete.mockRejectedValue(new Error('delete failed'))
    const appKey = await pluginStateAppKey(APP_ID)
    const get = env.PLUGIN_STATE_POINTERS.get.getMockImplementation()!
    let appReads = 0
    env.PLUGIN_STATE_POINTERS.get.mockImplementation(async (key: string) => {
      if (key === appKey && ++appReads === 2)
        throw new Error('R2 unavailable')
      return get(key)
    })
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({
      error: 'plugin state missing: publication check after write unavailable; entry not removed, it expires with its TTL',
    })
  })

  it('overwrites a late stale write with the newer generation when the delete fails', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    cache.delete.mockRejectedValue(new Error('delete failed'))
    const appKey = await pluginStateAppKey(APP_ID)
    const put = cache.put.getMockImplementation()!
    let delayed = false
    cache.put.mockImplementation(async (request: Request, response: Response) => {
      if (request.url !== APP_URL || delayed)
        return put(request, response)
      delayed = true
      await new Promise(resolve => setTimeout(resolve, 550))
      await publish(appKey, '6', { ...appDoc(), built_at: 6 })
      entries.set(APP_URL, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      await new Promise(resolve => setTimeout(resolve, 50))
      return put(request, response)
    })
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    for (let step = 0; step < 80; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(25)
    }
    expect(await pending).toMatchObject({ error: 'plugin state missing: cache write timed out' })
    // The stale 5 landed over 6 and could not be deleted; the background check wrote 6 back.
    expect(cache.delete).toHaveBeenCalled()
    expect(entries.get(APP_URL)?.headers.get('X-Plugin-State-Revision')).toBe('6')
  })

  it('says the entry was not removed when the delete fails and the repair write cannot happen', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    cache.delete.mockRejectedValue(new Error('delete failed'))
    const appKey = await pluginStateAppKey(APP_ID)
    const match = cache.match.getMockImplementation()!
    let raced = false
    cache.match.mockImplementation(async (request: Request) => {
      const found = await match(request)
      if (request.url === APP_URL && !raced) {
        raced = true
        await publish(appKey, '6', { ...appDoc(), built_at: 6 })
        entries.set(APP_URL, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      }
      return found
    })
    // Generation 6's KV value has not propagated to this location yet.
    const kvGet = env.PLUGIN_STATE.get.getMockImplementation()!
    const generation6 = await pluginStateImmutableKey(appKey, '6')
    env.PLUGIN_STATE.get.mockImplementation(async (key: string) => key === generation6 ? null : kvGet(key))
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({
      error: 'plugin state missing: published value not propagated; entry not removed, it expires with its TTL',
    })
  })

  it('logs a late write whose reconciliation fails', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    const appKey = await pluginStateAppKey(APP_ID)
    const put = cache.put.getMockImplementation()!
    let delayed = false
    cache.put.mockImplementation(async (request: Request, response: Response) => {
      if (request.url !== APP_URL || delayed)
        return put(request, response)
      delayed = true
      await new Promise(resolve => setTimeout(resolve, 600))
      return put(request, response)
    })
    // The pointer becomes unreadable before the late write lands, and so does the delete.
    const get = env.PLUGIN_STATE_POINTERS.get.getMockImplementation()!
    let appReads = 0
    env.PLUGIN_STATE_POINTERS.get.mockImplementation(async (key: string) => {
      if (key === appKey && ++appReads >= 2)
        throw new Error('R2 unavailable')
      return get(key)
    })
    cache.delete.mockRejectedValue(new Error('delete failed'))
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    for (let step = 0; step < 60; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(25)
    }
    expect(await pending).toMatchObject({ error: 'plugin state missing: cache write timed out' })
    const line = log.mock.calls.find(args => args.includes('plugin state prewarm late write not reconciled'))
    expect(line).toBeDefined()
    expect(line!.join(' ')).toContain('entry not removed, it expires with its TTL')
  })

  it('stops at the operation budget shared by every app and retry of a call', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    // Pointer, pointer body, KV value, cache lookup, then no budget left for the write.
    const ops = prewarmOperations(4)
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID, Date.now() + 6000, ops))).toMatchObject({ cached: 0, error: 'plugin state missing: prewarm operation budget exhausted' })
    expect(ops.used).toBe(4)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('does not repair while a cleanup delete is still pending, and stays inside its budget', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { env, publish } = providers()
    const { cache, entries } = memoryCache()
    await publishApp(publish)
    cache.delete.mockImplementation(() => new Promise<never>(() => {}))
    const appKey = await pluginStateAppKey(APP_ID)
    const match = cache.match.getMockImplementation()!
    let raced = false
    cache.match.mockImplementation(async (request: Request) => {
      const found = await match(request)
      if (request.url === APP_URL && !raced) {
        raced = true
        await publish(appKey, '6', { ...appDoc(), built_at: 6 })
        entries.set(APP_URL, { body: JSON.stringify({ v: { ...appDoc(), built_at: 6 } }), headers: new Headers({ 'X-Plugin-State-Revision': '6' }) })
      }
      return found
    })
    const startedAt = Date.now()
    let settledAt = Number.NaN
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID, startedAt + 6000)).then((result) => {
      settledAt = Date.now()
      return result
    })
    for (let step = 0; step < 80; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(await pending).toMatchObject({ cached: 0, error: 'plugin state missing: publication moved during the prewarm; entry removal still pending' })
    // The stalled delete is abandoned at the call budget, not waited on.
    expect(settledAt - startedAt).toBeLessThanOrEqual(6000)
    // One app put only: no repair write that the pending delete could later remove.
    expect(cache.put.mock.calls.filter(([request]) => request.url === APP_URL)).toHaveLength(1)
  })

  it('frees a connection slot when a binding call throws synchronously', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    memoryCache()
    const env = { PLUGIN_STATE: { get: vi.fn() }, PLUGIN_STATE_POINTERS: { get: vi.fn(() => { throw new Error('binding unavailable') }) } }
    const ops = prewarmOperations()
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID, Date.now() + 6000, ops))).toMatchObject({ cached: 0, error: 'binding unavailable' })
    expect(ops.connections.open).toBe(0)
  })

  it('does nothing while KV reads are off in the region', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'off')
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toEqual({ app_id: APP_ID, revision: null, cached: 0, skipped: 'disabled' })
    expect(env.PLUGIN_STATE_POINTERS.get).not.toHaveBeenCalled()
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('caches the miss of an unpublished app for the document TTL only', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env } = providers()
    const { cache } = memoryCache()
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toEqual({ app_id: APP_ID, revision: null, cached: 1, skipped: 'unpublished' })
    expect(cache.put).toHaveBeenCalledOnce()
    // It can land after a purge, like a late refill: 30 s, not the 60 s negative TTL.
    const [, stored] = cache.put.mock.calls[0] as unknown as [Request, Response]
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=30')
  })

  it('does not write when the cache lookup fails or times out', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { env, publish } = providers()
    const { cache } = memoryCache()
    await publishApp(publish)
    cache.match.mockRejectedValue(new Error('cache unavailable'))
    expect(await onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))).toMatchObject({ cached: 0, error: 'plugin state missing: cache lookup unavailable' })
    expect(cache.put).not.toHaveBeenCalled()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    cache.match.mockImplementation(() => new Promise<never>(() => {}))
    let settled = false
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID)).finally(() => { settled = true })
    for (let step = 0; step < 40 && !settled; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(50)
    }
    expect(await pending).toMatchObject({ cached: 0, error: 'plugin state missing: cache lookup unavailable' })
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('reports a provider read that misses the prewarm budget instead of throwing', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    memoryCache()
    const env = { PLUGIN_STATE: { get: vi.fn() }, PLUGIN_STATE_POINTERS: { get: vi.fn(() => new Promise<never>(() => {})) } }
    const pending = onRegionalHost(env, c => prewarmPluginStateApp(c, APP_ID))
    await vi.advanceTimersByTimeAsync(2001)
    expect(await pending).toMatchObject({ app_id: APP_ID, revision: null, cached: 0, error: expect.stringContaining('timed out') })
  })

  it('lists each served bundle once, skipping builtin and missing bundles, within the cap', () => {
    const rows: Record<string, unknown>[] = [
      channelRow(1, { id: 11, name: '1.0.0' }, { id: 11, name: '1.0.0' }),
      channelRow(2, { id: 12, name: 'builtin' }),
      { ...channelRow(3, { id: 13, name: '1.3.0' }), version: { id: null } },
      ...Array.from({ length: 12 }, (_, index) => channelRow(10 + index, { id: 100 + index, name: `2.${index}.0` })),
    ]
    const bundles = prewarmBundles(appDoc(rows as ReturnType<typeof channelRow>[]) as any)
    expect(bundles[0]).toEqual({ id: 11, name: '1.0.0' })
    expect(bundles.map(bundle => bundle.name)).not.toContain('builtin')
    expect(bundles).toHaveLength(8)
  })
})

describe('plugin state prewarm route', () => {
  async function call(body: unknown, secret?: string, extraEnv: Record<string, unknown> = {}) {
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    const app = new Hono()
    app.route('/plugin_state/prewarm', prewarmRoute)
    return app.request('https://plugin.na.capgo.app/plugin_state/prewarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { apisecret: secret } : {}), 'cf-placement': 'remote-CMH' },
      body: JSON.stringify(body),
    }, extraEnv)
  }

  it('requires the API secret', async () => {
    expect((await call({ app_ids: [APP_ID] })).status).toBe(401)
    expect((await call({ app_ids: [APP_ID] }, 'wrong')).status).toBe(401)
  })

  it('rejects an empty, oversized or invalid app list, and a null body', async () => {
    for (const app_ids of [[], 'com.example.app', ['not an app id'], Array.from({ length: 11 }, (_, i) => `com.example.app${i}`)])
      expect((await call({ app_ids }, 'prewarm-secret')).status).toBe(400)
    expect((await call(null, 'prewarm-secret')).status).toBe(400)
  })

  it('finishes inside its budget and reports the apps it could not start', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    memoryCache()
    // Each pointer answers after 1.9 s; the KV value never does.
    const env = {
      PLUGIN_STATE: { get: vi.fn(() => new Promise<never>(() => {})) },
      PLUGIN_STATE_POINTERS: { get: vi.fn(async (key: string) => {
        await new Promise(resolve => setTimeout(resolve, 1900))
        return { json: async () => ({ f: 1, generation: '1', kvKey: await pluginStateImmutableKey(key, '1') }) }
      }) },
    }
    const startedAt = Date.now()
    const appIds = Array.from({ length: 10 }, (_, i) => `com.example.slow${i}`)
    let settled = false
    const response = call({ app_ids: appIds }, 'prewarm-secret', env).finally(() => { settled = true })
    // crypto.subtle settles on the real event loop: let it run between fake-clock steps.
    for (let step = 0; step < 100 && !settled; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
    }
    const body = await (await response).json() as { results: { app_id: string, skipped?: string, error?: string }[] }
    expect(Date.now() - startedAt).toBeLessThanOrEqual(6100)
    // Waves of four. The first wave's KV reads never answer, so they keep their
    // connection slots (as a hung binding call keeps its connection): the second
    // wave times out or never gets a slot before the work window closes, and the
    // last two apps never start.
    expect(body.results.slice(0, 4).every(result => result.error?.includes('timed out'))).toBe(true)
    expect(body.results.slice(4, 8).every(result => /timed out|budget exhausted/.test(result.error ?? ''))).toBe(true)
    expect(body.results.slice(8)).toEqual([
      { app_id: 'com.example.slow8', revision: null, cached: 0, skipped: 'budget' },
      { app_id: 'com.example.slow9', revision: null, cached: 0, skipped: 'budget' },
    ])
  })

  it('loads at most two manifests at once across every app of a call', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    memoryCache()
    const { env, publish } = providers()
    const appIds = Array.from({ length: 4 }, (_, i) => `com.example.manifests${i}`)
    let bundleId = 1000
    for (const appId of appIds) {
      const rows = Array.from({ length: 8 }, (_, i) => channelRow(i + 1, { id: ++bundleId, name: `1.${i}.0` }))
      const ids = rows.map(row => row.version.id)
      await publish(await pluginStateAppKey(appId), '1', { ...appDoc(rows, ids), app_id: appId })
      for (const row of rows) {
        await publish(await pluginStateVersionKey(appId, row.version.name), '1', { id: row.version.id, owner_org: OWNER, deleted: false })
        await publish(pluginStateManifestKey(row.version.id), '1', { f: 1, built_at: 1, version_id: row.version.id, app_id: appId, deleted: false, entries: [], sizes: [] })
      }
    }
    // Track manifest KV reads in flight (their immutable keys carry the manifest logical key).
    const manifestKeys = new Set<string>()
    for (let id = 1001; id <= bundleId; id++)
      manifestKeys.add(await pluginStateImmutableKey(pluginStateManifestKey(id), '1'))
    const get = env.PLUGIN_STATE.get.getMockImplementation()!
    let open = 0
    let maxOpen = 0
    env.PLUGIN_STATE.get.mockImplementation(async (key: string) => {
      if (!manifestKeys.has(key))
        return get(key)
      open++
      maxOpen = Math.max(maxOpen, open)
      await new Promise(resolve => setTimeout(resolve, 2))
      open--
      return get(key)
    })
    const response = await call({ app_ids: appIds }, 'prewarm-secret', env)
    const body = await response.json() as { results: { cached: number, error?: string }[] }
    expect(body.results.every(result => !result.error)).toBe(true)
    // 1 app document + 8 bundle names + 8 manifests per app.
    expect(body.results.map(result => result.cached)).toEqual([17, 17, 17, 17])
    expect(maxOpen).toBe(2)
  })

  it('keeps R2, KV and cache operations of a call within five connections, timing each once admitted', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { cache } = memoryCache()
    const { env, publish } = providers()
    const appIds = Array.from({ length: 4 }, (_, i) => `com.example.connections${i}`)
    let bundleId = 2000
    for (const appId of appIds) {
      const rows = Array.from({ length: 8 }, (_, i) => channelRow(i + 1, { id: ++bundleId, name: `3.${i}.0` }))
      await publish(await pluginStateAppKey(appId), '1', { ...appDoc(rows, rows.map(row => row.version.id)), app_id: appId })
      for (const row of rows) {
        await publish(await pluginStateVersionKey(appId, row.version.name), '1', { id: row.version.id, owner_org: OWNER, deleted: false })
        await publish(pluginStateManifestKey(row.version.id), '1', { f: 1, built_at: 1, version_id: row.version.id, app_id: appId, deleted: false, entries: [], sizes: [] })
      }
    }
    // Every binding call counts as one open connection while it runs.
    let open = 0
    let maxOpen = 0
    const track = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (...args: A) => {
      open++
      maxOpen = Math.max(maxOpen, open)
      try {
        await new Promise(resolve => setTimeout(resolve, 2))
        return await fn(...args)
      }
      finally {
        open--
      }
    }
    env.PLUGIN_STATE_POINTERS.get.mockImplementation(track(env.PLUGIN_STATE_POINTERS.get.getMockImplementation()!))
    env.PLUGIN_STATE.get.mockImplementation(track(env.PLUGIN_STATE.get.getMockImplementation()!))
    cache.match.mockImplementation(track(cache.match.getMockImplementation()!))
    cache.put.mockImplementation(track(cache.put.getMockImplementation()!))
    const response = await call({ app_ids: appIds }, 'prewarm-secret', env)
    const body = await response.json() as { results: { cached: number, error?: string }[] }
    expect(body.results.map(result => result.error ?? null)).toEqual([null, null, null, null])
    expect(body.results.map(result => result.cached)).toEqual([17, 17, 17, 17])
    expect(maxOpen).toBeLessThanOrEqual(5)
  })

  it('keeps a manifest slot until a timed-out manifest write settles', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { cache } = memoryCache()
    const { env, publish } = providers()
    const appId = 'com.example.slow-manifests'
    const rows = Array.from({ length: 6 }, (_, i) => channelRow(i + 1, { id: 3001 + i, name: `4.${i}.0` }))
    await publish(await pluginStateAppKey(appId), '1', { ...appDoc(rows, rows.map(row => row.version.id)), app_id: appId })
    for (const row of rows) {
      await publish(await pluginStateVersionKey(appId, row.version.name), '1', { id: row.version.id, owner_org: OWNER, deleted: false })
      await publish(pluginStateManifestKey(row.version.id), '1', { f: 1, built_at: 1, version_id: row.version.id, app_id: appId, deleted: false, entries: [], sizes: [] })
    }
    // Manifest writes take 800 ms, past the prewarm's 500 ms write timeout.
    const put = cache.put.getMockImplementation()!
    let open = 0
    let maxOpen = 0
    cache.put.mockImplementation(async (request: Request, response: Response) => {
      if (!request.url.includes('.plugin-state-manifest-'))
        return put(request, response)
      open++
      maxOpen = Math.max(maxOpen, open)
      try {
        await new Promise(resolve => setTimeout(resolve, 800))
        return await put(request, response)
      }
      finally {
        open--
      }
    })
    const response = call({ app_ids: [appId] }, 'prewarm-secret', env)
    for (let step = 0; step < 80; step++) {
      await new Promise(resolve => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
    }
    const body = await (await response).json() as { results: { error?: string }[] }
    expect(body.results[0].error).toContain('cache write timed out')
    // A timed-out write keeps its payload in memory, so it keeps its slot too.
    expect(maxOpen).toBeLessThanOrEqual(2)
  })

  it('warms each listed app and reports the data center it ran in', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const { env, publish } = providers()
    memoryCache()
    await publishApp(publish)
    const response = await call({ app_ids: [APP_ID, APP_ID, 'com.example.other'] }, 'prewarm-secret', env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      placement: 'remote-CMH',
      colo: null,
      results: [
        { app_id: APP_ID, revision: '5', cached: 4 },
        { app_id: 'com.example.other', revision: null, cached: 1, skipped: 'unpublished' },
      ],
    })
  })
})

describe('plugin state prewarm fan-out (API worker)', () => {
  function context() {
    const raw = new Request('https://api.capgo.app/triggers/updates_cache_purge', { method: 'POST' })
    return { env: {}, req: { url: raw.url, raw, header: () => undefined }, get: () => 'req-prewarm', set: () => {}, executionCtx: undefined } as any
  }

  it('only targets production regions in production, unless targets are configured', () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    expect(pluginStatePrewarmTargets(context())).toEqual([])
    vi.stubEnv('ENV_NAME', 'capgo_api-preprod')
    expect(pluginStatePrewarmTargets(context())).toEqual([])
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    expect(pluginStatePrewarmTargets(context())).toEqual(PLUGIN_REGIONS)
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    vi.stubEnv('PLUGIN_REGION_TARGETS', JSON.stringify([{ name: 'local', envName: 'capgo_plugin-local', url: 'http://localhost:8788/ok' }]))
    expect(pluginStatePrewarmTargets(context()).map(region => region.url)).toEqual(['http://localhost:8788/ok'])
  })

  it('posts batches of at most 10 app ids to each regional hostname, three connections at a time', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    let open = 0
    let maxOpen = 0
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      open++
      maxOpen = Math.max(maxOpen, open)
      await new Promise(resolve => setTimeout(resolve, 1))
      open--
      const appIds = JSON.parse(String(init.body)).app_ids as string[]
      if (url.includes('plugin.jp.'))
        return new Response('{}', { status: 503 })
      return Response.json({ placement: `remote-${new URL(url).hostname.split('.')[1]}`, results: appIds.map(app_id => ({ app_id, revision: '1', cached: 1 })) })
    })
    vi.stubGlobal('fetch', fetchMock)
    const appIds = Array.from({ length: 25 }, (_, index) => `com.example.app${index}`)
    const results = await prewarmPluginStateRegions(context(), [...appIds, appIds[0]])

    expect(fetchMock).toHaveBeenCalledTimes(PLUGIN_REGIONS.length * 3)
    // Half of the six per-invocation connections: the drain keeps the rest.
    expect(maxOpen).toBe(3)
    const urls = new Set(fetchMock.mock.calls.map(([url]) => url))
    expect([...urls].sort()).toEqual(PLUGIN_REGIONS.map(region => `${new URL(region.url).origin}/plugin_state/prewarm`).sort())
    const sentByHost = new Map<string, string[]>()
    for (const [url, init] of fetchMock.mock.calls) {
      expect(new Headers(init.headers).get('apisecret')).toBe('prewarm-secret')
      expect(init.redirect).toBe('manual')
      const batch = JSON.parse(String(init.body)).app_ids as string[]
      expect(batch.length).toBeLessThanOrEqual(10)
      const host = new URL(url).hostname
      sentByHost.set(host, [...(sentByHost.get(host) ?? []), ...batch])
    }
    // Every region receives each app exactly once.
    expect(sentByHost.size).toBe(PLUGIN_REGIONS.length)
    for (const ids of sentByHost.values())
      expect([...ids].sort()).toEqual([...appIds].sort())
    // One entry per batch and region, regions in configured order within each batch.
    expect(results.map(region => region.region)).toEqual([0, 1, 2].flatMap(() => PLUGIN_REGIONS.map(region => region.name)))
    expect(results.filter(region => region.region === 'jp')).toHaveLength(3)
    expect(results.filter(region => region.region === 'jp').every(region => region.error === 'http_error' && region.status === 503)).toBe(true)
    expect(results.find(region => region.region === 'na')).toMatchObject({ status: 200, placement: 'remote-na', error: null })
  })

  it('takes the data center from the cf-placement response header Cloudflare adds to placed workers', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const placed = !url.includes('plugin.jp.')
      return Response.json({ placement: null, results: [] }, { headers: placed ? { 'cf-placement': 'remote-CMH' } : {} })
    }))
    const results = await prewarmPluginStateRegions(context(), [APP_ID])
    expect(results.find(region => region.region === 'na')?.placement).toBe('remote-CMH')
    expect(results.find(region => region.region === 'jp')?.placement).toBeNull()
  })

  it('shares three connections across overlapping prewarm runs of one invocation', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    let open = 0
    let maxOpen = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      open++
      maxOpen = Math.max(maxOpen, open)
      await new Promise(resolve => setTimeout(resolve, 2))
      open--
      return Response.json({ placement: null, results: [] })
    }))
    // Two purge batches of one drain (one invocation), prewarmed at the same time.
    const drain = context()
    await Promise.all([prewarmPluginStateRegions(drain, ['com.example.a']), prewarmPluginStateRegions(drain, ['com.example.b'])])
    expect(maxOpen).toBe(3)
  })

  it('keeps slots per invocation, so one stuck invocation cannot stall another', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    // Invocation A's calls never answer (as if it was cancelled mid-flight).
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      if (JSON.parse(String(init.body)).app_ids[0] === 'com.example.stuck')
        return new Promise<never>(() => {})
      return Response.json({ placement: null, results: [] })
    }))
    void prewarmPluginStateRegions(context(), ['com.example.stuck'])
    const other = await prewarmPluginStateRegions(context(), ['com.example.free'])
    expect(other).toHaveLength(PLUGIN_REGIONS.length)
    expect(other.every(region => region.status === 200)).toBe(true)
  })

  it('reports calls it could not start inside the total budget instead of sending them late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    // Every call takes 7 s: two rounds of three fit before the 12 s last start.
    const fetchMock = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 7000))
      return Response.json({ placement: null, results: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const appIds = Array.from({ length: 20 }, (_, index) => `com.example.app${index}`)
    const pending = prewarmPluginStateRegions(context(), appIds)
    await vi.advanceTimersByTimeAsync(30_000)
    const results = await pending
    expect(results).toHaveLength(PLUGIN_REGIONS.length * 2)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(results.filter(region => region.error === 'budget_exhausted')).toHaveLength(PLUGIN_REGIONS.length * 2 - 6)
  })

  it('calls nothing without targets, and fails loudly without the API secret', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    expect(await prewarmPluginStateRegions(context(), [APP_ID])).toEqual([])
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', '')
    await expect(prewarmPluginStateRegions(context(), [APP_ID])).rejects.toBeInstanceOf(PrewarmNotConfigured)
    expect(fetchMock).not.toHaveBeenCalled()
    // The background run logs it instead of reporting zero regions.
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    schedulePluginStatePrewarm(context(), [APP_ID], 0)
    await vi.waitFor(() => expect(error.mock.calls.flat().join(' ')).toContain('plugin state prewarm failed'))
  })

  it('reports requested apps missing from a 2xx answer, and logs failed calls with their status', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('plugin.jp.'))
        return new Response('{}', { status: 401 })
      return Response.json({ placement: null, results: [{ app_id: 'com.example.one', revision: '1', cached: 1 }] })
    }))
    const results = await prewarmPluginStateRegions(context(), ['com.example.one', 'com.example.two'])
    expect(results.find(region => region.region === 'na')?.results).toEqual([
      { app_id: 'com.example.one', revision: '1', cached: 1 },
      { app_id: 'com.example.two', revision: null, cached: 0, error: 'missing_result' },
    ])
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    schedulePluginStatePrewarm(context(), ['com.example.one', 'com.example.two'], 0)
    await vi.waitFor(() => expect(log.mock.calls.flat()).toContain('plugin state prewarmed'))
    const call = log.mock.calls.find(args => args.includes('plugin state prewarmed'))!
    const failed = call[call.indexOf('failed') + 1] as string[]
    expect(failed).toContain('jp:http_error:401')
    expect(failed).toContain('na:com.example.two:missing_result')
  })

  it('prewarms the plugin_state apps of a successful purge batch after the purge', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-local')
    vi.stubEnv('PLUGIN_REGION_TARGETS', JSON.stringify([{ name: 'local', envName: 'capgo_plugin-local', url: 'http://localhost:8788/ok' }]))
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const order: string[] = []
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('/plugin_state/prewarm')) {
        order.push(`prewarm:${JSON.parse(String(init.body)).app_ids.join(',')}`)
        return Response.json({ placement: null, results: [] })
      }
      order.push('purge')
      return Response.json({ success: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    const claims: unknown[] = [{
      status: 'ok',
      lease_token: 'lease-1',
      apps: [
        { app_id: 'com.example.snapshot', scope: 'plugin_state', initial: true },
        { app_id: 'com.example.db', scope: 'app', initial: true },
      ],
      has_more: false,
    }]
    const rpc = vi.fn(async (fn: string) => ({ data: fn === 'claim_updates_cache_purge' ? claims.shift() ?? { status: 'empty' } : null, error: null }))

    await drainUpdatesCachePurge(context(), rpc)
    await vi.waitFor(() => expect(order).toContain('prewarm:com.example.snapshot'), { timeout: 3000 })
    expect(order.indexOf('purge')).toBeLessThan(order.indexOf('prewarm:com.example.snapshot'))
    expect(order.filter(entry => entry.startsWith('prewarm'))).toEqual(['prewarm:com.example.snapshot'])
  })

  it('does not prewarm after a failed purge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn(async (_url: string) => new Response('{}', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const claims: unknown[] = [{ status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.example.snapshot', scope: 'plugin_state', initial: true }], has_more: false }]
    const rpc = vi.fn(async (fn: string) => ({ data: fn === 'claim_updates_cache_purge' ? claims.shift() ?? { status: 'empty' } : null, error: null }))
    await drainUpdatesCachePurge(context(), rpc)
    // Past the post-purge delay: a scheduled prewarm would have been sent by now.
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalled()
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/plugin_state/prewarm'))).toBe(false)
  })

  it('skips the prewarm on malformed targets without failing the purge drain', async () => {
    vi.stubEnv('PLUGIN_REGION_TARGETS', 'not json')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(pluginStatePrewarmTargets(context())).toEqual([])
    vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'token')
    vi.stubEnv('CF_CACHE_PURGE_ZONE_IDS', 'zone-a')
    const fetchMock = vi.fn(async (_url: string) => Response.json({ success: true }))
    vi.stubGlobal('fetch', fetchMock)
    const claims: unknown[] = [
      { status: 'ok', lease_token: 'lease-1', apps: [{ app_id: 'com.example.a', scope: 'plugin_state', initial: true }], has_more: true },
      { status: 'ok', lease_token: 'lease-2', apps: [{ app_id: 'com.example.b', scope: 'plugin_state', initial: true }], has_more: false },
    ]
    const rpc = vi.fn(async (fn: string) => ({ data: fn === 'claim_updates_cache_purge' ? claims.shift() ?? { status: 'empty' } : null, error: null }))
    await expect(drainUpdatesCachePurge(context(), rpc)).resolves.toEqual({ purgedApps: 2, purgedAppIds: ['com.example.a', 'com.example.b'] })
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/plugin_state/prewarm'))).toBe(false)
  })

  it('logs app-level failures of region calls that answered', async () => {
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({
      placement: null,
      results: url.includes('plugin.na.')
        ? [{ app_id: APP_ID, revision: null, cached: 0, error: 'published value timed out' }]
        : [{ app_id: APP_ID, revision: '1', cached: 1 }],
    })))
    schedulePluginStatePrewarm(context(), [APP_ID], 0)
    await vi.waitFor(() => expect(log.mock.calls.flat()).toContain('plugin state prewarmed'))
    const call = log.mock.calls.find(args => args.includes('plugin state prewarmed'))!
    const entry: Record<string, unknown> = {}
    for (let i = 0; i + 1 < call.length; i += 2)
      entry[String(call[i])] = call[i + 1]
    expect(entry).toMatchObject({ failed: [`na:${APP_ID}:published value timed out`], failed_count: 1, cached: PLUGIN_REGIONS.length - 1 })
  })

  it('waits for the purge to propagate before refilling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubEnv('ENV_NAME', 'capgo_api-prod')
    vi.stubEnv('API_SECRET', 'prewarm-secret')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async () => Response.json({ placement: null, results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    schedulePluginStatePrewarm(context(), [APP_ID], 1000)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(PLUGIN_REGIONS.length)
  })
})
