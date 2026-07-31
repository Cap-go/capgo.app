import type { VersionInstallRow, WeeklyInstallStatsInput } from '../supabase/functions/_backend/utils/cron_email_stats.ts'
import { describe, expect, it } from 'vitest'
import {
  buildWeeklyEmailMetadata,
  computeWeeklyInstallStats,
  getFailRateFunComparison,
  getPreviousMonthUtcRange,
  isInPreviousMonthRange,
  shouldSendDeployInstallStatsEmail,
  sumVersionInstalls,
  toStatNumber,
} from '../supabase/functions/_backend/utils/cron_email_stats.ts'

/** Historical buggy weekly formula: install - fail. */
function computeBuggyWeeklyInstallStats(input: WeeklyInstallStatsInput) {
  const installs = toStatNumber(input.all_updates)
  const fails = toStatNumber(input.failed_updates)
  const successfulInstalls = installs - fails
  return {
    successfulInstalls,
    totalUpdates: installs,
    successPercentage: installs > 0 ? Math.round((successfulInstalls / installs) * 10_000) / 10_000 : 0,
    failureRate: installs > 0 ? Math.round((fails / installs) * 10_000) / 10_000 : 0,
  }
}

/** Historical buggy reduce: uncoerced Analytics Engine strings concatenate. */
function sumVersionInstallsBuggy(
  versionStats: VersionInstallRow[],
  versionName?: string | null,
  versionId?: number | null,
): number | string {
  const versionIdStr = versionId != null ? String(versionId) : null
  let sum: number | string = 0
  for (const row of versionStats) {
    if (!(row.version_name === versionName || (versionIdStr != null && row.version_name === versionIdStr)))
      continue
    // Historical path: sum + (row.install ?? 0) with no Number() coercion.
    // When install is a Float64 string from Analytics Engine, JS concatenates.
    const raw = row.install ?? 0
    sum = typeof sum === 'number' && typeof raw === 'number'
      ? sum + raw
      : `${sum}${raw}`
  }
  return sum
}

function assertCleanNumericString(value: string, label: string) {
  expect(value, label).toMatch(/^\d+(\.\d+)?$/)
  expect(value, `${label} must not have leading zeros trash`).not.toMatch(/^0\d/)
  expect(Number(value), label).toBeGreaterThanOrEqual(0)
  expect(Number.isFinite(Number(value)), label).toBe(true)
}

function adminSuccessRate(installs: number, fails: number): number {
  const total = installs + fails
  return total > 0 ? (installs / total) * 100 : 0
}

