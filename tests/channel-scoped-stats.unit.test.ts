import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import * as pluginRuntimeCloudflare from '../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts'
import { buildDeviceChannelScopeCF, buildDeviceVersionCountsCFQuery, buildVersionUsageChannelFilterCF } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { countChannelScopedDeviceVersions, MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS, partitionChannelDeviceOverrides, pickChannelDefaultPlatforms, readDeviceVersionCountsSB } from '../supabase/functions/_backend/utils/supabase.ts'

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

// Minimal PostgREST builder over an in-memory devices table. Records the
// filters of every request so tests can assert the queries that were sent.
function createFakeDevicesClient(devices: FakeDevice[], maxRows = 1000) {
  const requests: string[][] = []
  const client = {
    from(table: string) {
      expect(table).toBe('devices')
      const filters: string[] = []
      let rows = [...devices]
      let range: [number, number] | null = null
      const builder = {
        select: () => builder,
        eq(column: keyof FakeDevice, value: unknown) {
          filters.push(`${column}=eq.${value}`)
          rows = rows.filter(row => row[column] === value)
          return builder
        },
        in(column: keyof FakeDevice, values: unknown[]) {
          filters.push(`${column}=in.(${values.join(',')})`)
          rows = rows.filter(row => values.includes(row[column]))
          return builder
        },
        or(expression: string) {
          expect(expression).toBe('default_channel.is.null,default_channel.eq.')
          filters.push(`or=(${expression})`)
          rows = rows.filter(row => row.default_channel === null || row.default_channel === '')
          return builder
        },
        order(column: keyof FakeDevice) {
          rows.sort((left, right) => Number(left[column]) - Number(right[column]))
          return builder
        },
        range(from: number, to: number) {
          range = [from, to]
          return builder
        },
        then(resolve: (value: { data: Array<{ device_id: string, version_name: string }>, error: null }) => unknown) {
          requests.push(filters)
          const [from, to] = range ?? [0, maxRows - 1]
          const page = rows.slice(from, Math.min(to + 1, from + maxRows))
          return Promise.resolve({ data: page.map(row => ({ device_id: row.device_id, version_name: row.version_name })), error: null }).then(resolve)
        },
      }
      return builder
    },
  }
  return { client: client as unknown as Parameters<typeof readDeviceVersionCountsSB>[4], requests }
}

describe('readDeviceVersionCountsSB', () => {
  const c = { get: () => 'test-request' } as unknown as Context
  let nextId = 1
  const device = (device_id: string, platform: string, default_channel: string | null, version_name: string, app_id = 'com.app'): FakeDevice =>
    ({ id: nextId++, device_id, app_id, platform, default_channel, version_name })

  it.concurrent('adds devices without a reported channel on the default platforms', async () => {
    const { client, requests } = createFakeDevicesClient([
      device('pinned', 'android', 'production', '1.0.0'),
      device('implicit-android', 'android', null, '1.0.0'),
      device('implicit-empty', 'android', '', '1.1.0'),
      device('implicit-ios', 'ios', null, '1.0.0'),
      device('other-channel', 'android', 'beta', '1.0.0'),
      device('other-app', 'android', null, '1.0.0', 'com.other'),
    ])

    const counts = await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [], defaultForPlatforms: ['android'] }, client)

    expect(counts).toEqual({ '1.0.0': 2, '1.1.0': 1 })
    expect(requests).toContainEqual(['app_id=eq.com.app', 'or=(default_channel.is.null,default_channel.eq.)', 'platform=in.(android)'])
  })

  it.concurrent('skips the unreported query when the channel is no platform default', async () => {
    const { client, requests } = createFakeDevicesClient([
      device('pinned', 'android', 'production', '1.0.0'),
      device('implicit-android', 'android', null, '1.0.0'),
    ])

    expect(await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [] }, client)).toEqual({ '1.0.0': 1 })
    expect(requests).toEqual([['app_id=eq.com.app', 'default_channel=eq.production']])
  })

  it.concurrent('pages past the PostgREST row limit', async () => {
    const devices = Array.from({ length: 2500 }, (_, index) => device(`implicit-${index}`, 'android', null, index < 1000 ? '1.0.0' : '1.1.0'))
    const { client, requests } = createFakeDevicesClient(devices)

    const counts = await readDeviceVersionCountsSB(c, 'com.app', 'production', { into: [], elsewhere: [], defaultForPlatforms: ['android'] }, client)

    expect(counts).toEqual({ '1.0.0': 1000, '1.1.0': 1500 })
    expect(requests.filter(filters => filters.includes('platform=in.(android)'))).toHaveLength(3)
  })
})
