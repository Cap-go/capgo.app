import { describe, expect, it, vi } from 'vitest'
import { shouldSyncChannelSelfOverrideForPluginVersion, syncLegacyChannelSelfOverrideDeleteForDevice, syncLegacyChannelSelfOverrideForDevice } from '../supabase/functions/_backend/utils/channelSelfStore.ts'

function createContext(store: { put: ReturnType<typeof vi.fn>, delete: ReturnType<typeof vi.fn> }) {
  return {
    env: {
      CHANNEL_SELF_STORE: store,
    },
    get: vi.fn((key: string) => {
      if (key === 'requestId')
        return 'request-test'
      return undefined
    }),
    req: {
      url: 'https://api.capgo.test/updates',
    },
  }
}

function createStore() {
  return {
    delete: vi.fn(async (_key: string) => undefined),
    put: vi.fn(async (_key: string, _value: string) => undefined),
  }
}

const deviceLookup = vi.hoisted(() => ({ pluginVersion: null as string | null }))

vi.mock('../supabase/functions/_backend/utils/pg_rls.ts', () => ({
  withRlsContext: vi.fn(async (_c: unknown, principal: unknown, run: (client: unknown) => Promise<unknown>) => {
    expect(principal).toEqual({ kind: 'apikey', apikey: 'test-key' })
    return run({
      query: vi.fn(async (text: string) => {
        expect(text).toContain('FROM public.devices')
        return { rows: deviceLookup.pluginVersion ? [{ plugin_version: deviceLookup.pluginVersion }] : [] }
      }),
    })
  }),
}))

function createDeviceClient(pluginVersion: string | null) {
  deviceLookup.pluginVersion = pluginVersion
  return { kind: 'apikey', apikey: 'test-key' }
}

const pluginVersionCases: [string | null, boolean][] = [
  ['5.33.9', true],
  ['5.34.0', false],
  ['6.33.9', true],
  ['6.34.0', false],
  ['7.33.9', true],
  ['7.34.0', false],
  ['7.42.0', false],
  ['8.0.0', false],
  ['0.0.0', true],
  ['', false],
  [null, false],
  ['invalid', false],
]

describe('channel_self override KV plugin version gate', () => {
  pluginVersionCases.forEach(([pluginVersion, expected]) => {
    it.concurrent(`returns ${expected} for ${pluginVersion ?? 'null'}`, () => {
      expect(shouldSyncChannelSelfOverrideForPluginVersion(pluginVersion)).toBe(expected)
    })
  })

  it.concurrent('writes channel_self KV for legacy plugin devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideForDevice(createContext(store) as any, createDeviceClient('7.33.9') as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'DEVICE-ID',
    })

    expect(store.put).toHaveBeenCalledTimes(1)
    expect(store.put.mock.calls[0][0]).toBe('channel_self:v1:com.test.app:device-id')
    expect(JSON.parse(store.put.mock.calls[0][1])).toMatchObject({
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'device-id',
    })
  })

  it.concurrent('does not write channel_self KV for new plugin devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideForDevice(createContext(store) as any, createDeviceClient('7.34.0') as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'DEVICE-ID',
    })

    expect(store.put).not.toHaveBeenCalled()
  })

  it.concurrent('does not write channel_self KV for missing plugin versions', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideForDevice(createContext(store) as any, createDeviceClient(null) as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'DEVICE-ID',
    })

    expect(store.put).not.toHaveBeenCalled()
  })

  it.concurrent('does not write channel_self KV for unparsable plugin versions', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideForDevice(createContext(store) as any, createDeviceClient('invalid') as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'DEVICE-ID',
    })

    expect(store.put).not.toHaveBeenCalled()
  })

  it.concurrent('writes channel_self KV for injected placeholder devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideForDevice(createContext(store) as any, createDeviceClient('0.0.0') as any, {
      app_id: 'com.test.app',
      channel_id: 42,
      device_id: 'DEVICE-ID',
    })

    expect(store.put).toHaveBeenCalledTimes(1)
  })

  it.concurrent('deletes channel_self KV for legacy plugin devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideDeleteForDevice(createContext(store) as any, createDeviceClient('7.33.9') as any, 'com.test.app', 'DEVICE-ID')

    expect(store.delete).toHaveBeenCalledWith('channel_self:v1:com.test.app:device-id')
  })

  it.concurrent('deletes channel_self KV for missing plugin versions', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideDeleteForDevice(createContext(store) as any, createDeviceClient(null) as any, 'com.test.app', 'DEVICE-ID')

    expect(store.delete).toHaveBeenCalledWith('channel_self:v1:com.test.app:device-id')
  })

  it.concurrent('deletes channel_self KV for unparsable plugin versions', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideDeleteForDevice(createContext(store) as any, createDeviceClient('invalid') as any, 'com.test.app', 'DEVICE-ID')

    expect(store.delete).toHaveBeenCalledWith('channel_self:v1:com.test.app:device-id')
  })

  it.concurrent('deletes channel_self KV for injected placeholder devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideDeleteForDevice(createContext(store) as any, createDeviceClient('0.0.0') as any, 'com.test.app', 'DEVICE-ID')

    expect(store.delete).toHaveBeenCalledWith('channel_self:v1:com.test.app:device-id')
  })

  it.concurrent('does not delete channel_self KV for new plugin devices', async () => {
    const store = createStore()

    await syncLegacyChannelSelfOverrideDeleteForDevice(createContext(store) as any, createDeviceClient('7.42.0') as any, 'com.test.app', 'DEVICE-ID')

    expect(store.delete).not.toHaveBeenCalled()
  })
})
