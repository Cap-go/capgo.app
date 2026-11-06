import type { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import * as pluginRuntimeCloudflare from '../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts'
import { buildDeviceChannelScopeCF, buildDeviceVersionCountsCFQuery, buildVersionUsageChannelFilterCF } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { countChannelScopedDeviceVersions, MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS, partitionChannelDeviceOverrides, pickChannelDefaultPlatforms, readDeviceVersionCountsSB } from '../supabase/functions/_backend/utils/supabase.ts'

const pgMocks = vi.hoisted(() => ({
  getPgClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: pgMocks.getPgClient,
  closeClient: vi.fn(),
}))

describe('version_usage channel filter', () => {
  it.concurrent('matches channel id with a legacy name fallback', () => {
    expect(buildVersionUsageChannelFilterCF({ id: 42, name: 'production' }))
      .toBe('AND (blob5 = \'42\' OR (blob5 = \'\' AND blob4 = \'production\'))')
  })

  it.concurrent('supports id-only, name-only and no channel', () => {
    expect(buildVersionUsageChannelFilterCF({ id: 42 })).toBe('AND blob5 = \'42\'')
    expect(buildVersionUsageChannelFilterCF({ name: 'beta' })).toBe('AND blob4 = \'beta\'')
    expect(buildVersionUsageChannelFilterCF('beta')).toBe('AND blob4 = \'beta\'')
    expect(buildVersionUsageChannelFilterCF(undefined)).toBe('')
    expect(buildVersionUsageChannelFilterCF({ id: null, name: null })).toBe('')
  })

  it.concurrent('optionally keeps legacy get rows that carry no channel', () => {
    expect(buildVersionUsageChannelFilterCF({ id: 42, name: 'production' }, { includeUnattributedGets: true }))
      .toBe('AND ((blob5 = \'42\' OR (blob5 = \'\' AND blob4 = \'production\')) OR (blob3 = \'get\' AND blob4 = \'\' AND blob5 = \'\'))')
    expect(buildVersionUsageChannelFilterCF(undefined, { includeUnattributedGets: true })).toBe('')
  })

  it.concurrent('escapes channel names', () => {
    expect(buildVersionUsageChannelFilterCF({ id: 1, name: 'x\' OR 1=1 --' })).toContain('blob4 = \'x\'\' OR 1=1 --\'')
  })

  it.concurrent('keeps the plugin_runtime copy in sync', () => {
    expect(pluginRuntimeCloudflare.buildVersionUsageChannelFilterCF({ id: 42, name: 'production' }))
      .toBe(buildVersionUsageChannelFilterCF({ id: 42, name: 'production' }))
    const overrides = { into: ['a'], elsewhere: ['b'], defaultForPlatforms: ['ios' as const] }
    expect(pluginRuntimeCloudflare.buildDeviceVersionCountsCFQuery('com.app', 'production', overrides))
      .toBe(buildDeviceVersionCountsCFQuery('com.app', 'production', overrides))
  })
})

describe('device version counts channel scope', () => {
  it.concurrent('keeps the default_channel filter when there are no overrides', () => {
    expect(buildDeviceChannelScopeCF('production')).toBe('default_channel = \'production\'')
    expect(buildDeviceChannelScopeCF('production', { into: [], elsewhere: [] })).toBe('default_channel = \'production\'')
    expect(buildDeviceVersionCountsCFQuery('com.app')).not.toContain('default_channel = ')
  })

  it.concurrent('adds forced-in devices and removes devices forced elsewhere', () => {
    const scope = buildDeviceChannelScopeCF('production', { into: ['in-1', 'in-2'], elsewhere: ['out-1'] })
    expect(scope).toBe('((default_channel = \'production\' AND lower(device_id) NOT IN (\'out-1\')) OR lower(device_id) IN (\'in-1\', \'in-2\'))')

    const query = buildDeviceVersionCountsCFQuery('com.app', 'production', { into: ['in-1'], elsewhere: [] })
    expect(query).toContain('WHERE version_name != \'\' AND (default_channel = \'production\' OR lower(device_id) IN (\'in-1\'))')
  })

  it.concurrent('counts devices without a reported channel on platforms where the channel is the public default', () => {
    expect(buildDeviceChannelScopeCF('production', { into: [], elsewhere: [], defaultForPlatforms: ['ios', 'android'] }))
      .toBe('(default_channel = \'production\' OR (default_channel = \'\' AND platform IN (1, 0)))')

    const scope = buildDeviceChannelScopeCF('production', { into: ['in-1'], elsewhere: ['out-1'], defaultForPlatforms: ['electron'] })
    expect(scope).toBe('(((default_channel = \'production\' OR (default_channel = \'\' AND platform IN (2))) AND lower(device_id) NOT IN (\'out-1\')) OR lower(device_id) IN (\'in-1\'))')

    expect(buildDeviceVersionCountsCFQuery('com.app', 'production')).toContain('argMax(double1, timestamp) AS platform')
  })

  it.concurrent('escapes device ids and channel names', () => {
    const scope = buildDeviceChannelScopeCF('prod\'uction', { into: ['a\'b'], elsewhere: ['c\'d'] })
    expect(scope).toContain('default_channel = \'prod\'\'uction\'')
    expect(scope).toContain('IN (\'a\'\'b\')')
    expect(scope).toContain('NOT IN (\'c\'\'d\')')
  })
})

describe('public default channel platforms', () => {
  // Sorted by name then id, like the /updates fallback.
  const rows = [
    { id: 3, name: 'android-prod', ios: false, android: true, electron: false },
    { id: 1, name: 'production', ios: true, android: true, electron: true },
    { id: 2, name: 'zeta', ios: true, android: false, electron: false },
  ]

  it.concurrent('returns the platforms the channel serves by default', () => {
    expect(pickChannelDefaultPlatforms(rows, { id: 1, name: 'production' })).toEqual(['ios', 'electron'])
    expect(pickChannelDefaultPlatforms(rows, { id: 3 })).toEqual(['android'])
    expect(pickChannelDefaultPlatforms(rows, 'zeta')).toEqual([])
    expect(pickChannelDefaultPlatforms([], 'production')).toEqual([])
  })
})

describe('channel_devices override partitioning', () => {
  const rows = [
    { device_id: 'DEV-IN', channel_id: 1, channels: { name: 'production' } },
    { device_id: 'dev-out', channel_id: 2, channels: { name: 'beta' } },
    { device_id: 'dev-out-2', channel_id: 3, channels: [{ name: 'qa' }] },
  ]

  it.concurrent('matches by channel id when known and lowercases ids', () => {
    expect(partitionChannelDeviceOverrides(rows, { id: 1, name: 'production' })).toEqual({
      into: ['dev-in'],
      elsewhere: ['dev-out', 'dev-out-2'],
      truncated: false,
    })
  })

  it.concurrent('matches by name when only the name is known', () => {
    expect(partitionChannelDeviceOverrides(rows, 'beta')).toEqual({
      into: ['dev-out'],
      elsewhere: ['dev-in', 'dev-out-2'],
      truncated: false,
    })
  })

  it.concurrent('caps the combined list, keeping forced-in devices first', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ device_id: `in-${index}`, channel_id: 1 }))
      .concat(Array.from({ length: 5 }, (_, index) => ({ device_id: `out-${index}`, channel_id: 2 })))
    const result = partitionChannelDeviceOverrides(many, { id: 1 }, 7)
    expect(result.into).toHaveLength(5)
    expect(result.elsewhere).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS).toBeGreaterThan(0)
  })

  it.concurrent('counts devices by effective channel for the Supabase fallback', () => {
    const counts = countChannelScopedDeviceVersions(
      [
        { device_id: 'a', version_name: '1.0.0' },
        { device_id: 'B', version_name: '1.0.0' },
        { device_id: 'c', version_name: null },
      ],
      [
        { device_id: 'forced', version_name: '2.0.0' },
        { device_id: 'a', version_name: '1.0.0' },
      ],
      { into: ['forced', 'a'], elsewhere: ['b'] },
    )
    expect(counts).toEqual({ '1.0.0': 1, 'unknown': 1, '2.0.0': 1 })
  })
})

