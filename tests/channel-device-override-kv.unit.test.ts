import { beforeEach, describe, expect, it, vi } from 'vitest'

const checkPermissionMock = vi.fn()
const isValidAppIdMock = vi.fn()
const supabaseApikeyMock = vi.fn()
const supabaseWithAuthMock = vi.fn()
const syncLegacyChannelSelfOverrideDeleteForDeviceMock = vi.fn()
const syncLegacyChannelSelfOverrideForDeviceMock = vi.fn()
const updateOrCreateChannelDeviceMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/channelSelfStore.ts', () => ({
  syncLegacyChannelSelfOverrideDeleteForDevice: syncLegacyChannelSelfOverrideDeleteForDeviceMock,
  syncLegacyChannelSelfOverrideForDevice: syncLegacyChannelSelfOverrideForDeviceMock,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  BRES: { status: 'ok' },
  parseBody: vi.fn(),
  quickError: (status: number, error: string, message: string, details: Record<string, unknown> = {}) => {
    const issue = new Error(message)
    ;(issue as Error & { cause?: unknown }).cause = { status, error, ...details }
    throw issue
  },
  simpleError: (error: string, message: string, details: Record<string, unknown> = {}) => {
    const issue = new Error(message)
    ;(issue as Error & { cause?: unknown }).cause = { error, ...details }
    throw issue
  },
  useCors: async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: supabaseApikeyMock,
  supabaseWithAuth: supabaseWithAuthMock,
  updateOrCreateChannelDevice: updateOrCreateChannelDeviceMock,
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', () => ({
  isValidAppId: isValidAppIdMock,
}))

function createContext() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'auth') {
        return {
          apikey: null,
          authType: 'jwt',
          jwt: 'Bearer jwt-test',
          userId: 'user-test',
        }
      }
      if (key === 'requestId')
        return 'request-test'
      return undefined
    }),
    json: vi.fn((body: unknown) => body),
  }
}

function createChannelSelect(channel = { id: 42, app_id: 'com.test.app', owner_org: 'org-test', public: false }) {
  return {
    select() {
      return this
    },
    eq() {
      return this
    },
    single: vi.fn(async () => ({ data: channel, error: null })),
  }
}

function createDeviceSelect(pluginVersion: string | null = '7.33.0') {
  return {
    select() {
      return this
    },
    eq() {
      return this
    },
    maybeSingle: vi.fn(async () => ({
      data: pluginVersion ? { plugin_version: pluginVersion } : null,
      error: null,
    })),
  }
}

