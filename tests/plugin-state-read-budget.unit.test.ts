import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { MAX_PLUGIN_STATE_DOCUMENTS, PLUGIN_STATE_READ_CONCURRENCY, withPluginStateDocument } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateReadBudget.ts'
import { PluginStateMiss } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateRegistry.ts'

describe('plugin state request document budget', () => {
  it('caps simultaneous document loads and completes queued work', async () => {
    let active = 0
    let peak = 0
    const app = new Hono()
    app.get('/', async (c) => {
      const values = await Promise.all(Array.from({ length: MAX_PLUGIN_STATE_DOCUMENTS }, (_, i) => withPluginStateDocument(c, `key-${i}`, async () => {
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
        return i
      })))
      return c.json(values)
    })
    const response = await app.request('/')
    expect(response.status).toBe(200)
    expect(await response.json()).toHaveLength(MAX_PLUGIN_STATE_DOCUMENTS)
    expect(peak).toBe(PLUGIN_STATE_READ_CONCURRENCY)
    expect(active).toBe(0)
  })

  it('rejects oversized key fanout before issuing extra provider work', async () => {
    const load = vi.fn(async () => {
      await Promise.resolve()
      return 1
    })
    const app = new Hono()
    app.get('/', async (c) => {
      const reads = Array.from({ length: 1000 }, (_, i) => withPluginStateDocument(c, `key-${i}`, load))
      const results = await Promise.allSettled(reads)
      expect(results.some(result => result.status === 'rejected' && result.reason instanceof PluginStateMiss)).toBe(true)
      await expect(withPluginStateDocument(c, 'after-fallback', load)).rejects.toBeInstanceOf(PluginStateMiss)
      return c.json({ fallback: true })
    })
    expect((await app.request('/')).status).toBe(200)
    expect(load).toHaveBeenCalledTimes(PLUGIN_STATE_READ_CONCURRENCY)
  })

  it('does not share a consumed budget with the next device request', async () => {
    const app = new Hono()
    app.get('/', async (c) => {
      const result = await withPluginStateDocument(c, 'one-key', async () => true)
      return c.json({ result })
    })
    const responses = await Promise.all(Array.from({ length: 20 }, () => app.request('/')))
    expect(responses.every(response => response.status === 200)).toBe(true)
  })
})
