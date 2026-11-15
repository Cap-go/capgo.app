import { describe, expect, it } from 'vitest'
import {
  buildWeeklyEmailMetadata,
  computeWeeklyInstallStats,
  getPreviousMonthUtcRange,
  getWeeklyReportRange,
  isInPreviousMonthRange,
  shouldRetryDeployInstallStats,
  shouldSendDeployInstallStatsEmail,
  summarizeDeviceVersionAdoption,
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

describe('weekly event reports', () => {
  it.concurrent('keeps repeated checks separate from installs and failures', () => {
    const stats = computeWeeklyInstallStats({ all_updates: '90', failed_updates: '10', update_checks: '1200000' })
    expect(stats).toEqual({ successfulInstalls: 90, failedUpdates: 10, updateChecks: 1200000 })
    const metadata = buildWeeklyEmailMetadata('com.example.report', stats, getWeeklyReportRange(new Date('2026-01-03T12:30:00Z')))
    expect(metadata).toMatchObject({
      report_schema_version: '2', window_start: '2025-12-27', window_end: '2026-01-03',
      weekly_install: '90', weekly_fail: '10', weekly_update_checks: '1200000', weekly_update_checks_formatted: '1,200,000',
    })
    expect(metadata).not.toHaveProperty('weekly_open')
    expect(metadata).not.toHaveProperty('weekly_install_success')
    expect(metadata).not.toHaveProperty('fun_comparison_2')
  })

  it.concurrent.each([null, undefined, '', 'NaN', 'Infinity', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid analytics instead of sending a misleading zero: %s', (value) => {
    for (const field of ['all_updates', 'failed_updates', 'update_checks']) {
      expect(() => computeWeeklyInstallStats({ all_updates: 1, failed_updates: 0, update_checks: 2, [field]: value })).toThrow()
    }
  })

  it.concurrent('preserves zero counts and failures greater than installs without a health claim', () => {
    expect(computeWeeklyInstallStats({ all_updates: 0, failed_updates: 40, update_checks: 0 }))
      .toEqual({ successfulInstalls: 0, failedUpdates: 40, updateChecks: 0 })
  })

  it.concurrent('uses seven completed UTC days regardless of time of day or timezone', () => {
    expect(getWeeklyReportRange(new Date('2026-03-01T23:59:59Z'))).toEqual({ start: '2026-02-22', end: '2026-03-01' })
    expect(getWeeklyReportRange(new Date('2026-03-02T01:00:00+02:00'))).toEqual({ start: '2026-02-22', end: '2026-03-01' })
    expect(getWeeklyReportRange(new Date('2024-03-01T00:00:00Z'))).toEqual({ start: '2024-02-23', end: '2024-03-01' })
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

  it.concurrent('includes the whole last day of the previous month and excludes the current month', () => {
    // The old window ended at June 30 00:00:00 and dropped almost all of June 30.
    const now = new Date('2026-07-01T00:30:00.000Z')
    expect(isInPreviousMonthRange('2026-06-30T00:00:01.000Z', now)).toBe(true)
    expect(isInPreviousMonthRange('2026-06-30T23:59:59.999Z', now)).toBe(true)
    expect(isInPreviousMonthRange('2026-07-01T00:00:00.000Z', now)).toBe(false)
    expect(isInPreviousMonthRange('2026-07-01T00:00:00.001Z', now)).toBe(false)
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

  it.concurrent('does not match every nameless row when versionName is absent', () => {
    const installs = sumVersionInstalls(
      [
        { version_name: undefined, install: 50 },
        { version_name: null, install: 50 },
        { version_name: '99', install: 3 },
      ],
      undefined,
      99,
    )
    expect(installs).toBe(3)
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
    expect(sumVersionInstalls([], '1.2.3', 1)).toBe(0)
    expect(shouldSendDeployInstallStatsEmail(0)).toBe(false)
    expect(shouldSendDeployInstallStatsEmail(1)).toBe(false)
    expect(shouldSendDeployInstallStatsEmail(2)).toBe(true)
  })
})

describe('deploy report count validation', () => {
  it.concurrent.each([null, undefined, '', '  ', '0x10', 'invalid', -1, '-5', Number.NaN, Number.POSITIVE_INFINITY, 'Infinity', 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid install count %s', (install) => {
    expect(() => sumVersionInstalls([{ version_name: '1.0.0', install }], '1.0.0')).toThrow()
  })

  it.concurrent('rejects an overflowing total instead of rounding it', () => {
    expect(() => sumVersionInstalls([
      { version_name: '1.0.0', install: Number.MAX_SAFE_INTEGER },
      { version_name: '1.0.0', install: 1 },
    ], '1.0.0')).toThrow()
  })

  it.concurrent.each([Number.POSITIVE_INFINITY, Number.NaN, -10, 1.5, Number.MAX_SAFE_INTEGER + 1])('does not send invalid total %s', installs => {
    expect(shouldSendDeployInstallStatsEmail(installs)).toBe(false)
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

  it.concurrent('does not retry future deploy timestamps', () => {
    const deployedAt = new Date('2026-07-26T00:00:00.000Z')
    const now = new Date('2026-07-25T00:00:00.000Z')
    expect(shouldRetryDeployInstallStats(deployedAt, now)).toBe(false)
  })
})

describe('summarizeDeviceVersionAdoption', () => {
  it.concurrent('computes live device reach for a deployed bundle', () => {
    expect(summarizeDeviceVersionAdoption({
      '1.0.0': 20,
      '1.1.0': 80,
    }, '1.1.0')).toEqual({
      device_count: 80,
      total_devices: 100,
      adoption_percent: '80.0',
    })
  })

  it.concurrent('returns zeros when no devices have reported', () => {
    expect(summarizeDeviceVersionAdoption({}, '1.1.0')).toEqual({
      device_count: 0,
      total_devices: 0,
      adoption_percent: '0.0',
    })
  })

  it.concurrent('falls back to version_id string keys used by legacy device counts', () => {
    expect(summarizeDeviceVersionAdoption({
      9601: 40,
      9602: 60,
    }, '1.1.0', 9602)).toEqual({
      device_count: 60,
      total_devices: 100,
      adoption_percent: '60.0',
    })
  })

  it.concurrent('keeps one-decimal rounding for fractional shares', () => {
    expect(summarizeDeviceVersionAdoption({
      '1.0.0': 77,
      '1.1.0': 56,
    }, '1.1.0')).toEqual({
      device_count: 56,
      total_devices: 133,
      adoption_percent: '42.1',
    })
  })
})

function assertCleanNumericString(value: string, label: string) {
  expect(value, label).toMatch(/^\d+(\.\d+)?$/)
  expect(value, `${label} must not have leading zeros trash`).not.toMatch(/^0\d/)
}

describe('weekly stats invariants (seeded random weeks)', () => {
  it.concurrent('preserves independent counts and emits clean numeric email fields', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }

    for (let i = 0; i < 250; i += 1) {
      const installs = Math.floor(rand() * 50_000)
      const fails = i === 0 ? 0 : Math.floor(rand() * 50_000)
      const gets = Math.floor(rand() * 100_000)
      const asStrings = rand() > 0.5

      const stats = computeWeeklyInstallStats({
        all_updates: asStrings ? String(installs) : installs,
        failed_updates: asStrings ? String(fails) : fails,
        update_checks: asStrings ? String(gets) : gets,
      })
      const metadata = buildWeeklyEmailMetadata('com.stress.app', stats, getWeeklyReportRange())
      expect(stats.successfulInstalls).toBe(installs)
      expect(stats.failedUpdates).toBe(fails)
      expect(stats.updateChecks).toBe(gets)
      for (const field of ['weekly_install', 'weekly_fail', 'weekly_update_checks'] as const)
        assertCleanNumericString(metadata[field], `week ${i} ${field}`)
    }
  })
})
