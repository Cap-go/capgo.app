import { describe, expect, it } from 'vitest'
import {
  payAsYouGoEligiblePeakMau,
  trialUsageRecapDisplayFlags,
  trialUsageRecapUniqId,
  trialUsageMetricsDateRange,
  utcCalendarDateFromIso,
  trialUsageVariant,
  TRIAL_USAGE_RECAP_LOW_THRESHOLD,
} from '../supabase/functions/_backend/utils/trial_usage_recap.ts'

describe('trial usage recap', () => {
  it('computes inclusive UTC metric window ending the day before trial end', () => {
    const range = trialUsageMetricsDateRange('2025-01-01T12:00:00.000Z', '2025-01-16T00:00:00.000Z')
    expect(range).toEqual({ startDate: '2025-01-01', endDate: '2025-01-15' })
  })

  it('uses UTC calendar dates for timestamps with a non UTC offset', () => {
    expect(utcCalendarDateFromIso('2025-01-01T23:30:00-05:00')).toBe('2025-01-02')
    const range = trialUsageMetricsDateRange(
      '2025-01-01T23:30:00-05:00',
      '2025-01-16T00:00:00.000Z',
    )
    expect(range).toEqual({ startDate: '2025-01-02', endDate: '2025-01-15' })
  })

  it('returns single day window when org was created on trial eve', () => {
    const range = trialUsageMetricsDateRange('2025-01-15T20:00:00.000Z', '2025-01-16T10:00:00.000Z')
    expect(range).toEqual({ startDate: '2025-01-15', endDate: '2025-01-15' })
  })

  it('prefers low usage variant below the threshold score', () => {
    expect(trialUsageVariant(
      { apps: 1, channels: 1, bundles_uploaded: 0, deploys: 0, native_builds: 0, peak_daily_mau: 0 },
      1,
      0,
    ).variant).toBe('usage')
    expect(trialUsageVariant(
      { apps: 0, channels: 0, bundles_uploaded: 0, deploys: 0, native_builds: 0, peak_daily_mau: 0 },
      0,
      0,
    ).variant).toBe('low_usage')
    expect(trialUsageVariant(
      { apps: 1, channels: 1, bundles_uploaded: 0, deploys: 0, native_builds: 0, peak_daily_mau: 0 },
      0,
      0,
    ).score).toBeLessThan(TRIAL_USAGE_RECAP_LOW_THRESHOLD)
  })

  it('flags pay as you go copy under 500 peak daily mau only', () => {
    expect(payAsYouGoEligiblePeakMau(0)).toBe(true)
    expect(payAsYouGoEligiblePeakMau(499)).toBe(true)
    expect(payAsYouGoEligiblePeakMau(500)).toBe(false)
  })

  it('builds stable idempotent uniq ids per org per trial end date', () => {
    const org = '00000000-0000-4000-8000-000000000001'
    expect(trialUsageRecapUniqId('trial_usage_recap', org, '2026-02-10')).toBe(
      'trial_usage_recap:00000000-0000-4000-8000-000000000001:2026-02-10',
    )
    expect(trialUsageRecapUniqId('trial_end_usage_recap', org, '2026-02-10')).toBe(
      'trial_end_usage_recap:00000000-0000-4000-8000-000000000001:2026-02-10',
    )
  })

  it('never shows zero metrics as achievements in display flags', () => {
    const allZero = trialUsageRecapDisplayFlags({
      successful_updates: 0,
      failed_updates: 0,
      bandwidth_bytes: 0n,
      peak_daily_mau: 0,
      bundles_uploaded: 0,
      deploy_count: 0,
      native_builds_run: 0,
      channels_count: 0,
      apps_count: 0,
    })
    expect(Object.values(allZero).every(v => v === false)).toBe(true)

    expect(trialUsageRecapDisplayFlags({
      successful_updates: 0,
      failed_updates: 0,
      bandwidth_bytes: Number.NaN,
      peak_daily_mau: 0,
      bundles_uploaded: 0,
      deploy_count: 0,
      native_builds_run: 0,
      channels_count: 0,
      apps_count: 0,
    }).show_bandwidth).toBe(false)

    const baseZeros = {
      successful_updates: 0,
      failed_updates: 0,
      bandwidth_bytes: 0n,
      peak_daily_mau: 0,
      bundles_uploaded: 0,
      deploy_count: 0,
      native_builds_run: 0,
      channels_count: 0,
      apps_count: 0,
    } as const
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, successful_updates: 1 }).show_successful_updates).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, bandwidth_bytes: 1n }).show_bandwidth).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, peak_daily_mau: 1 }).show_peak_mau).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, bundles_uploaded: 1 }).show_bundles_uploaded).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, deploy_count: 1 }).show_deploy_count).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, native_builds_run: 1 }).show_native_builds).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, channels_count: 1 }).show_channels_count).toBe(true)
    expect(trialUsageRecapDisplayFlags({ ...baseZeros, apps_count: 1 }).show_apps_count).toBe(true)
  })
})
