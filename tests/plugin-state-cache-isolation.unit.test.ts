import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppStatus } from '../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts'
import { markPluginStateServed } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateSwitch.ts'
import { setSnippetStatsFill, setSnippetUpdatesFill, SNIPPET_EDGE_FILL_HEADER } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeAnswer.ts'
import { setUpdateReadCache } from '../supabase/functions/_backend/plugin_runtime/utils/updateReadCache.ts'
import { updatesCacheTags } from '../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts'

const APP_ID = 'com.example.canaryisolation'
const answer = { ownerOrg: '00000000-0000-4000-8000-000000000010', allowDeviceCustomId: true, versionName: '1.0.0', keyId: null, planValidUntil: null }

beforeEach(() => {
  vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
  vi.stubEnv('CF_CACHE_PURGE_TOKEN', 'test-purge-token')
  vi.stubEnv('SNIPPET_EDGE_ANSWER', 'on')
  vi.stubEnv('UPDATES_EDGE_CACHE', 'on')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('plugin state canary cache isolation', () => {
  it.each(['updates', 'stats'])('fills no shared cache from KV; teaches the %s snippet only a KV cohort answer', async (endpoint) => {
    const entries = new Map<string, Response>()
    vi.stubGlobal('caches', { open: async () => ({
      put: async (request: Request, response: Response) => { entries.set(request.url, response.clone()) },
    }) })
    const app = new Hono()
    app.get('/:source', async (c) => {
      if (c.req.param('source') === 'kv')
        markPluginStateServed(c)
      await setAppStatus(c, APP_ID, 'cloud', true)
      await setUpdateReadCache(c, { appId: APP_ID, platform: 'ios', defaultChannel: 'production' }, answer)
      if (endpoint === 'updates') {
        await setSnippetUpdatesFill(c, APP_ID, answer, { blockProviderInfraRequests: false, legacyChannelSelfStore: false })
      }
      else {
        await setSnippetStatsFill(c, APP_ID, { blockProviderInfraRequests: false, planValidUntil: null })
      }
      return c.json({ status: 'ok' })
    })
    const env = { PLUGIN_STATE_KV: '0.1%', PLUGIN_STATE: {} }
    // Outside workerd, getEnv reads process.env.
    vi.stubEnv('PLUGIN_STATE_KV', '0.1%')
    const kv = await app.request('/kv', undefined, env)
    // Version 4 + kv: older snippets reject it, newer ones keep it for the cohort.
    const kvFill = JSON.parse(decodeURIComponent(kv.headers.get(SNIPPET_EDGE_FILL_HEADER)!))
    expect(kvFill).toMatchObject({ v: 4, kv: true, ks: 10 })
    expect(entries.size).toBe(0)

    const db = await app.request('/db', undefined, env)
    const dbFill = JSON.parse(decodeURIComponent(db.headers.get(SNIPPET_EDGE_FILL_HEADER)!))
    expect(dbFill.kv).toBeUndefined()
    expect(dbFill.ks).toBe(10)
    expect([...entries.keys()].sort()).toEqual([
      `http://localhost/.app-status-v3?app_id=${APP_ID}`,
      `http://localhost/.update-read-v2?app_id=${APP_ID}&platform=ios&channel=production`,
    ])
  })

  it('leaves DB-cohort cache tagging unchanged when only a KV canary is enabled', async () => {
    vi.stubEnv('UPDATES_EDGE_CACHE', 'off')
    const app = new Hono()
    app.get('/', c => c.json({ tags: updatesCacheTags(c, APP_ID) ?? null }))
    const response = await app.request('/', undefined, { PLUGIN_STATE_KV: '0.1%', PLUGIN_STATE: {} })
    expect(await response.json()).toEqual({ tags: null })
  })
})
