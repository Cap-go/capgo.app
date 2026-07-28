import { Hono } from 'hono/tiny'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAppOwnerPostgresMock = vi.fn()
const requestInfosPostgresMock = vi.fn()
const sendNotifToOrgMembersCachedMock = vi.fn<(...args: any[]) => Promise<boolean>>(() => Promise.resolve(true))
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
  getBundleUrl: vi.fn(),
  getManifestUrl: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersCached: sendNotifToOrgMembersCachedMock,
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
  sendStatsAndDevice: sendStatsAndDeviceMock,
}))

function baseChannel(overrides: Record<string, unknown> = {}) {
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
      disable_auto_update: 'major',
      disable_auto_update_under_native: false,
      ...overrides,
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
    },
    manifestEntries: [],
  }
}

describe('updates version mismatch bento notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAppOwnerPostgresMock.mockResolvedValue({
      allow_device_custom_id: true,
      channel_device_count: 0,
      expose_metadata: false,
      manifest_bundle_count: 0,
      owner_org: 'org-1',
      orgs: { management_email: 'owner@example.com' },
      plan_valid: true,
    })
  })

  async function runUpdate(bodyOverrides: Record<string, unknown> = {}) {
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
      ...bodyOverrides,
    }
    app.get('/', c => updateWithPG(c, body as any, {} as any))
    return app.fetch(new Request('http://localhost/'), {}, { waitUntil: () => {} } as any)
  }

  it('emits device:upgrade_blocked when major auto-update is blocked', async () => {
    requestInfosPostgresMock.mockResolvedValue({
      channelData: baseChannel({ disable_auto_update: 'major' }),
      channelOverride: undefined,
    })

    const res = await runUpdate({ version_build: '1.0.0', version_name: '1.0.0' })
    const json = await res.json() as { error?: string }
    expect(json.error).toBe('disable_auto_update_to_major')
    expect(sendNotifToOrgMembersCachedMock).toHaveBeenCalledWith(
      expect.anything(),
      'device:upgrade_blocked',
      'device_error',
      expect.objectContaining({
        app_id: 'com.test.app',
        app_id_url: 'com.test.app',
        device_id: '11111111-1111-4111-8111-111111111111',
        platform: 'ios',
        channel_name: 'production',
        channel_id: 99,
        version: '2.0.0',
        version_build: '1.0.0',
        version_name: '1.0.0',
        reason: 'major',
      }),
      'org-1',
      'com.test.app',
      '0 0 * * 0',
      expect.anything(),
    )
    // payload must not expose numeric bundle ids
    const firstCall = sendNotifToOrgMembersCachedMock.mock.calls[0] as unknown as unknown[]
    const payload = firstCall[3] as Record<string, unknown>
    expect(payload).not.toHaveProperty('version_id')
    expect(Object.values(payload)).not.toContain(12345)
  })

  it('emits device:downgrade_blocked when under-native auto-update is blocked', async () => {
    requestInfosPostgresMock.mockResolvedValue({
      channelData: {
        ...baseChannel({
          disable_auto_update: 'none',
          disable_auto_update_under_native: true,
        }),
        version: {
          id: 12345,
          name: '1.0.0',
          min_update_version: null,
          session_key: null,
          storage_provider: 'r2',
          checksum: null,
          r2_path: 'orgs/org-1/apps/com.test.app/1.0.0.zip',
          link: null,
          comment: null,
        },
      },
      channelOverride: undefined,
    })

    const res = await runUpdate({ version_build: '2.0.0', version_name: '2.0.0' })
    const json = await res.json() as { error?: string }
    expect(json.error).toBe('disable_auto_update_under_native')
    expect(sendNotifToOrgMembersCachedMock).toHaveBeenCalledWith(
      expect.anything(),
      'device:downgrade_blocked',
      'device_error',
      expect.objectContaining({
        version: '1.0.0',
        version_build: '2.0.0',
        version_name: '2.0.0',
        reason: 'under_native',
      }),
      'org-1',
      'com.test.app',
      '0 0 * * 0',
      expect.anything(),
    )
  })
})
