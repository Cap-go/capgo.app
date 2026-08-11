import { describe, expect, it } from 'vitest'
import { bundleInstallStatsTestUtils } from '../supabase/functions/_backend/private/bundle_install_stats.ts'

describe('bundle install stats helpers', () => {
  it.concurrent('normalizes supported period days', () => {
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(undefined)).toBe(30)
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(1)).toBe(1)
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(7)).toBe(7)
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(30)).toBe(30)
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(2)).toBeNull()
    expect(bundleInstallStatsTestUtils.normalizePeriodDays(365)).toBeNull()
  })

  it.concurrent('computes success rate from install and fail counts', () => {
    expect(bundleInstallStatsTestUtils.computeSuccessRate(90, 10)).toBe(90)
    expect(bundleInstallStatsTestUtils.computeSuccessRate(0, 0)).toBeNull()
    expect(bundleInstallStatsTestUtils.computeSuccessRate(1, 0)).toBe(100)
  })

  it('pairs download start to set for install timing samples', () => {
    const samples = bundleInstallStatsTestUtils.buildInstallTimingsFromEvents([
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_0',
        version_name: '1.0.0',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-01T10:00:00.000Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'set',
        version_name: '1.0.0',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-01T10:00:05.000Z',
      },
    ], {
      periodStartMs: Date.parse('2026-07-01T00:00:00.000Z'),
    })

    expect(samples).toHaveLength(1)
    expect(samples[0]?.version_name).toBe('1.0.0')
    expect(samples[0]?.duration_ms).toBe(5000)
  })

  it('aggregates install timing percentiles per version', () => {
    const rows = bundleInstallStatsTestUtils.aggregateInstallTimingsByVersion([
      { version_name: '1.0.0', duration_ms: 1000 },
      { version_name: '1.0.0', duration_ms: 3000 },
      { version_name: '1.0.0', duration_ms: 5000 },
      { version_name: '1.1.0', duration_ms: 2000 },
    ])

    const v100 = rows.get('1.0.0')
    expect(v100?.samples).toBe(3)
    expect(v100?.p50_ms).toBe(3000)
    expect(v100?.p70_ms).toBe(3800)
    expect(rows.get('1.1.0')?.p50_ms).toBe(2000)
  })

  it('builds merged bundle response sorted by activity', () => {
    const response = bundleInstallStatsTestUtils.buildBundleInstallResponse({
      days: 7,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-07T23:59:59.999Z',
      successRows: [
        { version_name: '1.0.0', install: 10, fail: 2 },
        { version_name: '1.1.0', install: 50, fail: 5 },
      ],
      timingRows: new Map([
        ['1.0.0', { version_name: '1.0.0', samples: 8, p50_ms: 1200, p70_ms: 1500, p90_ms: 1800, p95_ms: 2000 }],
      ]),
    })

    expect(response.bundles[0]?.version_name).toBe('1.1.0')
    expect(response.bundles[0]?.success_rate).toBe(90.9)
    expect(response.totals.success_rate).toBe(89.6)
    expect(response.bundles[1]?.timing.p50_ms).toBe(1200)
  })
})
