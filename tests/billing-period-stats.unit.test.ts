import { describe, expect, it } from 'vitest'
import { billingPeriodStatsTestUtils } from '../supabase/functions/_backend/triggers/cron_email.ts'

const { toDateOnlyUtc, addDaysToDateOnly, billingPeriodMetricsRange } = billingPeriodStatsTestUtils

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
})
