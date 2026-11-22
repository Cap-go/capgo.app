import type { KVNamespace } from '@cloudflare/workers-types'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetPluginStateMemory, startPluginStateRequest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginState.ts'
import { pluginStateAppKey, pluginStateImmutableKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { PluginStateMiss } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateRegistry.ts'
import { LATE_READ_TIMEOUT_MS, R2_POINTER_TIMEOUT_MS, readPublishedPluginState, startPluginStateReadMetrics } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts'

const KEY = 'ps1:a:com.example.publication'

/** Shared Cache API stand-in that records each stored publication revision. */
function memoryCache() {
  const entries = new Map<string, { body: string, headers: Headers }>()
  return {
    match: async (request: Request) => {
      const entry = entries.get(request.url)
      return entry ? new Response(entry.body, { headers: entry.headers }) : undefined
    },
    put: vi.fn(async (request: Request, response: Response) => { entries.set(request.url, { body: await response.text(), headers: new Headers(response.headers) }) }),
    revisions: () => [...entries.values()].map(entry => entry.headers.get('X-Plugin-State-Revision')),
  }
}

/** `plugin_state_refill` lines, rebuilt from the key/value console arguments of cloudlog. */
function refillLogs(log: { mock: { calls: unknown[][] } }) {
  return log.mock.calls
    .filter(call => call.includes('plugin_state_refill'))
    .map((call) => {
      const entry: Record<string, unknown> = {}
      for (let i = 0; i + 1 < call.length; i += 2)
        entry[String(call[i])] = call[i + 1]
      return entry
    })
}

beforeEach(() => {
  // crypto.subtle settles on the real event loop, outside fake timers, so on a
  // busy CI runner the fake clock can move on before a key hash finishes (a
  // measured 300 ms read came out as 500 ms). Hash synchronously instead: the
  // same digest, settled within the awaited microtasks.
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = (typeof algorithm === 'string' ? algorithm : algorithm.name).toLowerCase().replace('-', '')
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    const digest = createHash(name).update(Buffer.from(bytes)).digest()
    return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength) as ArrayBuffer
  })
})