interface FakeDevice {
  id: number
  device_id: string
  app_id: string
  platform: string
  default_channel: string | null
  version_name: string
}

// Minimal node-postgres client over an in-memory devices table. Records a
// label for every query so tests can assert the queries that were sent.
function createFakeDevicesClient(devices: FakeDevice[]) {
  const requests: string[] = []
  const pick = (rows: FakeDevice[]) => ({ rows: rows.map(row => ({ device_id: row.device_id, version_name: row.version_name })) })
  const client = {
    async query(text: string, values: unknown[]) {
      expect(text).toContain('FROM public.devices')
      const appRows = devices.filter(row => row.app_id === values[0])
      if (text.includes('default_channel IS NULL OR default_channel = \'\'')) {
        const platforms = values[1] as string[]
        requests.push(`unreported:${platforms.join(',')}`)
        return pick(appRows.filter(row => (row.default_channel === null || row.default_channel === '') && platforms.includes(row.platform)))
      }
      if (text.includes('device_id = ANY')) {
        const ids = values[1] as string[]
        requests.push(`forced:${ids.join(',')}`)
        return pick(appRows.filter(row => ids.includes(row.device_id)))
      }
      if (text.includes('default_channel = $2')) {
        requests.push(`channel:${values[1]}`)
        return pick(appRows.filter(row => row.default_channel === values[1]))
      }
      requests.push('all')
      return pick(appRows)
    },
  }
  return { client, requests }
}