function createPublicApiSupabase(pluginVersion: string | null = '7.33.0') {
  return {
    from(table: string) {
      if (table === 'channels')
        return createChannelSelect()
      if (table === 'devices')
        return createDeviceSelect(pluginVersion)
      if (table === 'channel_devices') {
        return {
          delete() {
            return this
          },
          eq() {
            return this
          },
          then(resolve: (value: { error: null }) => unknown) {
            return Promise.resolve(resolve({ error: null }))
          },
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  }
}

function createPrivateSupabase(
  pluginVersion: string | null = '7.33.0',
  channelDeviceOverride: { app_id: string, channel_id: number, owner_org: string } | null = { app_id: 'com.test.app', channel_id: 42, owner_org: 'org-test' },
) {
  const upsertMock = vi.fn(async () => ({ error: null }))
  const deleteResult = { error: null }
  const channelDevicesTable = {
    upsert: upsertMock,
    select() {
      return this
    },
    delete() {
      return this
    },
    eq() {
      return this
    },
    maybeSingle: vi.fn(async () => ({ data: channelDeviceOverride, error: null })),
    then(resolve: (value: { error: null }) => unknown) {
      return Promise.resolve(resolve(deleteResult))
    },
  }

  return {
    channelDevicesTable,
    upsertMock,
    client: {
      from(table: string) {
        if (table === 'channels')
          return createChannelSelect()
        if (table === 'devices')
          return createDeviceSelect(pluginVersion)
        if (table === 'channel_devices')
          return channelDevicesTable
        throw new Error(`Unexpected table: ${table}`)
      },
    },
  }
}

describe('channel device override KV sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    checkPermissionMock.mockResolvedValue(true)
    isValidAppIdMock.mockReturnValue(true)
    supabaseApikeyMock.mockReturnValue(createPublicApiSupabase())
    syncLegacyChannelSelfOverrideForDeviceMock.mockResolvedValue(true)
    syncLegacyChannelSelfOverrideDeleteForDeviceMock.mockResolvedValue(true)
    updateOrCreateChannelDeviceMock.mockResolvedValue({ error: null })
  })

  it('syncs public device API channel override writes through the legacy channel_self helper', async () => {
    const { post } = await import('../supabase/functions/_backend/public/device/post.ts')
    const c = createContext()

    await post(c as any, {
      app_id: 'com.test.app',
      channel: 'beta',
      device_id: '11111111-1111-4111-8111-111111111111',
    }, { key: 'capg-key' } as any)

    expect(updateOrCreateChannelDeviceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
      owner_org: 'org-test',
    }))
    expect(syncLegacyChannelSelfOverrideForDeviceMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
    })
  })

  it('fails public device API channel override writes when KV sync fails', async () => {
    syncLegacyChannelSelfOverrideForDeviceMock.mockResolvedValue(false)
    const { post } = await import('../supabase/functions/_backend/public/device/post.ts')
    const c = createContext()

    await expect(post(c as any, {
      app_id: 'com.test.app',
      channel: 'beta',
      device_id: '11111111-1111-4111-8111-111111111111',
    }, { key: 'capg-key' } as any)).rejects.toThrow('Error syncing channel override store')
  })

  it('syncs public device API channel override deletes through the legacy channel_self helper', async () => {
    const { deleteOverride } = await import('../supabase/functions/_backend/public/device/delete.ts')
    const c = createContext()

    await deleteOverride(c as any, {
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
    }, { key: 'capg-key' } as any)

    expect(syncLegacyChannelSelfOverrideDeleteForDeviceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'com.test.app',
      '11111111-1111-4111-8111-111111111111',
    )
  })

  it('fails public device API channel override deletes when KV sync fails', async () => {
    syncLegacyChannelSelfOverrideDeleteForDeviceMock.mockResolvedValue(false)
    const { deleteOverride } = await import('../supabase/functions/_backend/public/device/delete.ts')
    const c = createContext()

    await expect(deleteOverride(c as any, {
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
    }, { key: 'capg-key' } as any)).rejects.toThrow('Error syncing channel override store')
  })

  it('syncs dashboard channel override writes through the legacy channel_self helper', async () => {
    const privateSupabase = createPrivateSupabase()
    supabaseWithAuthMock.mockReturnValue(privateSupabase.client)
    const { setChannelDeviceOverride } = await import('../supabase/functions/_backend/private/channel_device.ts')
    const c = createContext()

    await setChannelDeviceOverride(c as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'channel.manage_forced_devices', {
      appId: 'com.test.app',
      channelId: 42,
    })

    expect(privateSupabase.upsertMock).toHaveBeenCalledWith({
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
      owner_org: 'org-test',
    }, { onConflict: 'app_id,device_id' })
    expect(syncLegacyChannelSelfOverrideForDeviceMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
      owner_org: 'org-test',
    })
  })

  it('rejects dashboard channel override writes without channel forced-device permission', async () => {
    const privateSupabase = createPrivateSupabase()
    supabaseWithAuthMock.mockReturnValue(privateSupabase.client)
    checkPermissionMock.mockResolvedValue(false)
    const { setChannelDeviceOverride } = await import('../supabase/functions/_backend/private/channel_device.ts')
    const c = createContext()

    await expect(setChannelDeviceOverride(c as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow('Permission denied: channel.manage_forced_devices')

    expect(privateSupabase.upsertMock).not.toHaveBeenCalled()
    expect(syncLegacyChannelSelfOverrideForDeviceMock).not.toHaveBeenCalled()
  })

  it('fails dashboard channel override writes when KV sync fails', async () => {
    const privateSupabase = createPrivateSupabase()
    supabaseWithAuthMock.mockReturnValue(privateSupabase.client)
    syncLegacyChannelSelfOverrideForDeviceMock.mockResolvedValue(false)
    const { setChannelDeviceOverride } = await import('../supabase/functions/_backend/private/channel_device.ts')
    const c = createContext()

    await expect(setChannelDeviceOverride(c as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow('Error syncing channel override store')
  })

  it('syncs dashboard channel override deletes through the legacy channel_self helper', async () => {
    const privateSupabase = createPrivateSupabase()
    supabaseWithAuthMock.mockReturnValue(privateSupabase.client)
    const { deleteChannelDeviceOverride } = await import('../supabase/functions/_backend/private/channel_device.ts')
    const c = createContext()

    await deleteChannelDeviceOverride(c as any, {
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
    })

    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'channel.manage_forced_devices', {
      appId: 'com.test.app',
      channelId: 42,
    })

    expect(syncLegacyChannelSelfOverrideDeleteForDeviceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'com.test.app',
      '11111111-1111-4111-8111-111111111111',
    )
  })

  it('fails dashboard channel override deletes when KV sync fails', async () => {
    const privateSupabase = createPrivateSupabase()
    supabaseWithAuthMock.mockReturnValue(privateSupabase.client)
    syncLegacyChannelSelfOverrideDeleteForDeviceMock.mockResolvedValue(false)
    const { deleteChannelDeviceOverride } = await import('../supabase/functions/_backend/private/channel_device.ts')
    const c = createContext()

    await expect(deleteChannelDeviceOverride(c as any, {
      app_id: 'com.test.app',
      device_id: '11111111-1111-4111-8111-111111111111',
    })).rejects.toThrow('Error syncing channel override store')
  })
})
