import type { PluginStateAppDoc, PluginStateVersionDoc } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import * as postgres from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { app as statsApp } from '../supabase/functions/_backend/plugin_runtime/plugins/stats.ts'
import { pluginStateAppKey, pluginStateVersionKey } from '../supabase/functions/_backend/plugin_runtime/utils/pluginStateFormat.ts'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pluginStateStore.ts', () => ({
  readPublishedPluginState: async (_context: unknown, store: { get: (key: string, options: object) => unknown }, key: string) => ({ value: await store.get(key, { type: 'json', cacheTtl: 30 }), revision: null }),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  serializeError: vi.fn(error => error),
}))

// Exercise the Cloudflare analytics bindings instead of the Deno-only
// Supabase fallback. Keep the handler and analytics writers unmocked.
vi.mock('hono/adapter', async (importOriginal) => ({
  ...await importOriginal<typeof import('hono/adapter')>(),
  getRuntimeKey: () => 'workerd',
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('KV stats batch sink writes', () => {
  it('records both get and set once through the real KV handler and Analytics Engine adapter', async () => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', 'true')
    vi.stubEnv('PLUGIN_STATE_KV_STRICT', 'true')
    vi.stubGlobal('caches', undefined)
    const appId = 'com.example.kvstatssink'
    const orgId = '00000000-0000-4000-8000-000000000007'
    const versionName = '1.2.3'
    const getDevice = '00000000-0000-4000-8000-000000000011'
    const setDevice = '00000000-0000-4000-8000-000000000012'
    const appDoc: PluginStateAppDoc = {
      f: 1,
      app_id: appId,
      built_at: Date.now(),
      exists: true,
      owner: {
        owner_org: orgId,
        orgs: { id: orgId, created_by: '00000000-0000-4000-8000-000000000008', management_email: 'kv-stats-test@example.com' },
        allow_device_custom_id: true,
        block_provider_infra_requests: false,
        channel_device_count: 0,
        manifest_bundle_count: 0,
        rollout_channel_count: 0,
        rollout_paused_version_names: [],
        expose_metadata: false,
      },
      plan: { customer_id: null, has_credits: false, stripe: null },
      channels: [],
      overrides: {},
    }
    const versionDoc: PluginStateVersionDoc = { id: 12, owner_org: orgId, deleted: false }
    const docs = new Map<string, unknown>([
      [await pluginStateAppKey(appId), appDoc],
      [await pluginStateVersionKey(appId, versionName), versionDoc],
    ])
    const logs: unknown[] = []
    const versions: unknown[] = []
    const devices: unknown[] = []
    const usage: unknown[] = []
    const store = { get: vi.fn(async (key: string) => docs.get(key) ?? null) }
    const baseEvent = {
      app_id: appId,
      platform: 'android',
      version_build: '1.0.0',
      version_name: versionName,
      plugin_version: '8.53.0',
      version_os: '17',
      is_emulator: false,
      is_prod: true,
    }
    const response = await statsApp.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { ...baseEvent, device_id: getDevice, action: 'get' },
        { ...baseEvent, device_id: setDevice, action: 'set' },
      ]),
    }, {
      PLUGIN_STATE: store,
      PLUGIN_STATE_KV: 'on',
      PLUGIN_STATE_KV_AUTHORITATIVE: 'true',
      PLUGIN_STATE_KV_STRICT: 'true',
      CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
      APP_LOG: { writeDataPoint: (point: unknown) => logs.push(point) },
      VERSION_USAGE: { writeDataPoint: (point: unknown) => versions.push(point) },
      DEVICE_INFO: { writeDataPoint: (point: unknown) => devices.push(point) },
      DEVICE_USAGE: { writeDataPoint: (point: unknown) => usage.push(point) },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('X-Plugin-State')).toBe('kv')
    expect(await response.json()).toEqual({ status: 'ok', results: [{ status: 'ok', index: 0 }, { status: 'ok', index: 1 }] })
    const point = z.object({ indexes: z.array(z.string()), blobs: z.array(z.string()) })
    const writtenLogs = logs.map(value => point.parse(value))
    expect(writtenLogs.map(value => ({ app: value.indexes[0], device: value.blobs[0], action: value.blobs[1], version: value.blobs[2] }))).toEqual([
      { app: appId, device: getDevice, action: 'get', version: versionName },
      { app: appId, device: setDevice, action: 'set', version: versionName },
    ])
    expect(versions.map(value => point.parse(value).blobs.slice(0, 3))).toEqual([[appId, versionName, 'install']])
    expect(usage.map(value => point.parse(value).blobs[0]).sort()).toEqual([getDevice, setDevice])
    expect(devices.map(value => point.parse(value).blobs[0])).toEqual([getDevice, setDevice])
    expect(store.get.mock.calls.map(([key]) => key).sort()).toEqual([...docs.keys()].sort())
  })

  it('bounds oversized distinct-version batches and falls back before writing any stats', async () => {
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    vi.stubEnv('PLUGIN_STATE_KV', 'on')
    vi.stubEnv('PLUGIN_STATE_KV_AUTHORITATIVE', 'true')
    vi.stubGlobal('caches', undefined)
    const replica = vi.spyOn(postgres, 'getPgClient').mockRejectedValue(new Error('injected replica outage'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const appId = 'com.example.kvstatsbudget'
    const appKey = await pluginStateAppKey(appId)
    const appDoc: PluginStateAppDoc = {
      f: 1, app_id: appId, built_at: Date.now(), exists: true,
      owner: { owner_org: '00000000-0000-4000-8000-000000000007', block_provider_infra_requests: false, channel_device_count: 0 },
      plan: { customer_id: null, has_credits: false, stripe: null }, channels: [], overrides: {},
    }
    const get = vi.fn(async (key: string) => {
      if (key === appKey)
        return appDoc
      throw new Error('oversized batch attempted per-version state reads')
    })
    const sink = vi.fn()
    const response = await statsApp.request('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.from({ length: 100 }, (_, i) => ({
        app_id: appId, device_id: '00000000-0000-4000-8000-000000000012', action: 'get',
        platform: 'android', version_build: '1.0.0', version_name: `1.2.${i}`,
        plugin_version: '8.53.0', version_os: '17', is_emulator: false, is_prod: true,
      }))),
    }, {
      PLUGIN_STATE: { get }, PLUGIN_STATE_KV: 'on', CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
      APP_LOG: { writeDataPoint: sink }, VERSION_USAGE: { writeDataPoint: sink },
      DEVICE_INFO: { writeDataPoint: sink }, DEVICE_USAGE: { writeDataPoint: sink },
    })
    // Only the external replica was failed: the public handler reached its
    // existing fallback before recording anything or reading version keys.
    expect(response.status).toBe(500)
    expect(replica).toHaveBeenCalledOnce()
    expect(replica.mock.calls[0][1]).toBe(true)
    expect(get).toHaveBeenCalledExactlyOnceWith(appKey, { type: 'json', cacheTtl: 30 })
    expect(sink).not.toHaveBeenCalled()
  })
})