describe('cron email stats backtest', () => {
  it.concurrent('never reproduces the old install-fail negative/wrong-rate bug across production-like weeks', () => {
    const weeks = [
      { install: 0, fail: 0, get: 0 },
      { install: 1, fail: 0, get: 10 },
      { install: 100, fail: 0, get: 500 },
      { install: 100, fail: 1, get: 500 },
      { install: 100, fail: 9, get: 500 },
      { install: 100, fail: 10, get: 500 },
      { install: 100, fail: 20, get: 500 },
      { install: 100, fail: 50, get: 500 },
      { install: 100, fail: 150, get: 500 },
      { install: 10, fail: 40, get: 20 },
      { install: 250_000, fail: 12_500, get: 1_000_000 },
      { install: '80', fail: '20', get: '10' },
      { install: '0', fail: '5', get: '2' },
    ] as const

    for (const week of weeks) {
      const fixed = computeWeeklyInstallStats({
        all_updates: week.install,
        failed_updates: week.fail,
        open_app: week.get,
      })
      const buggy = computeBuggyWeeklyInstallStats({
        all_updates: week.install,
        failed_updates: week.fail,
      })

      const installs = Math.max(0, Math.round(toStatNumber(week.install)))
      const fails = Math.max(0, Math.round(toStatNumber(week.fail)))

      // Fixed formula invariants
      expect(fixed.successfulInstalls).toBe(installs)
      expect(fixed.failedUpdates).toBe(fails)
      expect(fixed.totalUpdates).toBe(installs + fails)
      expect(fixed.successfulInstalls).toBeGreaterThanOrEqual(0)
      expect(fixed.failedUpdates).toBeGreaterThanOrEqual(0)
      expect(fixed.successPercentage).toBeGreaterThanOrEqual(0)
      expect(fixed.successPercentage).toBeLessThanOrEqual(1)
      expect(fixed.failureRate).toBeGreaterThanOrEqual(0)
      expect(fixed.failureRate).toBeLessThanOrEqual(1)
      expect(Math.abs((fixed.successPercentage + fixed.failureRate) - (fixed.totalUpdates > 0 ? 1 : 0))).toBeLessThan(0.0002)

      // Must match admin dashboard success_rate formula
      const expectedAdmin = adminSuccessRate(installs, fails)
      expect(fixed.successPercentage * 100).toBeCloseTo(expectedAdmin, 2)

      // Prove old formula was wrong on the known bad cases
      if (fails > installs) {
        expect(buggy.successfulInstalls).toBeLessThan(0)
        expect(fixed.successfulInstalls).toBeGreaterThanOrEqual(0)
      }
      if (fails > 0 && installs > 0 && fails !== installs) {
        expect(fixed.successPercentage).not.toBe(buggy.successPercentage)
      }
    }
  })

  it.concurrent('builds weekly email metadata that cannot look like trash numbers', () => {
    const cases = [
      { install: 100, fail: 0, get: 200 },
      { install: 100, fail: 5, get: 200 },
      { install: 100, fail: 50, get: 200 },
      { install: 10, fail: 40, get: 5 },
      { install: '250000', fail: '12500', get: '1000000' },
    ]

    for (const week of cases) {
      const stats = computeWeeklyInstallStats({
        all_updates: week.install,
        failed_updates: week.fail,
        open_app: week.get,
      })
      const metadata = buildWeeklyEmailMetadata('com.demo.app', stats, new Date('2026-07-25T12:00:00.000Z'))

      assertCleanNumericString(metadata.weekly_updates, 'weekly_updates')
      assertCleanNumericString(metadata.weekly_install, 'weekly_install')
      assertCleanNumericString(metadata.weekly_fail, 'weekly_fail')
      assertCleanNumericString(metadata.weekly_open, 'weekly_open')
      assertCleanNumericString(metadata.weekly_install_success, 'weekly_install_success')

      expect(Number(metadata.weekly_updates)).toBe(stats.totalUpdates)
      expect(Number(metadata.weekly_install)).toBe(stats.successfulInstalls)
      expect(Number(metadata.weekly_fail)).toBe(stats.failedUpdates)
      expect(Number(metadata.weekly_open)).toBe(stats.openApp)
      expect(Number(metadata.weekly_install_success)).toBeCloseTo(stats.successPercentage * 100, 4)

      // Never claim installs > updates
      expect(Number(metadata.weekly_install)).toBeLessThanOrEqual(Number(metadata.weekly_updates))
      // Never claim fails > updates
      expect(Number(metadata.weekly_fail)).toBeLessThanOrEqual(Number(metadata.weekly_updates))
    }
  })

  it.concurrent('never says flawless when there were failed updates', () => {
    const flawless = getFailRateFunComparison(0, 0)
    expect(flawless.toLowerCase()).toContain('flawless')

    const tinyFail = getFailRateFunComparison(1, 0.01)
    expect(tinyFail.toLowerCase()).not.toContain('flawless')
    expect(tinyFail.toLowerCase()).not.toContain('no failed updates')

    // Rounded rate can be 0 with nonzero fails on huge volume weeks.
    const roundedZero = getFailRateFunComparison(1, 0)
    expect(roundedZero.toLowerCase()).not.toContain('flawless')
    expect(roundedZero.toLowerCase()).not.toContain('no failed updates')

    const tenPercent = getFailRateFunComparison(10, 0.10)
    expect(tenPercent.toLowerCase()).toContain('about one in ten')
    expect(tenPercent.toLowerCase()).not.toContain('one in five')

    const twentyPercent = getFailRateFunComparison(20, 0.20)
    expect(twentyPercent.toLowerCase()).toContain('one in five')
    expect(twentyPercent.toLowerCase()).not.toContain('third')

    const highFail = getFailRateFunComparison(40, 0.4)
    expect(highFail.toLowerCase()).toContain('failing')

    // Metadata path must also obey this
    const metadata = buildWeeklyEmailMetadata(
      'com.demo.app',
      computeWeeklyInstallStats({ all_updates: 100, failed_updates: 3, open_app: 10 }),
    )
    expect(metadata.fun_comparison_2.toLowerCase()).not.toContain('flawless')
    expect(metadata.fun_comparison_2.toLowerCase()).not.toContain('no failed updates')
  })

  it.concurrent('monthly window includes the last moment of previous month and excludes current month', () => {
    const now = new Date('2026-07-01T00:30:00.000Z')
    const range = getPreviousMonthUtcRange(now)

    expect(range.startIso).toBe('2026-06-01T00:00:00.000Z')
    expect(range.endExclusiveIso).toBe('2026-07-01T00:00:00.000Z')

    // Old buggy end was June 30 00:00:00 → dropped almost all of June 30
    const oldBuggyEnd = '2026-06-30T00:00:00.000Z'
    const lastDayMorning = '2026-06-30T00:00:01.000Z'
    const lastDayNight = '2026-06-30T23:59:59.999Z'
    const nextMonthStart = '2026-07-01T00:00:00.000Z'
    const nextMonthLater = '2026-07-01T00:00:00.001Z'

    expect(isInPreviousMonthRange(lastDayMorning, now)).toBe(true)
    expect(isInPreviousMonthRange(lastDayNight, now)).toBe(true)
    expect(isInPreviousMonthRange(nextMonthStart, now)).toBe(false)
    expect(isInPreviousMonthRange(nextMonthLater, now)).toBe(false)

    // Prove the old lte(oldBuggyEnd) would have missed these
    expect(lastDayMorning > oldBuggyEnd).toBe(true)
    expect(lastDayNight > oldBuggyEnd).toBe(true)
    expect(lastDayNight < range.endExclusiveIso).toBe(true)
  })

  it.concurrent('backtests 24h install summing against the old string-concat trash path', () => {
    const rows = [
      { version_name: '1.2.3', install: '10' },
      { version_name: '1.2.3', install: '20' },
      { version_name: '1.2.3', install: '30' },
      { version_name: '9.9.9', install: '999' },
      { version_name: '55', install: '5' },
    ]

    const fixed = sumVersionInstalls(rows, '1.2.3', 55)
    const buggy = sumVersionInstallsBuggy(rows, '1.2.3', 55)

    expect(fixed).toBe(65) // 10+20+30+5
    expect(typeof fixed).toBe('number')
    expect(shouldSendDeployInstallStatsEmail(fixed)).toBe(true)

    // Old path string-concatenated analytics Float64 values into junk like "01020305"
    expect(buggy).toBe('01020305')
    expect(String(buggy)).toMatch(/^0\d/)

    // Empty / no match must not send and must stay a real number 0
    expect(sumVersionInstalls([], '1.2.3', 1)).toBe(0)
    expect(shouldSendDeployInstallStatsEmail(0)).toBe(false)
    expect(shouldSendDeployInstallStatsEmail(1)).toBe(false)
    expect(shouldSendDeployInstallStatsEmail(2)).toBe(true)
  })

  it.concurrent('stress-tests random weeks so rates stay sane and email fields stay clean', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }

    for (let i = 0; i < 250; i += 1) {
      const installs = Math.floor(rand() * 50_000)
      const fails = Math.floor(rand() * 50_000)
      const gets = Math.floor(rand() * 100_000)
      const asStrings = rand() > 0.5

      const stats = computeWeeklyInstallStats({
        all_updates: asStrings ? String(installs) : installs,
        failed_updates: asStrings ? String(fails) : fails,
        open_app: asStrings ? String(gets) : gets,
      })
      const metadata = buildWeeklyEmailMetadata('com.stress.app', stats)

      expect(stats.totalUpdates).toBe(installs + fails)
      expect(stats.successfulInstalls + stats.failedUpdates).toBe(stats.totalUpdates)
      expect(stats.successPercentage).toBeGreaterThanOrEqual(0)
      expect(stats.successPercentage).toBeLessThanOrEqual(1)
      expect(Math.abs(stats.successPercentage * 100 - adminSuccessRate(installs, fails))).toBeLessThan(0.05)

      assertCleanNumericString(metadata.weekly_updates, `week ${i} weekly_updates`)
      assertCleanNumericString(metadata.weekly_install, `week ${i} weekly_install`)
      assertCleanNumericString(metadata.weekly_fail, `week ${i} weekly_fail`)
      assertCleanNumericString(metadata.weekly_install_success, `week ${i} weekly_install_success`)

      if (fails > 0) {
        expect(metadata.fun_comparison_2.toLowerCase()).not.toContain('flawless')
        expect(metadata.fun_comparison_2.toLowerCase()).not.toContain('no failed updates')
      }
      else {
        expect(metadata.fun_comparison_2.toLowerCase()).toContain('flawless')
      }
    }
  })
})
