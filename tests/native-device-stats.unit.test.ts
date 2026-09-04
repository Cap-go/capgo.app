import { describe, expect, it } from 'vitest'
import { nativeUsageTestUtils } from '../supabase/functions/_backend/public/statistics/index.ts'
import {
  buildDailyPlatformActiveFromDatasets,
  calculatePeriodEvolutionPercent,
  normalizeNativeActiveDevicesSummary,
  parseNativeSeriesPlatform,
} from '../src/services/nativeDeviceStats.ts'

describe('native device stats helpers', () => {
  it('parses native series labels by platform prefix', () => {
    expect(parseNativeSeriesPlatform('iOS 1.0.0')).toBe('ios')
    expect(parseNativeSeriesPlatform('Android 2.1.0')).toBe('android')
    expect(parseNativeSeriesPlatform('Electron 3.0.0')).toBe('electron')
    expect(parseNativeSeriesPlatform('Unknown 0.0.0')).toBe('unknown')
  })

  it('aggregates daily platform totals from chart datasets', () => {
    const daily = buildDailyPlatformActiveFromDatasets(
      ['2024-10-24', '2024-10-25'],
      [
        { label: 'iOS 1.0.0', metaCountValues: [2, 3] },
        { label: 'Android 1.0.0', metaCountValues: [4, 1] },
        { label: 'Electron 1.0.0', metaCountValues: [1, 0] },
      ],
    )

    expect(daily).toEqual({
      labels: ['2024-10-24', '2024-10-25'],
      ios: [2, 3],
      android: [4, 1],
      electron: [1, 0],
      unknown: [0, 0],
      total: [7, 4],
    })
  })

  it('normalizes active device summary totals', () => {
    expect(normalizeNativeActiveDevicesSummary({ android: 10, ios: 5, total: 0 })).toEqual({
      android: 10,
      ios: 5,
      electron: 0,
      unknown: 0,
      total: 15,
    })
  })

  it('calculates period evolution from first to last non-zero day', () => {
    expect(calculatePeriodEvolutionPercent([10, 12, 15])).toBe(50)
    expect(calculatePeriodEvolutionPercent([0, 0, 8])).toBe(0)
    expect(calculatePeriodEvolutionPercent([12, 12])).toBe(0)
  })
})

describe('native usage backend helpers', () => {
  it('summarizes platform rows including total row', () => {
    expect(nativeUsageTestUtils.summarizeNativeActiveDevices([
      { platform: 'android', devices: 12 },
      { platform: 'ios', devices: 8 },
      { platform: 'total', devices: 20 },
    ])).toEqual({
      android: 12,
      ios: 8,
      electron: 0,
      unknown: 0,
      total: 20,
    })
  })

  it('builds daily platform totals from native usage rows', () => {
    expect(nativeUsageTestUtils.buildDailyPlatformActiveTotals([
      { date: '2024-10-24', platform: 'ios', version_build: '1.0.0', devices: 2 },
      { date: '2024-10-24', platform: 'android', version_build: '1.0.0', devices: 3 },
      { date: '2024-10-25', platform: 'ios', version_build: '1.1.0', devices: 4 },
    ], ['2024-10-24', '2024-10-25'])).toEqual({
      labels: ['2024-10-24', '2024-10-25'],
      android: [3, 0],
      ios: [2, 4],
      electron: [0, 0],
      unknown: [0, 0],
      total: [5, 4],
    })
  })
})
