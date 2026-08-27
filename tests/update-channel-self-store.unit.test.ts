import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppOwnerPostgresMock = vi.fn()
const requestInfosPostgresMock = vi.fn()
const requestInfosChannelPostgresMock = vi.fn()
const requestInfosChannelDevicePostgresMock = vi.fn()
const getChannelSelfOverrideMock = vi.fn()
const getDevicePluginVersionPgMock = vi.fn()

;(globalThis as any).EdgeRuntime = undefined

const getAppStatusMock = vi.fn(async (): Promise<{ status: 'cloud' | 'onprem' | 'cancelled' | null, allow_device_custom_id: boolean, block_provider_infra_requests: boolean, cacheHit: boolean }> => ({ status: null, allow_device_custom_id: true, block_provider_infra_requests: false, cacheHit: false }))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: getAppStatusMock,
  setAppStatus: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfStore.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/plugin_runtime/utils/channelSelfStore.ts')>()
  return {
    ...actual,
    getChannelSelfOverride: getChannelSelfOverrideMock,
    isChannelSelfStoreEnabled: vi.fn(() => true),
  }
})

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
  getDevicePluginVersionPg: getDevicePluginVersionPgMock,
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: vi.fn(() => Promise.resolve({ client: 'pg' })),
  requestInfosChannelDevicePostgres: requestInfosChannelDevicePostgresMock,
  requestInfosChannelPostgres: requestInfosChannelPostgresMock,
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
    getDevicePluginVersionPgMock.mockResolvedValue('7.33.0')
    getAppStatusMock.mockResolvedValue({ status: null, allow_device_custom_id: true, block_provider_infra_requests: false, cacheHit: false })
    requestInfosChannelPostgresMock.mockResolvedValue(null)
    requestInfosChannelDevicePostgresMock.mockResolvedValue(null)
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

  it('queries KV-backed channel_self override only for legacy device plugin versions', async () => {
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
    getDevicePluginVersionPgMock.mockResolvedValue('7.34.0')

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
    getDevicePluginVersionPgMock.mockResolvedValue('7.33.0')

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

  it('reuses cloud channel prefetch and skips requestInfosPostgres', async () => {
    const { updateWithPG } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    getAppStatusMock.mockResolvedValue({
      status: 'cloud',
      allow_device_custom_id: true,
      block_provider_infra_requests: false,
      cacheHit: true,
    })
    requestInfosChannelPostgresMock.mockResolvedValue({
      version: {
        id: 1,
        name: '1.0.0',
        external_url: null,
        r2_path: 'app/1.0.0.zip',
        checksum: null,
        session_key: null,
        storage_provider: 'r2',
        min_update_version: null,
        comment: null,
        link: null,
      },
      channels: {
        id: 7,
        name: 'production',
        allow_device_self_set: false,
        public: true,
        disable_auto_update: 'major',
        disable_auto_update_under_native: true,
        ios: true,
        android: true,
        electron: false,
      },
    } as any)
    getAppOwnerPostgresMock.mockResolvedValue({
      allow_device_custom_id: true,
      channel_device_count: 0,
      expose_metadata: false,
      manifest_bundle_count: 0,
      rollout_channel_count: 0,
      rollout_paused_version_names: [],
      owner_org: 'test-org',
      orgs: { management_email: 'owner@example.com' },
      plan_valid: true,
      block_provider_infra_requests: false,
    })
    getChannelSelfOverrideMock.mockResolvedValue(null)
    getDevicePluginVersionPgMock.mockResolvedValue('7.34.0')

    const app = new Hono()
    app.get('/', c => updateWithPG(c, {
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      platform: 'ios',
      version_build: '1.0.0',
      version_name: '1.0.0',
      version_os: '17.0',
      plugin_version: '7.34.0',
      defaultChannel: '',
      is_emulator: false,
      is_prod: true,
    }, {} as any))

    const response = await app.fetch(new Request('http://localhost/'), { CHANNEL_SELF_STORE: {} }, { waitUntil: () => { } } as any)
    expect(response.status).toBe(200)
    expect(requestInfosChannelPostgresMock).toHaveBeenCalled()
    expect(requestInfosPostgresMock).not.toHaveBeenCalled()
  })

})
