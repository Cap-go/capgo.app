import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatDateCF, getLastMonthAnalyticsWindow, getLastMonthAnalyticsWindowStart } from '../supabase/functions/_backend/utils/cloudflare.ts'

describe('formatDateCF', () => {
  it.concurrent('normalizes Date objects to a stable UTC SQL timestamp', () => {
    expect(formatDateCF(new Date('2026-03-17T09:08:07.654Z'))).toBe('2026-03-17 09:08:07')
  })

  it.concurrent('normalizes ISO strings with offsets to UTC SQL timestamps', () => {
    expect(formatDateCF('2026-03-17T10:08:07+01:00')).toBe('2026-03-17 09:08:07')
  })
})

describe('getLastMonthAnalyticsWindow', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.concurrent('builds deterministic rolling analytics bounds from a snapshot end date', () => {
    expect(getLastMonthAnalyticsWindow(new Date('2026-03-25T00:00:00.000Z'))).toEqual({
      startExpression: "toDateTime('2026-02-23 00:00:00')",
      endExpression: "toDateTime('2026-03-25 00:00:00')",
    })
  })

  it.concurrent('exposes the rolling analytics start for matching database fallbacks', () => {
    expect(getLastMonthAnalyticsWindowStart(new Date('2026-03-25T00:00:00.000Z')).toISOString()).toBe('2026-02-23T00:00:00.000Z')
  })

  it('preserves time-of-day for the default rolling analytics lower bound', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-25T12:34:56.789Z').getTime())

    expect(getLastMonthAnalyticsWindow()).toEqual({
      startExpression: "toDateTime('2026-02-23 12:34:56')",
      endExpression: 'now()',
    })
  })
})
