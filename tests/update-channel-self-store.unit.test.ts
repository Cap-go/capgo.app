import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppOwnerPostgresMock = vi.fn()
const requestInfosPostgresMock = vi.fn()
const getChannelSelfOverrideMock = vi.fn()

;(globalThis as any).EdgeRuntime = undefined

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(() => Promise.resolve({ status: null, allow_device_custom_id: true })),
  setAppStatus: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfStore.ts', () => ({
  getChannelSelfOverride: getChannelSelfOverrideMock,
  isChannelSelfStoreEnabled: vi.fn(() => true),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/downloadUrl.ts', () => ({
  getBundleUrl: vi.fn(),
  getManifestUrl: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: vi.fn(() => Promise.resolve()),
  getAppOwnerPostgres: getAppOwnerPostgresMock,
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: vi.fn(() => ({ client: 'pg' })),
  requestInfosPostgres: requestInfosPostgresMock,
  setReplicationLagHeader: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/s3.ts', () => ({
  s3: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  createStatsBandwidth: vi.fn(() => Promise.resolve()),
  createStatsMau: vi.fn(() => Promise.resolve()),
  createStatsVersion: vi.fn(() => Promise.resolve()),
  onPremStats: vi.fn(() => Promise.resolve(new Response('{}'))),
  sendStatsAndDevice: vi.fn(() => Promise.resolve()),
}))

describe('updates channel_self store override routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAppOwnerPostgresMock.mockResolvedValue({
      allow_device_custom_id: true,
      channel_device_count: 12,
      expose_metadata: false,
      manifest_bundle_count: 0,
      owner_org: 'test-org',
      orgs: { management_email: 'owner@example.com' },
      plan_valid: true,
    })
    getChannelSelfOverrideMock.mockResolvedValue({
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      channel_id: {
        id: 42,
      },
    })
    requestInfosPostgresMock.mockRejectedValue(new Error('stop-after-request-infos'))
  })

  it.concurrent('queries KV-backed channel_self override only for old plugin versions', async () => {
    const { updateWithPG } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    const app = new Hono()
    const buildBody = (pluginVersion: string) => ({
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      platform: 'ios',
      version_build: '1.0.0',
      version_name: '1.0.0',
      version_os: '17.0',
      plugin_version: pluginVersion,
      defaultChannel: '',
      is_emulator: false,
      is_prod: true,
    })

    app.get('/old', c => updateWithPG(c, buildBody('7.33.0'), {} as any))
    app.get('/old-missing-kv', c => updateWithPG(c, buildBody('7.33.0'), {} as any))
    app.get('/new', c => updateWithPG(c, buildBody('7.34.0'), {} as any))

    const oldResponse = await app.fetch(new Request('http://localhost/old'), { CHANNEL_SELF_STORE: {} }, { waitUntil: () => { } } as any)

    expect(oldResponse.status).toBe(500)
    expect(getChannelSelfOverrideMock).toHaveBeenCalledOnce()

    expect(requestInfosPostgresMock).toHaveBeenCalledWith(expect.objectContaining({
      app_id: 'com.test.app',
      channelDeviceCount: 12,
      channelSelfOverrideChannelId: 42,
      defaultChannel: '',
      device_id: '11111111-1111-4111-8111-111111111111',
      includeMetadata: false,
      manifestBundleCount: 0,
      platform: 'ios',
    }))

    getChannelSelfOverrideMock.mockClear()
    requestInfosPostgresMock.mockClear()

    const newResponse = await app.fetch(new Request('http://localhost/new'), { CHANNEL_SELF_STORE: {} }, { waitUntil: () => { } } as any)

    expect(newResponse.status).toBe(500)
    expect(getChannelSelfOverrideMock).not.toHaveBeenCalled()
    expect(requestInfosPostgresMock).toHaveBeenCalledWith(expect.objectContaining({
      app_id: 'com.test.app',
      channelDeviceCount: 12,
      channelSelfOverrideChannelId: undefined,
      defaultChannel: '',
      device_id: '11111111-1111-4111-8111-111111111111',
      includeMetadata: false,
      manifestBundleCount: 0,
      platform: 'ios',
    }))

    getChannelSelfOverrideMock.mockResolvedValue(null)
    requestInfosPostgresMock.mockClear()

    const oldMissingKvResponse = await app.fetch(new Request('http://localhost/old-missing-kv'), { CHANNEL_SELF_STORE: {} }, { waitUntil: () => { } } as any)

    expect(oldMissingKvResponse.status).toBe(500)
    expect(getChannelSelfOverrideMock).toHaveBeenCalledOnce()
    expect(requestInfosPostgresMock).toHaveBeenCalledWith(expect.objectContaining({
      app_id: 'com.test.app',
      channelDeviceCount: 12,
      channelSelfOverrideChannelId: undefined,
      defaultChannel: '',
      device_id: '11111111-1111-4111-8111-111111111111',
      includeMetadata: false,
      manifestBundleCount: 0,
      platform: 'ios',
    }))
  })
})
