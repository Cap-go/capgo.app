import type { KVNamespace } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetPluginStateMemory, startPluginStateRequest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginState.ts'
import { pluginStateAppKey, pluginStateImmutableKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { PluginStateMiss } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateRegistry.ts'
import { R2_POINTER_TIMEOUT_MS, readPublishedPluginState, startPluginStateReadMetrics } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts'

const KEY = 'ps1:a:com.example.publication'

afterEach(() => {
  resetPluginStateMemory()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('published plugin state reader', () => {
  it('falls back on a stalled R2 read and discards an object arriving after the deadline', async () => {
    vi.useFakeTimers()
    const pendingObject = Promise.withResolvers<{ json: ReturnType<typeof vi.fn>, body: { cancel: ReturnType<typeof vi.fn> } }>()
    const get = vi.fn()
    const json = vi.fn()
    const cancel = vi.fn(async () => undefined)
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json(metrics)
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: () => pendingObject.promise },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toMatchObject({ r2_pointer_reads: 1, r2_pointer_timeouts: 1, kv_value_reads: 0 })
    pendingObject.resolve({ json, body: { cancel } })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancel).toHaveBeenCalledOnce()
    expect(json).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('also bounds an R2 body that stalls after the headers arrive', async () => {
    vi.useFakeTimers()
    const get = vi.fn()
    const app = new Hono<{ Bindings: { PLUGIN_STATE: KVNamespace } }>()
    app.get('/', async (c) => {
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ fallback: true })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: () => new Promise(() => {}) }) },
    })
    await vi.advanceTimersByTimeAsync(R2_POINTER_TIMEOUT_MS + 1)
    expect(await (await request).json()).toEqual({ fallback: true })
    expect(get).not.toHaveBeenCalled()
  })

  it('bounds stalled KV values and never caches a result arriving after fallback', async () => {
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    const pending = Promise.withResolvers<unknown>()
    const puts = vi.fn()
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined, put: puts }) })
    const appId = 'com.example.kvdeadline'
    const key = await pluginStateImmutableKey(await pluginStateAppKey(appId), '2')
    const app = new Hono()
    app.get('/', async (c) => {
      const metrics = startPluginStateReadMetrics(c)
      const session = await startPluginStateRequest(c, appId, 'device')
      return c.json({ fallback: session === null, metrics })
    })
    const request = app.request('/', undefined, {
      PLUGIN_STATE: { get: () => pending.promise },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: key }) }) },
    })
    const response = await request
    expect(response.headers.get('X-Plugin-State')).toBe('error')
    expect(await response.json()).toMatchObject({ fallback: true, metrics: { r2_pointer_reads: 1, kv_value_reads: 1, kv_value_timeouts: 1 } })
    pending.resolve({ f: 1, app_id: appId, exists: false, built_at: Date.now() })
    await Promise.resolve()
    expect(puts).not.toHaveBeenCalled()
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
      await expect(readPublishedPluginState(c, c.env.PLUGIN_STATE, KEY)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ done: true })
    })
    const response = await app.request('/', undefined, {
      PLUGIN_STATE: { get },
      PLUGIN_STATE_POINTERS: { get: async () => ({ json: async () => ({ f: 1, generation: '2', kvKey: other }) }) },
    })
    expect(response.status).toBe(200)
    expect(get).not.toHaveBeenCalled()
  })
})