afterEach(() => {
  resetPluginStateMemory()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('published plugin state reader', () => {
  it('cancels a stalled cached body and reads the current publication instead', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers()
    const appId = 'com.example.cached-body-deadline'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '2')
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    const cached = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"v":')) },
      cancel,
    }), { headers: { 'X-Plugin-State-Revision': '1' } })
    vi.stubGlobal('caches', { open: async () => ({ match: async () => cached, put: vi.fn() }) })
    const getValue = vi.fn(async () => ({ f: 1, app_id: appId, built_at: 2, exists: false }))
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ builtAt: session?.doc.built_at })
    })
    const response = app.request('/', undefined, {
      PLUGIN_STATE: { get: getValue },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: key }) }) },
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await (await response).json()).toEqual({ builtAt: 2 })
    expect(cancel).toHaveBeenCalledOnce()
    expect(getValue).toHaveBeenCalledOnce()
    expect(cached.body?.locked).toBe(false)
  })

  it('decodes a cached body split across UTF-8 character boundaries', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    const appId = 'com.example.cached-utf8'
    const body = new TextEncoder().encode(JSON.stringify({ v: { f: 1, app_id: appId, built_at: 1, exists: false, note: 'é' } }))
    const split = body.indexOf(0xC3) + 1
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(body.slice(0, split))
        controller.enqueue(body.slice(split))
        controller.close()
      },
    })) }) })
    const getValue = vi.fn()
    const app = new Hono()
    app.get('/', async (c) => c.json({ exists: (await startPluginStateRequest(c, appId, 'device'))?.exists }))
    expect(await (await app.request('/', undefined, { PLUGIN_STATE: { get: getValue } })).json()).toEqual({ exists: false })
    expect(getValue).not.toHaveBeenCalled()
  })

  it('does not await stalled body cancellation when reusing parsed memory', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const appId = 'com.example.cached-memory-cancel'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '1')
    const doc = { f: 1, app_id: appId, built_at: 1, exists: false }
    const cancel = vi.fn(() => new Promise<void>(() => {}))
    let cached = false
    vi.stubGlobal('caches', { open: async () => ({
      match: async () => cached ? new Response(new ReadableStream({ cancel }), { headers: { 'X-Plugin-State-Revision': '1' } }) : undefined,
      put: async () => { cached = true },
    }) })
    const getValue = vi.fn(async () => doc)
    const bindings = {
      PLUGIN_STATE: { get: getValue },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '1', kvKey: key }) }) },
    }
    const app = new Hono()
    app.get('/', async c => c.json({ exists: (await startPluginStateRequest(c, appId, 'device'))?.exists }))
    expect(await (await app.request('/', undefined, bindings)).json()).toEqual({ exists: false })
    vi.useFakeTimers()
    const response = Promise.race([
      app.request('/', undefined, bindings),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('memory reuse stalled')), 1000)),
    ])
    await vi.advanceTimersByTimeAsync(1000)
    expect(await (await response).json()).toEqual({ exists: false })
    expect(cancel).toHaveBeenCalledOnce()
    expect(getValue).toHaveBeenCalledOnce()
  })

  it.each(['true', 'false'])('falls back for cold and cached unpublished apps with authoritative mode %s', async (authoritative) => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', authoritative)
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const entries = new Map<string, { body: string, headers: Headers }>()
    const cache = {
      match: async (request: Request) => {
        const entry = entries.get(request.url)
        return entry ? new Response(entry.body, { headers: entry.headers }) : undefined
      },
      put: vi.fn(async (request: Request, response: Response) => { entries.set(request.url, { body: await response.text(), headers: response.headers }) }),
    }
    vi.stubGlobal('caches', { open: async () => cache })
    const getPointer = vi.fn(async () => null)
    const getValue = vi.fn()
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, 'com.example.unpublished', 'device')
      return c.json({ source: session ? 'kv' : 'db', exists: session?.exists ?? null })
    })
    const bindings = { PLUGIN_STATE: { get: getValue }, PLUGIN_STATE_POINTERS: { get: getPointer } }
    for (const resetMemory of [false, false, true]) {
      if (resetMemory)
        resetPluginStateMemory()
      const response = await app.request('/', undefined, bindings)
      expect(await response.json()).toEqual({ source: 'db', exists: null })
      expect(response.headers.get('X-Plugin-State')).toBe('miss')
    }
    expect(getPointer).toHaveBeenCalledOnce()
    expect(getValue).not.toHaveBeenCalled()
    expect(cache.put).toHaveBeenCalledOnce()
  })

  it.each(['true', 'false'])('preserves cold and cached deletion-pointer behavior with authoritative mode %s', async (authoritative) => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', authoritative)
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const entries = new Map<string, { body: string, headers: Headers }>()
    const cache = {
      match: async (request: Request) => {
        const entry = entries.get(request.url)
        return entry ? new Response(entry.body, { headers: entry.headers }) : undefined
      },
      put: async (request: Request, response: Response) => { entries.set(request.url, { body: await response.text(), headers: response.headers }) },
    }
    vi.stubGlobal('caches', { open: async () => cache })
    const getPointer = vi.fn(async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: null }) }))
    const getValue = vi.fn()
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, 'com.example.deleted-pointer', 'device')
      return c.json({ source: session ? 'kv' : 'db', exists: session?.exists ?? null })
    })
    const bindings = { PLUGIN_STATE: { get: getValue }, PLUGIN_STATE_POINTERS: { get: getPointer } }
    for (const resetMemory of [false, false, true]) {
      if (resetMemory)
        resetPluginStateMemory()
      const response = await app.request('/', undefined, bindings)
      expect(await response.json()).toEqual(authoritative === 'true' ? { source: 'kv', exists: false } : { source: 'db', exists: null })
      expect(response.headers.get('X-Plugin-State')).toBe(authoritative === 'true' ? null : 'miss')
    }
    expect(getPointer).toHaveBeenCalledOnce()
    expect(getValue).not.toHaveBeenCalled()
  })

  it('falls back on a stalled R2 read and discards an object arriving after the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const pendingObject = Promise.withResolvers<{ json: ReturnType<typeof vi.fn>, body: { cancel: ReturnType<typeof vi.fn> } }>()
    const observedMetrics = Promise.withResolvers<ReturnType<typeof startPluginStateReadMetrics>>()
    const get = vi.fn()
    const json = vi.fn()
    const cancel = vi.fn(async () => undefined)
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      observedMetrics.resolve(metrics)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json(metrics)
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: () => pendingObject.promise },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toMatchObject({
      r2_pointer_reads: 1, r2_pointer_timeouts: 1, kv_value_reads: 0,
      r2_pointer_headers_timeouts: 1, r2_pointer_body_timeouts: 0,
      r2_pointer_headers_ms: R2_POINTER_TIMEOUT_MS, r2_pointer_body_ms: 0,
      r2_pointer_first_failure: 'headers_timeout',
    })
    const metrics = await observedMetrics.promise
    const frozen = structuredClone(metrics)
    pendingObject.resolve({ json, body: { cancel } })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
    expect(metrics).toEqual(frozen)
    expect(get).not.toHaveBeenCalled()
  })

  it('shares the original deadline with body decoding and freezes late-body diagnostics', async () => {
    const key = await pluginStateImmutableKey(KEY, '2')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const pendingBody = Promise.withResolvers<unknown>()
    const observedMetrics = Promise.withResolvers<ReturnType<typeof startPluginStateReadMetrics>>()
    const get = vi.fn()
    const cancel = vi.fn(async () => undefined)
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      observedMetrics.resolve(metrics)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json(metrics)
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return { json: () => pendingBody.promise, body: { cancel } }
      } },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toMatchObject({
      r2_pointer_reads: 1, r2_pointer_timeouts: 1, kv_value_reads: 0,
      r2_pointer_headers_timeouts: 0, r2_pointer_body_timeouts: 1,
      r2_pointer_headers_ms: 15, r2_pointer_body_ms: R2_POINTER_TIMEOUT_MS - 15,
      r2_pointer_ms: R2_POINTER_TIMEOUT_MS, r2_pointer_first_failure: 'body_timeout',
    })
    const metrics = await observedMetrics.promise
    const frozen = structuredClone(metrics)
    pendingBody.resolve({ f: 1, generation: '2', kvKey: key })
    await vi.advanceTimersByTimeAsync(100)
    expect(metrics).toEqual(frozen)
    expect(cancel).toHaveBeenCalledOnce()
    expect(get).not.toHaveBeenCalled()
  })

  it('bounds stalled KV values and caches the late value for the next request', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const pending = Promise.withResolvers<unknown>()
    const cache = memoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    const appId = 'com.example.kvdeadline'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '2')
    const getValue = vi.fn(() => pending.promise)
    const getPointer = vi.fn(async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: key }) }))
    const app = new Hono()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ fallback: session === null, metrics })
    })
    const bindings = { PLUGIN_STATE: { get: getValue }, PLUGIN_STATE_POINTERS: { get: getPointer } }
    const response = await app.request('/', undefined, bindings)
    expect(response.headers.get('X-Plugin-State')).toBe('cold')
    expect(await response.json()).toMatchObject({ fallback: true, metrics: { r2_pointer_reads: 1, kv_value_reads: 1, kv_value_timeouts: 1 } })
    expect(cache.put).not.toHaveBeenCalled()
    pending.resolve({ f: 1, app_id: appId, exists: false, built_at: Date.now() })
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce())
    expect(cache.revisions()).toEqual(['2'])
    const warm = await app.request('/', undefined, bindings)
    expect(warm.headers.get('X-Plugin-State')).toBeNull()
    expect(await warm.json()).toMatchObject({ fallback: false, metrics: { r2_pointer_reads: 0, kv_value_reads: 0 } })
    expect(getPointer).toHaveBeenCalledOnce()
    expect(getValue).toHaveBeenCalledOnce()
  })

  it('refills a late pointer in the background and sends concurrent cold requests straight to the replica', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cache = memoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    const appId = 'com.example.late-pointer'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '3')
    const pointer = Promise.withResolvers<{ json: () => Promise<unknown> }>()
    const getPointer = vi.fn(() => pointer.promise)
    const getValue = vi.fn(async () => ({ f: 1, app_id: appId, exists: false, built_at: 3 }))
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ source: session ? 'kv' : 'db' })
    })
    const bindings = { PLUGIN_STATE: { get: getValue }, PLUGIN_STATE_POINTERS: { get: getPointer } }
    const first = app.request('/', undefined, bindings)
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    const cold = await first
    expect(await cold.json()).toEqual({ source: 'db' })
    expect(cold.headers.get('X-Plugin-State')).toBe('cold')
    // No timer advance: the concurrent request does not wait for its own deadline.
    const concurrent = await app.request('/', undefined, bindings)
    expect(await concurrent.json()).toEqual({ source: 'db' })
    expect(concurrent.headers.get('X-Plugin-State')).toBe('cold')
    expect(getPointer).toHaveBeenCalledOnce()
    pointer.resolve({ json: async () => ({ f: 1, generation: '3', kvKey: key }) })
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce())
    expect(getValue).toHaveBeenCalledExactlyOnceWith(key, { type: 'json', cacheTtl: 30 })
    const warm = await app.request('/', undefined, bindings)
    expect(await warm.json()).toEqual({ source: 'kv' })
    expect(getPointer).toHaveBeenCalledOnce()
  })

  it('logs a failed refill with its full read time and retries it on the next cold request', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const cache = memoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const appId = 'com.example.failed-refill'
    const getPointer = vi.fn(() => new Promise<never>(() => {}))
    const app = new Hono()
    app.get('/', async (c) => {
      startPluginStateReadMetrics(c)
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ source: session ? 'kv' : 'db' })
    })
    const bindings = { PLUGIN_STATE: { get: vi.fn() }, PLUGIN_STATE_POINTERS: { get: getPointer } }
    const first = app.request('/', undefined, bindings)
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + LATE_READ_TIMEOUT_MS + 1)
    expect((await first).headers.get('X-Plugin-State')).toBe('cold')
    await vi.waitFor(() => expect(refillLogs(log)).toHaveLength(1))
    expect(refillLogs(log)[0]).toMatchObject({ outcome: 'failed', duration_ms: R2_POINTER_TIMEOUT_MS + LATE_READ_TIMEOUT_MS })
    expect(cache.put).not.toHaveBeenCalled()
    const retry = app.request('/', undefined, bindings)
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect((await retry).headers.get('X-Plugin-State')).toBe('cold')
    expect(getPointer).toHaveBeenCalledTimes(2)
  })

  it('logs the provider read time of a cached refill without the cache write', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const cache = memoryCache()
    const put = cache.put.getMockImplementation()!
    cache.put.mockImplementation(async (request, response) => {
      await new Promise(resolve => setTimeout(resolve, 150))
      await put(request, response)
    })
    vi.stubGlobal('caches', { open: async () => cache })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const appId = 'com.example.timed-refill'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '4')
    const app = new Hono()
    app.get('/', async (c) => {
      startPluginStateReadMetrics(c)
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ source: session ? 'kv' : 'db' })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get: async () => ({ f: 1, app_id: appId, exists: false, built_at: 4 }) },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, 300))
        return { json: async () => ({ f: 1, generation: '4', kvKey: key }) }
      } },
    })
    await vi.advanceTimersByTimeAsync(300)
    expect((await request).headers.get('X-Plugin-State')).toBe('cold')
    await vi.advanceTimersByTimeAsync(150)
    await vi.waitFor(() => expect(refillLogs(log)).toHaveLength(1))
    expect(cache.put).toHaveBeenCalledOnce()
    expect(refillLogs(log)[0]).toMatchObject({ outcome: 'cached', duration_ms: 300 })
  })

  it('logs a refill whose cache write did not land as not_cached', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const cache = memoryCache()
    cache.put.mockRejectedValue(new Error('cache unavailable'))
    vi.stubGlobal('caches', { open: async () => cache })
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const appId = 'com.example.refill-not-cached'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '7')
    const app = new Hono()
    app.get('/', async (c) => {
      startPluginStateReadMetrics(c)
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ source: session ? 'kv' : 'db' })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get: async () => ({ f: 1, app_id: appId, exists: false, built_at: 7 }) },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
        return { json: async () => ({ f: 1, generation: '7', kvKey: key }) }
      } },
    })
    await vi.advanceTimersByTimeAsync(100)
    expect((await request).headers.get('X-Plugin-State')).toBe('cold')
    await vi.waitFor(() => expect(refillLogs(log)).toHaveLength(1))
    expect(refillLogs(log)[0]).toMatchObject({ outcome: 'not_cached', duration_ms: 100 })
  })

  it('records R2 and KV operations separately for sampled requests', async () => {
    const current = await pluginStateImmutableKey(KEY, '2')
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      await readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)
      return c.json(metrics)
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get: async () => ({ value: 'new' }) },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: current }) }) },
    })
    expect(await response.json()).toMatchObject({ r2_pointer_reads: 1, r2_pointer_timeouts: 0, kv_value_reads: 1, r2_pointer_ms: expect.any(Number), kv_value_ms: expect.any(Number) })
  })

  it('replaces parsed memory when a new generation shares the same build timestamp', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const entries = new Map<string, { body: string, headers: Headers }>()
    const cache = {
      match: async (request: Request) => {
        const entry = entries.get(request.url)
        return entry ? new Response(entry.body, { headers: entry.headers }) : undefined
      },
      put: async (request: Request, response: Response) => { entries.set(request.url, { body: await response.text(), headers: new Headers(response.headers) }) },
    }
    vi.stubGlobal('caches', { open: async () => cache })
    const appId = 'com.example.revision'
    const builtAt = Date.now()
    const doc = {
      f: 1, app_id: appId, built_at: builtAt, exists: true,
      owner: { owner_org: '00000000-0000-4000-8000-000000000001', block_provider_infra_requests: false },
      plan: { has_credits: false, customer_id: null, stripe: null }, channels: [], overrides: {},
    }
    const immutableKey = await pluginStateImmutableKey(await pluginStateAppKey(appId), '1')
    const get = vi.fn(async () => doc)
    const env = {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '1', kvKey: immutableKey }) }) },
    }
    const app = new Hono()
    app.get('/', async (c) => {
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ blocked: session?.doc.owner?.block_provider_infra_requests })
    })
    expect(await (await app.request('/', undefined, env)).json()).toEqual({ blocked: false })
    expect(entries.size).toBe(1)
    const url = [...entries.keys()][0]
    // Another isolate refills the shared cache after a purge. Its document
    // has the same timestamp but a distinct publication generation.
    entries.set(url, {
      body: JSON.stringify({ v: { ...doc, owner: { ...doc.owner, block_provider_infra_requests: true } } }),
      headers: new Headers({ 'X-Plugin-State-Revision': '2', 'X-Plugin-State-Built-At': String(builtAt) }),
    })
    expect(await (await app.request('/', undefined, env)).json()).toEqual({ blocked: true })
    expect(await (await app.request('/', undefined, env)).json()).toEqual({ blocked: true })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('reads only the immutable generation selected by R2', async () => {
    const current = await pluginStateImmutableKey(KEY, '2')
    const get = vi.fn(async () => ({ value: 'new' }))
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async c => c.json({ value: await readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY) }))
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: current }) }) },
    })
    expect(await response.json()).toEqual({ value: { value: { value: 'new' }, revision: '2' } })
    expect(get).toHaveBeenCalledExactlyOnceWith(current, { type: 'json', cacheTtl: 30 })
  })

  it.each([false, true])('does not query KV for an absent or deleted pointer (%s)', async (deleted) => {
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async c => c.json({ value: await readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY) }))
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => deleted ? { json: async () => ({ f: 1, generation: '2', kvKey: null }) } : null },
    })
    expect(await response.json()).toEqual({ value: { value: null, revision: deleted ? '2' : null } })
    expect(get).not.toHaveBeenCalled()
  })

  it('falls back while the selected immutable value is not visible in KV', async () => {
    const current = await pluginStateImmutableKey(KEY, '2')
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get: async () => null },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: current }) }) },
    })
    expect(response.status).toBe(200)
  })

  it('rejects a pointer referencing another logical key', async () => {
    const other = await pluginStateImmutableKey('ps1:a:com.example.other', '2')
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json(metrics)
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: other }) }) },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ r2_pointer_first_failure: 'invalid_pointer', kv_value_reads: 0 })
    expect(get).not.toHaveBeenCalled()
  })
})

