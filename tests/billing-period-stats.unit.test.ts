import { describe, expect, it } from 'vitest'
import { billingPeriodStatsTestUtils } from '../supabase/functions/_backend/triggers/cron_email.ts'

// The SQL cycle helper itself (billing_period_completed_cycle) is covered by
// supabase/tests/63_test_billing_period_stats_email.sql; here we only test the
// TypeScript mapping from a half-open cycle to the inclusive metrics range.
const { toDateOnlyUtc, addDaysToDateOnly, billingPeriodMetricsRange } = billingPeriodStatsTestUtils
const DAY_MS = 24 * 60 * 60 * 1000

const iso = (date: Date) => date.toISOString().slice(0, 10)
function clampedAnniversary(year: number, monthIndex: number, dom: number) {
  return new Date(Date.UTC(year, monthIndex, Math.min(dom, new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate())))
}

describe('billing period stats date helpers', () => {
  it.concurrent('extracts calendar date from timestamptz without shifting days', () => {
    expect(toDateOnlyUtc('2026-06-15T13:54:45+00:00')).toBe('2026-06-15')
    expect(toDateOnlyUtc('2026-06-15 00:00:00+00')).toBe('2026-06-15')
    expect(toDateOnlyUtc('2026-07-15')).toBe('2026-07-15')
  })

  it.concurrent('shifts date-only values in UTC', () => {
    expect(addDaysToDateOnly('2026-07-15', -1)).toBe('2026-07-14')
    expect(addDaysToDateOnly('2026-03-01', -1)).toBe('2026-02-28')
  })

  it.concurrent('maps half-open cycle bounds to inclusive metrics end', () => {
    expect(billingPeriodMetricsRange('2026-06-15T00:00:00+00:00', '2026-07-15T00:00:00+00:00')).toEqual({
      periodStart: '2026-06-15',
      periodEndExclusive: '2026-07-15',
      metricsEndInclusive: '2026-07-14',
    })
  })

  it.concurrent.each([
    [31, '2025-12-31', '2026-01-31'],
    [31, '2026-01-31', '2026-02-28'],
    [31, '2026-02-28', '2026-03-31'],
    [31, '2024-01-31', '2024-02-29'],
    [31, '2024-02-29', '2024-03-31'],
    [30, '2026-01-30', '2026-02-28'],
    [29, '2025-01-29', '2025-02-28'],
    [1, '2026-02-01', '2026-03-01'],
  ])('maps the DOM %i month-end cycle %s..%s to metrics ending the day before', (_dom, start, end) => {
    const range = billingPeriodMetricsRange(`${start}T00:00:00.000Z`, `${end}T00:00:00.000Z`)
    expect(range.periodStart).toBe(start)
    expect(range.periodEndExclusive).toBe(end)
    expect(range.metricsEndInclusive).toBe(addDaysToDateOnly(end, -1))
  })

  it.concurrent('covers exactly every day of each clamped monthly cycle for every DOM over three years', () => {
    const bad: string[] = []
    for (let dom = 1; dom <= 31; dom++) {
      for (let month = 0; month < 36; month++) {
        const start = clampedAnniversary(2024, month - 1, dom)
        const end = clampedAnniversary(2024, month, dom)
        const range = billingPeriodMetricsRange(start.toISOString(), end.toISOString())
        const halfOpenDays = Math.round((end.getTime() - start.getTime()) / DAY_MS)
        const inclusiveDays = Math.round((Date.parse(range.metricsEndInclusive) - Date.parse(range.periodStart)) / DAY_MS) + 1
        if (range.periodStart !== iso(start) || range.periodEndExclusive !== iso(end) || inclusiveDays !== halfOpenDays || halfOpenDays < 28 || halfOpenDays > 31)
          bad.push(`dom=${dom} ${iso(start)}..${iso(end)} ${JSON.stringify(range)}`)
      }
    }
    expect(bad.slice(0, 20)).toEqual([])
  })
})
