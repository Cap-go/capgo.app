import { describe, expect, it } from 'vitest'

import {
  bucketPluginVersionBreakdown,
  ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION,
  estimateKnownPluginVersionDevicesFromLadder,
  hasPluginVersionBreakdown,
  isLegacyChannelSelfStorePluginVersion,
  isLegacyEncryptionKeyIdPluginVersion,
} from '../supabase/functions/_backend/utils/plugin_compatibility.ts'
import {
  buildPluginCompatibilityTrendSeries,
  getLatestNonEmptyPluginTrendPoint,
} from '../src/services/adminPluginCompatibility.ts'

describe('plugin compatibility version gates', () => {
  const channelSelfCases: Array<[string, boolean]> = [
    ['5.33.9', true],
    ['5.34.0', false],
    ['6.33.9', true],
    ['6.34.0', false],
    ['7.33.9', true],
    ['7.34.0', false],
    ['8.0.0', false],
    ['0.0.0', true],
    ['invalid', false],
    ['', false],
  ]

  channelSelfCases.forEach(([version, expected]) => {
    it.concurrent(`channel self-store legacy=${expected} for ${version || 'empty'}`, () => {
      expect(isLegacyChannelSelfStorePluginVersion(version)).toBe(expected)
    })
  })

  const encryptionCases: Array<[string, boolean]> = [
    ['8.40.7', true],
    ['8.40.6', true],
    ['8.40.8', false],
    ['7.34.0', true],
    ['5.0.0', true],
    ['invalid', true],
    ['', true],
  ]

  encryptionCases.forEach(([version, expected]) => {
    it.concurrent(`encryption key_id legacy=${expected} for ${version || 'empty'}`, () => {
      expect(isLegacyEncryptionKeyIdPluginVersion(version)).toBe(expected)
    })
  })

  it.concurrent('uses the runtime encryption cutoff constant', () => {
    expect(ENCRYPTION_KEY_ID_FORMAT_MIN_VERSION).toBe('8.40.7')
  })
})

describe('bucketPluginVersionBreakdown', () => {
  it.concurrent('buckets version shares into legacy and current totals', () => {
    const bucket = bucketPluginVersionBreakdown(
      {
        '7.33.0': 30,
        '7.34.0': 50,
        '8.41.0': 20,
      },
      isLegacyChannelSelfStorePluginVersion,
      10_000,
    )

    expect(bucket.legacyPercent).toBe(30)
    expect(bucket.currentPercent).toBe(70)
    expect(bucket.legacyDevices).toBe(3000)
    expect(bucket.currentDevices).toBe(7000)
  })

  it.concurrent('returns null device counts when known-version device total is missing', () => {
    const bucket = bucketPluginVersionBreakdown(
      { '8.40.6': 100 },
      isLegacyEncryptionKeyIdPluginVersion,
    )

    expect(bucket.legacyPercent).toBe(100)
    expect(bucket.currentPercent).toBe(0)
    expect(bucket.legacyDevices).toBeNull()
    expect(bucket.currentDevices).toBeNull()
  })

  it.concurrent('ignores zero-percent versions', () => {
    const bucket = bucketPluginVersionBreakdown(
      {
        '8.40.6': 0,
        '8.41.0': 100,
      },
      isLegacyEncryptionKeyIdPluginVersion,
    )

    expect(bucket.legacyPercent).toBe(0)
    expect(bucket.currentPercent).toBe(100)
  })
})

describe('hasPluginVersionBreakdown', () => {
  it.concurrent('returns false for empty or all-zero breakdowns', () => {
    expect(hasPluginVersionBreakdown({})).toBe(false)
    expect(hasPluginVersionBreakdown({ '8.41.0': 0 })).toBe(false)
    expect(hasPluginVersionBreakdown(null)).toBe(false)
  })

  it.concurrent('returns true when any version has share', () => {
    expect(hasPluginVersionBreakdown({ '8.41.0': 0.1 })).toBe(true)
  })
})

describe('estimateKnownPluginVersionDevicesFromLadder', () => {
  it.concurrent('estimates total devices from one ladder row', () => {
    expect(estimateKnownPluginVersionDevicesFromLadder([
      { device_count: 700, percent: 70 },
      { device_count: 300, percent: 30 },
    ])).toBe(1000)
  })

  it.concurrent('returns null when ladder has no usable rows', () => {
    expect(estimateKnownPluginVersionDevicesFromLadder([])).toBeNull()
    expect(estimateKnownPluginVersionDevicesFromLadder([
      { device_count: 0, percent: 0 },
    ])).toBeNull()
  })
})

describe('getLatestNonEmptyPluginTrendPoint', () => {
  it.concurrent('returns the last trend point with a non-empty breakdown', () => {
    const point = getLatestNonEmptyPluginTrendPoint([
      { date: '2026-01-01', version_breakdown: { '7.34.0': 100 } },
      { date: '2026-01-02', version_breakdown: {} },
    ])

    expect(point?.date).toBe('2026-01-01')
  })

  it.concurrent('returns major_breakdown from the selected trend point when present', () => {
    const point = getLatestNonEmptyPluginTrendPoint([
      {
        date: '2026-08-25',
        version_breakdown: { '8.41.0': 100 },
        major_breakdown: { '8': 100 },
      },
      { date: '2026-08-26', version_breakdown: {} },
    ])

    expect(point?.major_breakdown).toEqual({ '8': 100 })
  })
})

describe('buildPluginCompatibilityTrendSeries', () => {
  it.concurrent('skips trend points with empty breakdowns', () => {
    const series = buildPluginCompatibilityTrendSeries(
      [
        { date: '2026-01-01', version_breakdown: {} },
        {
          date: '2026-01-02',
          version_breakdown: { '7.33.0': 40, '7.34.0': 60 },
        },
      ],
      isLegacyChannelSelfStorePluginVersion,
      { legacy: 'Legacy', current: 'Current' },
    )

    expect(series).toHaveLength(2)
    expect(series[0]?.data).toHaveLength(1)
    expect(series[0]?.data[0]).toEqual({ date: '2026-01-02', value: 40 })
    expect(series[1]?.data[0]).toEqual({ date: '2026-01-02', value: 60 })
  })
})
