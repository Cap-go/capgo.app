import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppOwnerPostgresMock = vi.fn()
const requestInfosPostgresMock = vi.fn()
const getBundleUrlMock = vi.fn()
const sendStatsAndDeviceMock = vi.fn(() => Promise.resolve())

;(globalThis as any).EdgeRuntime = undefined

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(() => Promise.resolve({ status: null, allow_device_custom_id: true })),
  setAppStatus: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfStore.ts', () => ({
  getChannelSelfOverride: vi.fn(() => Promise.resolve(null)),
  isChannelSelfStoreEnabled: vi.fn(() => false),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/downloadUrl.ts', () => ({
  getBundleUrl: getBundleUrlMock,
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
  getPgClient: vi.fn(() => Promise.resolve({ client: 'pg' })),
  requestInfosChannelDevicePostgres: vi.fn(() => Promise.resolve(null)),
  requestInfosChannelPostgres: vi.fn(() => Promise.resolve(null)),
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
  sendStatsAndDevice: sendStatsAndDeviceMock,
}))

function baseChannel(versionOverrides: Record<string, unknown> = {}) {
  return {
    channels: {
      id: 99,
      name: 'production',
      public: true,
      allow_device_self_set: true,
      allow_dev: true,
      allow_prod: true,
      allow_emulator: true,
      ios: true,
      android: true,
      electron: true,
      disable_auto_update: 'none',
      disable_auto_update_under_native: false,
      update_package: 'zip',
    },
    version: {
      id: 12345,
      name: '2.0.0',
      min_update_version: null,
      session_key: null,
      storage_provider: 'r2',
      checksum: null,
      r2_path: 'orgs/org-1/apps/com.test.app/2.0.0.zip',
      link: null,
      comment: null,
      deleted: false,
      deleted_at: null,
      external_url: null,
      manifest_count: 0,
      key_id: null,
      ...versionOverrides,
    },
    manifestEntries: [],
  }
}

describe('/updates deleted bundle guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getBundleUrlMock.mockResolvedValue('https://signed.example/bundle.zip')
    getAppOwnerPostgresMock.mockResolvedValue({
      allow_device_custom_id: true,
      channel_device_count: 0,
      expose_metadata: false,
      manifest_bundle_count: 1,
      owner_org: 'org-1',
      orgs: { management_email: 'owner@example.com' },
      plan_valid: true,
    })
  })

  async function runUpdate() {
    const { updateWithPG } = await import('../supabase/functions/_backend/plugin_runtime/utils/update.ts')
    const app = new Hono()
    const body = {
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
    }
    app.get('/', c => updateWithPG(c, body as any, {} as any))
    return app.fetch(new Request('http://localhost/'), {}, { waitUntil: () => {} } as any)
  }

  it.concurrent('does not sign r2_path when deleted=true', async () => {
    requestInfosPostgresMock.mockResolvedValue({
      channelData: baseChannel({ deleted: true, deleted_at: null }),
      channelOverride: undefined,
    })

    const res = await runUpdate()
    const json = await res.json() as { error?: string, url?: string }
    expect(json.error).toBe('no_bundle')
    expect(json.url).toBeUndefined()
    expect(getBundleUrlMock).not.toHaveBeenCalled()
  })

  it.concurrent('does not sign r2_path when only deleted_at is set', async () => {
    requestInfosPostgresMock.mockResolvedValue({
      channelData: baseChannel({ deleted: false, deleted_at: '2026-08-16T00:00:00Z' }),
      channelOverride: undefined,
    })

    const res = await runUpdate()
    const json = await res.json() as { error?: string, url?: string }
    expect(json.error).toBe('no_bundle')
    expect(json.url).toBeUndefined()
    expect(getBundleUrlMock).not.toHaveBeenCalled()
  })
})
