import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statisticsTestUtils } from '../supabase/functions/_backend/public/statistics/index.ts'
import { billableStorageBytes, hoursInRange, includedStorageGbHours } from '../src/services/storageUsage.ts'

dayjs.extend(utc)

const GIB = 1024 ** 3
const fakeContext = { get: vi.fn(() => undefined) } as any

describe('frontend storage GB-hour helpers', () => {
  it('averages byte-hours over the hours of the range', () => {
    // 2 GiB for 720 hours over a 30 day range is a 2 GiB average.
    expect(billableStorageBytes(2 * GIB * 720, '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(2 * GIB)
    expect(billableStorageBytes(0, '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(0)
    expect(billableStorageBytes(Number.NaN, '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(0)
  })

  it('includes plan GB x hours of the cycle', () => {
    expect(includedStorageGbHours(2, '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(2 * 720)
    expect(includedStorageGbHours(0, '2026-01-01T00:00:00Z', '2026-01-31T00:00:00Z')).toBe(0)
  })

  it('never divides by less than one hour', () => {
    expect(hoursInRange('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(1)
    expect(hoursInRange('invalid', '2026-01-01T00:00:00Z')).toBe(1)
  })
})

describe('statistics storage series from byte-hours', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-03T06:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const from = new Date('2026-01-01T00:00:00.000Z')

  it('turns byte-hours into the bytes stored each day, today over the elapsed hours', () => {
    // Day 1: 10 bytes all day. Day 2: 20 bytes all day. Today: 30 bytes for the 6 elapsed hours.
    expect(statisticsTestUtils.storageBytesFromByteHours([240, 480, 180], from)).toEqual([10, 20, 30])
  })

  it('uses fractional elapsed hours early in the day and skips days not started', () => {
    vi.setSystemTime(new Date('2026-01-03T00:30:00.000Z'))
    // Today: 1 GiB since midnight is 0.5 GiB-hours after 30 minutes.
    expect(statisticsTestUtils.storageBytesFromByteHours([0, 0, GIB / 2, 5], from)).toEqual([0, 0, GIB, 0])
  })

  it('returns levels and accumulated byte-hours by default', () => {
    expect(statisticsTestUtils.buildStorageSeries([240, 480, 180], from, false)).toEqual({
      storage: [10, 20, 30],
      storageByteHours: [240, 720, 900],
    })
  })

  it('returns daily changes and per-day byte-hours with noAccumulate', () => {
    expect(statisticsTestUtils.buildStorageSeries([240, 480, 180], from, true)).toEqual({
      storage: [10, 10, 10],
      storageByteHours: [240, 480, 180],
    })
  })

  it('reads storage from the get_app_metrics byte-hours for totals and breakdown', () => {
    const row = (app_id: string, date: string, storage: number) => ({
      app_id,
      date,
      storage,
      mau: 1,
      bandwidth: 0,
      build_time_unit: 0,
      get: 0,
      fail: 0,
      install: 0,
      uninstall: 0,
    })
    const result = statisticsTestUtils.assembleNormalStats(fakeContext, {
      metricsByApp: {
        'com.a': [row('com.a', '2026-01-01', 240), row('com.a', '2026-01-02', 240)],
        'com.b': [row('com.b', '2026-01-02', 480)],
      },
      from,
      graphDays: 3,
      isDashboard: false,
      includeBreakdown: true,
      noAccumulate: false,
    })

    expect(result.error).toBeNull()
    expect(result.data.global.map((entry: any) => [entry.storage, entry.storage_byte_hours])).toEqual([
      [10, 240],
      [30, 960],
      [0, 960],
    ])
    expect(result.data.byApp.filter((entry: any) => entry.app_id === 'com.b').map((entry: any) => entry.storage_byte_hours)).toEqual([0, 480, 480])
  })
})
