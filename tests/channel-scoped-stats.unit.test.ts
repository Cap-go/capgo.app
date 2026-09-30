import { describe, expect, it } from 'vitest'
import * as pluginRuntimeCloudflare from '../supabase/functions/_backend/plugin_runtime/utils/cloudflare.ts'
import { buildDeviceChannelScopeCF, buildDeviceVersionCountsCFQuery, buildVersionUsageChannelFilterCF } from '../supabase/functions/_backend/utils/cloudflare.ts'
import { countChannelScopedDeviceVersions, MAX_CHANNEL_DEVICE_OVERRIDES_FOR_COUNTS, partitionChannelDeviceOverrides } from '../supabase/functions/_backend/utils/supabase.ts'

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
    const overrides = { into: ['a'], elsewhere: ['b'] }
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

  it.concurrent('escapes device ids and channel names', () => {
    const scope = buildDeviceChannelScopeCF('prod\'uction', { into: ['a\'b'], elsewhere: ['c\'d'] })
    expect(scope).toContain('default_channel = \'prod\'\'uction\'')
    expect(scope).toContain('IN (\'a\'\'b\')')
    expect(scope).toContain('NOT IN (\'c\'\'d\')')
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