describe('sampled pointer phase diagnostics', () => {
  it('measures successful headers and body separately without changing the value', async () => {
    const key = await pluginStateImmutableKey(KEY, '2')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const get = vi.fn(async () => ({ value: 'new' }))
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      const result = await readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)
      return c.json({ value: result.value, metrics })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, 7))
        return { json: async () => {
          await new Promise(resolve => setTimeout(resolve, 9))
          return { f: 1, generation: '2', kvKey: key }
        } }
      } },
    })
    await vi.advanceTimersByTimeAsync(16)
    expect(await (await request).json()).toMatchObject({ value: { value: 'new' }, metrics: {
      r2_pointer_reads: 1, r2_pointer_headers_ms: 7, r2_pointer_body_ms: 9, r2_pointer_ms: 16,
      r2_pointer_headers_timeouts: 0, r2_pointer_body_timeouts: 0, r2_pointer_first_failure: 'none', kv_value_reads: 1,
    } })
    expect(get).toHaveBeenCalledExactlyOnceWith(key, { type: 'json', cacheTtl: 30 })
  })

  it.each(['headers', 'body'])('preserves a %s error while emitting only a bounded category', async (stage) => {
    const failure = new Error('private-error-message-sentinel')
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBe(failure)
      return c.json(metrics)
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => {
        if (stage === 'headers')
          throw failure
        return { json: async () => { throw failure } }
      } },
    })
    const metrics = await response.json()
    expect(metrics).toMatchObject({ r2_pointer_reads: 1, r2_pointer_timeouts: 0, kv_value_reads: 0, r2_pointer_first_failure: stage === 'headers' ? 'headers_error' : 'body_error' })
    expect(JSON.stringify(metrics)).not.toContain('private-error-message-sentinel')
    expect(get).not.toHaveBeenCalled()
  })

  it('classifies invalid pointer data without logging its contents', async () => {
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toThrow('Invalid plugin state publication pointer')
      return c.json(metrics)
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 0, kvKey: 'private-pointer-key-sentinel' }) }) },
    })
    const metrics = await response.json()
    expect(metrics).toMatchObject({ r2_pointer_first_failure: 'invalid_pointer', kv_value_reads: 0 })
    expect(JSON.stringify(metrics)).not.toContain('private-pointer-key-sentinel')
    expect(get).not.toHaveBeenCalled()
  })

  it('aggregates operations while retaining the first failure category', async () => {
    let reads = 0
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      for (let i = 0; i < 2; i++)
        await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(Error)
      return c.json(metrics)
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get: vi.fn() },
      PLUGIN_STATE_POINTERS: { get: async () => {
        if (reads++ === 0)
          throw new Error('first-private-error-sentinel')
        return { json: async () => { throw new Error('second-private-error-sentinel') } }
      } },
    })
    const metrics = await response.json()
    expect(metrics).toMatchObject({ r2_pointer_reads: 2, kv_value_reads: 0, r2_pointer_first_failure: 'headers_error' })
    expect(JSON.stringify(metrics)).not.toContain('private-error-sentinel')
    expect(metrics).toEqual({
      r2_pointer_reads: 2, r2_pointer_ms: expect.any(Number), r2_pointer_timeouts: 0,
      r2_pointer_headers_ms: expect.any(Number), r2_pointer_body_ms: expect.any(Number),
      r2_pointer_headers_timeouts: 0, r2_pointer_body_timeouts: 0, r2_pointer_first_failure: 'headers_error',
      kv_value_reads: 0, kv_value_ms: 0, kv_value_timeouts: 0,
    })
  })

  it('finishes a late pointer under the background budget without touching request diagnostics', async () => {
    const key = await pluginStateImmutableKey(KEY, '2')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const pendingObject = Promise.withResolvers<{ json: () => Promise<unknown> }>()
    const late = Promise.withResolvers<{ publication: Promise<unknown>, sampledSince: number | null }>()
    const get = vi.fn(async () => ({ value: 'late' }))
    const observedMetrics = Promise.withResolvers<ReturnType<typeof startPluginStateReadMetrics>>()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      observedMetrics.resolve(metrics)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY, (publication, sampledSince) => late.resolve({ publication, sampledSince }))).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json(metrics)
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: () => pendingObject.promise },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toMatchObject({ r2_pointer_reads: 1, r2_pointer_timeouts: 1, r2_pointer_first_failure: 'headers_timeout', kv_value_reads: 0 })
    const metrics = await observedMetrics.promise
    const frozen = structuredClone(metrics)
    const { publication, sampledSince } = await late.promise
    expect(sampledSince).toEqual(expect.any(Number))
    pendingObject.resolve({ json: async () => ({ f: 1, generation: '2', kvKey: key }) })
    expect(await publication).toEqual({ value: { value: 'late' }, revision: '2' })
    expect(get).toHaveBeenCalledExactlyOnceWith(key, { type: 'json', cacheTtl: 30 })
    // The late pointer body and KV read finished without touching the request's counters.
    expect(metrics).toEqual(frozen)
  })

  it('caches a late refill of a miss no longer than a late value', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const cache = memoryCache()
    vi.stubGlobal('caches', { open: async () => cache })
    const pointer = Promise.withResolvers<null>()
    const app = new Hono()
    app.get('/', async c => c.json({ source: (await startPluginStateRequest(c, 'com.example.late-miss', 'device')) ? 'kv' : 'db' }))
    const request = app.request('/', undefined, { PLUGIN_STATE: { get: vi.fn() }, PLUGIN_STATE_POINTERS: { get: () => pointer.promise } })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect((await request).headers.get('X-Plugin-State')).toBe('cold')
    // No pointer: a miss, refilled after the request fell back.
    pointer.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(cache.put).toHaveBeenCalledOnce())
    const [, stored] = cache.put.mock.calls[0] as unknown as [Request, Response]
    // An on-time miss keeps the 60 s negative TTL; a late one only gets the 30 s document TTL.
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=30')
  })

  it('cancels a late pointer body that exceeds the background budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const cancel = vi.fn(async () => undefined)
    // Wrapped: resolving with the promise itself would adopt its state.
    const late = Promise.withResolvers<{ publication: Promise<unknown> }>()
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY, publication => late.resolve({ publication }))).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return { json: () => new Promise<never>(() => {}), body: { cancel } }
      } },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toEqual({ done: true })
    const { publication } = await late.promise
    const settled = expect(publication).rejects.toBeInstanceOf(PluginStateMiss)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(LATE_READ_TIMEOUT_MS)
    await settled
    expect(cancel).toHaveBeenCalledOnce()
    expect(get).not.toHaveBeenCalled()
  })

  it('discards pointer headers arriving after the background budget', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const json = vi.fn()
    const cancel = vi.fn(async () => undefined)
    const late = Promise.withResolvers<{ publication: Promise<unknown> }>()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY, publication => late.resolve({ publication }))).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get: vi.fn() },
      PLUGIN_STATE_POINTERS: { get: async () => {
        await new Promise(resolve => setTimeout(resolve, R2_POINTER_TIMEOUT_MS + LATE_READ_TIMEOUT_MS + 10))
        return { json, body: { cancel } }
      } },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toEqual({ done: true })
    const { publication } = await late.promise
    const settled = expect(publication).rejects.toBeInstanceOf(PluginStateMiss)
    await vi.advanceTimersByTimeAsync(LATE_READ_TIMEOUT_MS + 10)
    await settled
    expect(json).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not read the timing clock for an unsampled request', async () => {
    const key = await pluginStateImmutableKey(KEY, '2')
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('unsampled timing clock called') })
    try {
      const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
      app.get('/', async c => c.json(await readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)))
      const response = await app.request('/', undefined, {
        PLUGIN_STATE: { get: async () => ({ value: 'new' }) },
        PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: key }) }) },
      })
      expect(await response.json()).toEqual({ value: { value: 'new' }, revision: '2' })
      expect(clock).not.toHaveBeenCalled()
    }
    finally {
      clock.mockRestore()
    }
  })
})
