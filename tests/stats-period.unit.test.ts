import { describe, expect, it } from 'vitest'
import { parsePeriodDays } from '../src/composables/usePeriodDaysQuery.ts'
import { generateUtcDateLabels, getRollingStatsPeriod } from '../supabase/functions/_backend/utils/statsPeriod.ts'

describe('rolling stats period', () => {
  it.concurrent('uses last 24 hours and two UTC day labels for 1 day', () => {
    const period = getRollingStatsPeriod(1, new Date('2026-08-16T18:13:00.000Z'))
    expect(period.start).toBe('2026-08-15T18:13:00.000Z')
    expect(period.endExclusive).toBe('2026-08-16T18:13:00.000Z')
    expect(period.endInclusive).toBe('2026-08-16T18:12:59.999Z')
    expect(period.labels).toEqual(['2026-08-15', '2026-08-16'])
  })

  it.concurrent('keeps two labels at UTC midnight for 1 day', () => {
    const period = getRollingStatsPeriod(1, new Date('2026-08-16T00:00:00.000Z'))
    expect(period.start).toBe('2026-08-15T00:00:00.000Z')
    expect(period.endExclusive).toBe('2026-08-16T00:00:00.000Z')
    expect(period.labels).toEqual(['2026-08-15', '2026-08-16'])
  })

  it.concurrent('keeps inclusive UTC calendar days for 7 days', () => {
    const period = getRollingStatsPeriod(7, new Date('2026-08-16T18:13:00.000Z'))
    expect(period.start).toBe('2026-08-10T00:00:00.000Z')
    expect(period.endExclusive).toBe('2026-08-17T00:00:00.000Z')
    expect(period.labels).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ])
  })

  it.concurrent('generates inclusive UTC day labels', () => {
    expect(generateUtcDateLabels(
      new Date('2026-07-01T18:00:00Z'),
      new Date('2026-07-03T02:00:00Z'),
    )).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })
})

describe('period days query parsing', () => {
  it.concurrent('accepts supported presets', () => {
    expect(parsePeriodDays('1')).toBe(1)
    expect(parsePeriodDays('3')).toBe(3)
    expect(parsePeriodDays('7')).toBe(7)
    expect(parsePeriodDays('30')).toBe(30)
    expect(parsePeriodDays(['7'])).toBe(7)
  })

  it.concurrent('rejects unsupported values', () => {
    expect(parsePeriodDays(undefined)).toBeNull()
    expect(parsePeriodDays('2')).toBeNull()
    expect(parsePeriodDays('0')).toBeNull()
    expect(parsePeriodDays('nope')).toBeNull()
  })
})
