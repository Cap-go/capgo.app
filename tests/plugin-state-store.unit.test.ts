import type { KVNamespace } from '@cloudflare/workers-types'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetPluginStateMemory, startPluginStateRequest } from '../supabase/functions/_backend/plugin_runtime/utils/pluginState.ts'
import { pluginStateAppKey, pluginStateImmutableKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { PluginStateMiss } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateRegistry.ts'
import { readPublishedPluginState } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts'

const KEY = 'ps1:a:com.example.publication'

afterEach(() => {
  resetPluginStateMemory()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('published plugin state reader', () => {
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
