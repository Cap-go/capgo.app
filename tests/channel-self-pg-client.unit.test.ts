import { beforeEach, describe, expect, it, vi } from 'vitest'

const getPgClientMock = vi.fn(() => ({ client: 'pg' }))
const getDrizzleClientMock = vi.fn(() => ({}))
const deleteChannelDevicePgMock = vi.fn(() => Promise.resolve(true))
const getAppOwnerPostgresMock = vi.fn()
const getChannelByIdPgMock = vi.fn()
const getChannelByNamePgMock = vi.fn()
const getChannelsPgMock = vi.fn()
const getChannelDeviceOverridePgMock = vi.fn()
const upsertChannelDevicePgMock = vi.fn(() => Promise.resolve(true))

;(globalThis as any).EdgeRuntime = undefined

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/appStatus.ts', () => ({
  getAppStatus: vi.fn(() => Promise.resolve({ status: 'cloud', allow_device_custom_id: true })),
  setAppStatus: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/channelSelfRateLimit.ts', () => ({
  checkChannelSelfIPRateLimit: vi.fn(() => Promise.resolve({ limited: false })),
  isChannelSelfRateLimited: vi.fn(() => Promise.resolve({ limited: false })),
  recordChannelSelfIPRequest: vi.fn(() => Promise.resolve()),
  recordChannelSelfRequest: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/discord.ts', () => ({
  sendDiscordAlert500: vi.fn(() => Promise.resolve()),
  sendDiscordAlert: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/notifications.ts', () => ({
  sendNotifOrgCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersCached: vi.fn(() => Promise.resolve()),
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: vi.fn(() => Promise.resolve()),
  deleteChannelDevicePg: deleteChannelDevicePgMock,
  getAppByIdPg: vi.fn(),
  getAppOwnerPostgres: getAppOwnerPostgresMock,
  getChannelByIdPg: getChannelByIdPgMock,
  getChannelByNamePg: getChannelByNamePgMock,
  getChannelDeviceOverridePg: getChannelDeviceOverridePgMock,
  getChannelsPg: getChannelsPgMock,
  getCompatibleChannelsPg: vi.fn(),
  getDrizzleClient: getDrizzleClientMock,
  getMainChannelsPg: vi.fn(),
  getPgClient: getPgClientMock,
  setReplicationLagHeader: vi.fn(() => Promise.resolve()),
  upsertChannelDevicePg: upsertChannelDevicePgMock,
}))

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/plugin_stats.ts', () => ({
  sendStatsAndDevice: vi.fn(() => Promise.resolve()),
}))

function putBody(pluginVersion: string) {
  return {
    app_id: 'com.test.app',
    device_id: '11111111-1111-4111-8111-111111111111',
    platform: 'ios',
    version_name: '1.0.0',
    version_build: '1.0.0',
    is_emulator: false,
    is_prod: true,
    plugin_version: pluginVersion,
  }
}

function createKvStore() {
  const values = new Map<string, string>()
  return {
    values,
    get: vi.fn(async (key: string, options?: { type?: string }) => {
      const value = values.get(key)
      if (!value)
        return null
      return options?.type === 'json' ? JSON.parse(value) : value
    }),
    put: vi.fn(async (key: string, value: string) => {
      values.set(key, value)
    }),
    delete: vi.fn(async (key: string) => {
      values.delete(key)
    }),
  }
}

function channelSelfStoreKey() {
  return 'channel_self:v1:com.test.app:11111111-1111-4111-8111-111111111111'
}

async function fetchPut(pluginVersion: string, env = {}) {
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts')
  return app.fetch(new Request('http://localhost/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody(pluginVersion)),
  }), env, { waitUntil: () => { } } as any)
}

async function fetchPost(pluginVersion: string, env = {}) {
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts')
  return app.fetch(new Request('http://localhost/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...putBody(pluginVersion),
      channel: 'beta',
    }),
  }), env, { waitUntil: () => { } } as any)
}

async function fetchDelete(pluginVersion: string, env = {}) {
  const { app } = await import('../supabase/functions/_backend/plugin_runtime/plugins/channel_self.ts')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(putBody(pluginVersion))) {
    params.set(key, String(value))
  }
  return app.fetch(new Request(`http://localhost/?${params.toString()}`, {
    method: 'DELETE',
  }), env, { waitUntil: () => { } } as any)
}

