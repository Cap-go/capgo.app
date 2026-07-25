import { describe, expect, it } from 'vitest'
import {
  buildWeeklyEmailMetadata,
  computeWeeklyInstallStats,
  getFailRateFunComparison,
  getPreviousMonthUtcRange,
  shouldRetryDeployInstallStats,
  shouldSendDeployInstallStatsEmail,
  sumVersionInstalls,
  toStatNumber,
} from '../supabase/functions/_backend/utils/cron_email_stats.ts'

describe('toStatNumber', () => {
  it.concurrent('coerces string numbers from analytics aggregates', () => {
    expect(toStatNumber('12')).toBe(12)
    expect(toStatNumber('0')).toBe(0)
    expect(toStatNumber(null)).toBe(0)
    expect(toStatNumber(undefined)).toBe(0)
    expect(toStatNumber(Number.NaN)).toBe(0)
  })
})

describe('computeWeeklyInstallStats', () => {
  it.concurrent('uses install/(install+fail), not install-fail', () => {
    const stats = computeWeeklyInstallStats({
      all_updates: 100,
      failed_updates: 50,
      open_app: 200,
    })

    expect(stats.successfulInstalls).toBe(100)
    expect(stats.failedUpdates).toBe(50)
    expect(stats.totalUpdates).toBe(150)
    expect(stats.successPercentage).toBe(0.6667)
    expect(stats.failureRate).toBe(0.3333)
    expect(stats.openApp).toBe(200)
  })

  it.concurrent('handles more fails than installs without negative success', () => {
    const stats = computeWeeklyInstallStats({
      all_updates: 10,
      failed_updates: 40,
      open_app: 0,
    })

    expect(stats.successfulInstalls).toBe(10)
    expect(stats.totalUpdates).toBe(50)
    expect(stats.successPercentage).toBe(0.2)
    expect(stats.failureRate).toBe(0.8)
  })

  it.concurrent('returns zeros when there is no update activity', () => {
    const stats = computeWeeklyInstallStats({
      all_updates: 0,
      failed_updates: 0,
      open_app: 5,
    })

    expect(stats.totalUpdates).toBe(0)
    expect(stats.successPercentage).toBe(0)
    expect(stats.failureRate).toBe(0)
    expect(stats.openApp).toBe(5)
  })

  it.concurrent('coerces stringy SQL/rpc values', () => {
    const stats = computeWeeklyInstallStats({
      all_updates: '80',
      failed_updates: '20',
      open_app: '10',
    })

    expect(stats.totalUpdates).toBe(100)
    expect(stats.successPercentage).toBe(0.8)
    expect(stats.failureRate).toBe(0.2)
  })
})

describe('getFailRateFunComparison', () => {
  it.concurrent('reserves flawless copy for zero failures only', () => {
    expect(getFailRateFunComparison(0, 0).toLowerCase()).toContain('flawless')
    expect(getFailRateFunComparison(1, 0.01).toLowerCase()).not.toContain('flawless')
  })
})

describe('buildWeeklyEmailMetadata', () => {
  it.concurrent('keeps install/fail/success fields consistent', () => {
    const stats = computeWeeklyInstallStats({
      all_updates: 90,
      failed_updates: 10,
      open_app: 300,
    })
    const metadata = buildWeeklyEmailMetadata('com.demo.app', stats, new Date('2026-07-25T00:00:00.000Z'))

    expect(metadata.weekly_updates).toBe('100')
    expect(metadata.weekly_install).toBe('90')
    expect(metadata.weekly_fail).toBe('10')
    expect(metadata.weekly_install_success).toBe('90')
    expect(metadata.fun_comparison_2.toLowerCase()).not.toContain('flawless')
  })
})

describe('getPreviousMonthUtcRange', () => {
  it.concurrent('covers the full previous UTC month with an exclusive end', () => {
    const range = getPreviousMonthUtcRange(new Date('2026-07-25T12:00:00.000Z'))

    expect(range.monthName).toBe('June')
    expect(range.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(range.endExclusiveIso).toBe('2026-07-01T00:00:00.000Z')
  })

  it.concurrent('handles January rollover into previous year', () => {
    const range = getPreviousMonthUtcRange(new Date('2026-01-05T00:00:00.000Z'))

    expect(range.monthName).toBe('December')
    expect(range.startIso).toBe('2025-12-01T00:00:00.000Z')
    expect(range.endExclusiveIso).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('sumVersionInstalls', () => {
  it.concurrent('sums numeric and string install counts for matching versions', () => {
    const installs = sumVersionInstalls(
      [
        { version_name: '1.2.3', install: '10' },
        { version_name: '1.2.3', install: 5 },
        { version_name: '9.9.9', install: 100 },
        { version_name: '42', install: '7' },
      ],
      '1.2.3',
      42,
    )

    // Matches version name 1.2.3 (10+5) and legacy version_id blob "42" (7)
    expect(installs).toBe(22)
  })

  it.concurrent('does not string-concatenate analytics Float64 values', () => {
    const installs = sumVersionInstalls(
      [
        { version_name: '1.0.0', install: '10' },
        { version_name: '1.0.0', install: '20' },
      ],
      '1.0.0',
      null,
    )

    expect(installs).toBe(30)
    expect(typeof installs).toBe('number')
    expect(shouldSendDeployInstallStatsEmail(installs)).toBe(true)
  })
})

describe('shouldRetryDeployInstallStats', () => {
  it.concurrent('retries within 48 hours of deploy', () => {
    const deployedAt = new Date('2026-07-25T00:00:00.000Z')
    const now = new Date('2026-07-26T12:00:00.000Z')
    expect(shouldRetryDeployInstallStats(deployedAt, now)).toBe(true)
  })

  it.concurrent('stops retrying after the retry window', () => {
    const deployedAt = new Date('2026-07-25T00:00:00.000Z')
    const now = new Date('2026-07-27T00:00:01.000Z')
    expect(shouldRetryDeployInstallStats(deployedAt, now)).toBe(false)
  })
})
