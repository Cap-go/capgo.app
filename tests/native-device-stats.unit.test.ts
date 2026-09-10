import { describe, expect, it } from 'vitest'
import { nativeUsageTestUtils } from '../supabase/functions/_backend/public/statistics/index.ts'
import {
  calculateSummaryEvolutionPercent,
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

  it('normalizes active device summary totals', () => {
    expect(normalizeNativeActiveDevicesSummary({ android: 10, ios: 5, total: 0 })).toEqual({
      android: 10,
      ios: 5,
      electron: 0,
      unknown: 0,
      total: 15,
    })
  })

  it('calculates summary evolution from period totals', () => {
    expect(calculateSummaryEvolutionPercent(150, 100)).toBe(50)
    expect(calculateSummaryEvolutionPercent(0, 0)).toBeUndefined()
    expect(calculateSummaryEvolutionPercent(10, 0)).toBe(100)
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

  it('builds daily platform totals from distinct daily platform rows', () => {
    expect(nativeUsageTestUtils.buildDailyPlatformActiveTotals([
      { date: '2024-10-24', platform: 'ios', devices: 2 },
      { date: '2024-10-24', platform: 'android', devices: 3 },
      { date: '2024-10-25', platform: 'ios', devices: 4 },
    ], ['2024-10-24', '2024-10-25'])).toEqual({
      labels: ['2024-10-24', '2024-10-25'],
      android: [3, 0],
      ios: [2, 4],
      electron: [0, 0],
      unknown: [0, 0],
      total: [5, 4],
    })
  })

  it('accumulates canonical platform variants in summary and daily totals', () => {
    expect(nativeUsageTestUtils.summarizeNativeActiveDevices([
      { platform: 'Android', devices: 5 },
      { platform: 'android', devices: 3 },
      { platform: 'iOS', devices: 2 },
      { platform: 'total', devices: 10 },
    ])).toEqual({
      android: 8,
      ios: 2,
      electron: 0,
      unknown: 0,
      total: 10,
    })

    expect(nativeUsageTestUtils.buildDailyPlatformActiveTotals([
      { date: '2024-10-24', platform: 'Android', devices: 2 },
      { date: '2024-10-24', platform: 'android', devices: 1 },
      { date: '2024-10-24', platform: 'iOS', devices: 4 },
    ], ['2024-10-24'])).toEqual({
      labels: ['2024-10-24'],
      android: [3],
      ios: [4],
      electron: [0],
      unknown: [0],
      total: [7],
    })
  })

  it('accumulates multiple non-canonical platform values into the unknown bucket', () => {
    expect(nativeUsageTestUtils.summarizeNativeActiveDevices([
      { platform: 'windows', devices: 4 },
      { platform: 'Web', devices: 2 },
      { platform: 'custom-os', devices: 1 },
    ])).toEqual({
      android: 0,
      ios: 0,
      electron: 0,
      unknown: 7,
      total: 7,
    })

    expect(nativeUsageTestUtils.buildDailyPlatformActiveTotals([
      { date: '2024-10-24', platform: 'windows', devices: 3 },
      { date: '2024-10-24', platform: 'Web', devices: 2 },
      { date: '2024-10-25', platform: 'custom-os', devices: 5 },
      { date: '2024-10-25', platform: 'linux', devices: 1 },
    ], ['2024-10-24', '2024-10-25'])).toEqual({
      labels: ['2024-10-24', '2024-10-25'],
      android: [0, 0],
      ios: [0, 0],
      electron: [0, 0],
      unknown: [5, 6],
      total: [5, 6],
    })
  })
})