describe('channel_self PUT database routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAppOwnerPostgresMock.mockResolvedValue({
      allow_device_custom_id: true,
      owner_org: 'test-org',
      orgs: { management_email: 'owner@example.com' },
      plan_valid: true,
    })
    getChannelsPgMock.mockResolvedValue([
      {
        android: true,
        electron: true,
        ios: true,
        name: 'production',
      },
    ])
    getChannelDeviceOverridePgMock.mockResolvedValue(null)
    getChannelByNamePgMock.mockResolvedValue({
      id: 12,
      name: 'beta',
      allow_device_self_set: true,
      public: false,
      owner_org: 'test-org',
    })
    getChannelByIdPgMock.mockResolvedValue({
      id: 12,
      name: 'beta-current',
      allow_device_self_set: true,
      public: false,
      owner_org: 'test-org',
    })
  })

  it('uses primary for old plugin channel_devices read-after-write consistency', async () => {
    const response = await fetchPut('7.33.0')

    expect(response.status).toBe(200)
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), false)
  })

  it('uses replica for new plugin local channel storage reads', async () => {
    const response = await fetchPut('7.34.0')

    expect(response.status).toBe(200)
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), true)
  })

  it('uses replica and KV for old plugin reads when channel self store is bound', async () => {
    const kv = createKvStore()
    const response = await fetchPut('7.33.0', { CHANNEL_SELF_STORE: kv })

    expect(response.status).toBe(200)
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), true)
    expect(getChannelDeviceOverridePgMock).not.toHaveBeenCalled()
    expect(kv.get).toHaveBeenCalled()
  })

  it('resolves KV channel id through current channel metadata for old plugin reads', async () => {
    const kv = createKvStore()
    kv.values.set(channelSelfStoreKey(), JSON.stringify({
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      channel_id: 12,
      channel_name: 'stale-name',
      allow_device_self_set: false,
      updated_at: '2026-01-01T00:00:00.000Z',
    }))

    const response = await fetchPut('7.33.0', { CHANNEL_SELF_STORE: kv })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      channel: 'beta-current',
      status: 'override',
      allowSet: true,
    })
    expect(getChannelByIdPgMock).toHaveBeenCalledWith(expect.anything(), 'com.test.app', 12, expect.anything())
  })

  it('uses replica and KV for old plugin writes when channel self store is bound', async () => {
    const kv = createKvStore()
    const response = await fetchPost('7.33.0', { CHANNEL_SELF_STORE: kv })

    expect(response.status).toBe(200)
    expect(getPgClientMock).toHaveBeenCalledWith(expect.anything(), true)
    expect(upsertChannelDevicePgMock).not.toHaveBeenCalled()
    expect(kv.put).toHaveBeenCalled()
    expect(JSON.parse(kv.put.mock.calls[0][1])).toEqual({
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
      channel_id: 12,
      updated_at: expect.any(String),
    })
  })

  it('does not query KV for new plugin channel self storage when store is bound', async () => {
    const putKv = createKvStore()
    const putResponse = await fetchPut('7.34.0', { CHANNEL_SELF_STORE: putKv })

    expect(putResponse.status).toBe(200)
    expect(putKv.get).not.toHaveBeenCalled()
    expect(putKv.put).not.toHaveBeenCalled()
    expect(putKv.delete).not.toHaveBeenCalled()

    const postKv = createKvStore()
    const postResponse = await fetchPost('7.34.0', { CHANNEL_SELF_STORE: postKv })

    expect(postResponse.status).toBe(200)
    expect(postKv.get).not.toHaveBeenCalled()
    expect(postKv.put).not.toHaveBeenCalled()
    expect(postKv.delete).not.toHaveBeenCalled()

    const deleteKv = createKvStore()
    const deleteResponse = await fetchDelete('7.34.0', { CHANNEL_SELF_STORE: deleteKv })

    expect(deleteResponse.status).toBe(200)
    expect(deleteKv.get).not.toHaveBeenCalled()
    expect(deleteKv.put).not.toHaveBeenCalled()
    expect(deleteKv.delete).not.toHaveBeenCalled()
  })
})
