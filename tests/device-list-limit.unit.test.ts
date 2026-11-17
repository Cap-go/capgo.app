import { describe, expect, it } from 'vitest'
import { applyChannelOverrides, findMissingVersionIds, parseDeviceListLimit } from '../supabase/functions/_backend/public/device/get.ts'
import { MAX_QUERY_LIMIT } from '../supabase/functions/_backend/utils/privateAnalyticsValidation.ts'

describe('parseDeviceListLimit', () => {
  it.concurrent('defaults to the fetch limit and keeps in-range values', () => {
    expect(parseDeviceListLimit(undefined)).toBe(50)
    expect(parseDeviceListLimit(null)).toBe(50)
    expect(parseDeviceListLimit(200)).toBe(200)
    expect(parseDeviceListLimit('1000')).toBe(1000)
    expect(parseDeviceListLimit(MAX_QUERY_LIMIT)).toBe(MAX_QUERY_LIMIT)
  })

  it.concurrent('clamps limits above the analytics cap instead of rejecting them', () => {
    expect(parseDeviceListLimit(MAX_QUERY_LIMIT + 1)).toBe(MAX_QUERY_LIMIT)
    expect(parseDeviceListLimit(10_000_000)).toBe(MAX_QUERY_LIMIT)
    expect(parseDeviceListLimit('999999999')).toBe(MAX_QUERY_LIMIT)
  })

  it.concurrent('still rejects non positive or non integer limits', () => {
    for (const limit of [0, -1, 1.5, 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseDeviceListLimit(limit)).toThrow('limit must be a positive integer')
    }
  })
})

describe('device list lookups', () => {
  it.concurrent('applies channel overrides by lowercased device id, first row winning', () => {
    const devices = [
      { device_id: 'AAAA-1' },
      { device_id: 'bbbb-2' },
      { device_id: 'cccc-3' },
      { device_id: 'dddd-4' },
    ]
    applyChannelOverrides(devices, [
      { device_id: 'aaaa-1', channels: { name: 'beta' } },
      { device_id: 'aaaa-1', channels: { name: 'ignored' } },
      { device_id: 'bbbb-2', channels: null },
      { device_id: 'bbbb-2', channels: { name: 'ignored-too' } },
      { device_id: 'dddd-4', channels: { name: 'production' } },
    ])
    expect(devices).toEqual([
      { device_id: 'AAAA-1', channel: 'beta' },
      { device_id: 'bbbb-2' },
      { device_id: 'cccc-3' },
      { device_id: 'dddd-4', channel: 'production' },
    ])
  })

  it.concurrent('only reports version ids not already resolved by name', () => {
    const versionMap = {
      '1.0.0': { id: 10, name: '1.0.0' },
      '1.1.0': { id: 11, name: '1.1.0' },
    }
    expect(findMissingVersionIds([10, 12, 11, 13], versionMap)).toEqual([12, 13])
    expect(findMissingVersionIds([10], {})).toEqual([10])
  })

  it.concurrent('handles a full page of devices without quadratic lookups', () => {
    const count = MAX_QUERY_LIMIT
    const devices = Array.from({ length: count }, (_, i) => ({ device_id: `device-${i}` }))
    const overrides = devices.map(device => ({ device_id: device.device_id, channels: { name: 'beta' } }))
    const started = performance.now()
    applyChannelOverrides(devices, overrides)
    findMissingVersionIds(Array.from({ length: count }, (_, i) => i), Object.fromEntries(devices.map((device, i) => [device.device_id, { id: i }])))
    // The previous Array.find / Object.values().some loops took minutes at this size.
    expect(performance.now() - started).toBeLessThan(2000)
    expect(devices.every(device => (device as { channel?: string }).channel === 'beta')).toBe(true)
  })
})