describe('readDeviceVersionCountsSB', () => {
  const c = { get: () => 'test-request' } as unknown as Context
  let nextId = 1
  const device = (device_id: string, platform: string, default_channel: string | null, version_name: string, app_id = 'com.app'): FakeDevice =>
    ({ id: nextId++, device_id, app_id, platform, default_channel, version_name })

  it('adds devices without a reported channel on the default platforms', async () => {
    const { client, requests } = createFakeDevicesClient([
      device('pinned', 'android', 'production', '1.0.0'),
      device('implicit-android', 'android', null, '1.0.0'),
      device('implicit-empty', 'android', '', '1.1.0'),
      device('implicit-ios', 'ios', null, '1.0.0'),
      device('other-channel', 'android', 'beta', '1.0.0'),
      device('other-app', 'android', null, '1.0.0', 'com.other'),
    ])
    pgMocks.getPgClient.mockResolvedValueOnce(client)

    const counts = await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [], defaultForPlatforms: ['android'] })

    expect(counts).toEqual({ '1.0.0': 2, '1.1.0': 1 })
    expect(requests).toEqual(['channel:production', 'unreported:android'])
  })

  it('skips the unreported query when the channel is no platform default', async () => {
    const { client, requests } = createFakeDevicesClient([
      device('pinned', 'android', 'production', '1.0.0'),
      device('implicit-android', 'android', null, '1.0.0'),
    ])
    pgMocks.getPgClient.mockResolvedValueOnce(client)

    expect(await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [] })).toEqual({ '1.0.0': 1 })
    expect(requests).toEqual(['channel:production'])
  })

  it('reads devices forced into the channel and drops devices forced elsewhere', async () => {
    const { client, requests } = createFakeDevicesClient([
      device('pinned', 'android', 'production', '1.0.0'),
      device('moved-away', 'android', 'production', '1.0.0'),
      device('forced-in', 'ios', 'beta', '2.0.0'),
    ])
    pgMocks.getPgClient.mockResolvedValueOnce(client)

    const counts = await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: ['forced-in'], elsewhere: ['moved-away'] })

    expect(counts).toEqual({ '1.0.0': 1, '2.0.0': 1 })
    expect(requests).toEqual(['channel:production', 'forced:forced-in'])
  })

  it('counts every matching device without a row cap', async () => {
    const devices = Array.from({ length: 2500 }, (_, index) => device(`implicit-${index}`, 'android', null, index < 1000 ? '1.0.0' : '1.1.0'))
    const { client, requests } = createFakeDevicesClient(devices)
    pgMocks.getPgClient.mockResolvedValueOnce(client)

    const counts = await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [], defaultForPlatforms: ['android'] })

    expect(counts).toEqual({ '1.0.0': 1000, '1.1.0': 1500 })
    expect(requests.filter(request => request.startsWith('unreported:'))).toHaveLength(1)
  })
})
