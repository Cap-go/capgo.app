import { describe, expect, it, vi } from 'vitest'
import {
  filterDailySeriesToBillingPeriod,
  resolveDashboardDailySeriesWindow,
} from '../src/utils/chartOptimizations'

describe('chart optimizations billing window', () => {
  it('uses elapsed UTC days across month-length boundaries', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-01T12:00:00.000Z'))

    try {
      const billingStart = new Date('2026-03-30T00:00:00.000Z')
      const seriesStart = new Date('2026-03-03T00:00:00.000Z')
      const fullData = Array.from({ length: 30 }).fill(0) as number[]
      // Index for March 30, 31, April 1 relative to seriesStart (Mar 3)
      fullData[27] = 1
      fullData[28] = 2
      fullData[29] = 3

      const { data } = filterDailySeriesToBillingPeriod(fullData, seriesStart, billingStart)
      expect(data).toHaveLength(3)
      expect(data).toEqual([1, 2, 3])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.concurrent('starts billing fetch windows at the cycle anchor for 31-day cycles', () => {
    const now = new Date('2026-03-31T15:00:00.000Z')
    const billingStart = new Date('2026-03-01T00:00:00.000Z')
    const window = resolveDashboardDailySeriesWindow(true, billingStart, now)

    expect(window.seriesStart.toISOString()).toBe('2026-03-01T00:00:00.000Z')
    expect(window.dayCount).toBe(31)
    expect(window.exclusiveEnd.toISOString()).toBe('2026-04-01T00:00:00.000Z')
  })

  it.concurrent('keeps trailing 30 days when not using billing period', () => {
    const now = new Date('2026-03-31T15:00:00.000Z')
    const billingStart = new Date('2026-03-01T00:00:00.000Z')
    const window = resolveDashboardDailySeriesWindow(false, billingStart, now)

    expect(window.seriesStart.toISOString()).toBe('2026-03-02T00:00:00.000Z')
    expect(window.dayCount).toBe(30)
  })
})
