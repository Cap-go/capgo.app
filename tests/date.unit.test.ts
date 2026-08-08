import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatLocalDate,
  formatLocalDateShort,
  formatLocalDateTime,
  formatLocalDateTimeWithSeconds,
  formatLocalMonthYear,
  formatLocalTime,
  formatUtcDateParam,
  formatUtcDateTimeAsLocal,
  generateChartDayLabels,
  generateMonthDays,
  getChartDateRange,
  getDateLocale,
  getUtcDayBounds,
  normalizeToUtcStartOfDay,
  resolveDateLocale,
  utcCalendarDayAsLocalDate,
} from '../src/services/date'
import { useMainStore } from '../src/stores/main'

function setAccountFormatLocale(formatLocale: string) {
  setActivePinia(createPinia())
  const main = useMainStore()
  main.user = { format_locale: formatLocale } as typeof main.user
}

describe('date helpers', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('uses day/month/year when no account format is selected', () => {
    const date = new Date(2026, 6, 13)

    expect(getDateLocale()).toBe('en-GB')
    expect(formatLocalDate(date)).toBe(new Intl.DateTimeFormat('en-GB').format(date))
    expect(formatLocalDate(date)).not.toBe(new Intl.DateTimeFormat('en-US').format(date))
  })

  it('resolves explicit account date conventions before fallback', () => {
    expect(resolveDateLocale('en-US')).toBe('en-US')
    expect(resolveDateLocale('fr-FR')).toBe('fr-FR')
    expect(resolveDateLocale('not-a-locale')).toBe('en-GB')
  })

  it('treats zone-less UTC stats timestamps as UTC before local formatting', () => {
    const expected = formatLocalDateTime(new Date('2026-04-22T20:22:00Z'))

    expect(formatUtcDateTimeAsLocal('2026-04-22T20:22:00')).toBe(expected)
    expect(formatUtcDateTimeAsLocal('2026-04-22T20:22:00Z')).toBe(expected)
  })

  it('keeps local date-time formatting consistent for zone-less UTC inputs', () => {
    expect(formatLocalDateTime('2026-04-22T20:22:00')).toBe(formatLocalDateTime('2026-04-22T20:22:00Z'))
  })

  it('keeps date-only inputs on the same calendar day', () => {
    const expected = formatLocalDate(new Date(2026, 3, 22))

    expect(formatLocalDate('2026-04-22')).toBe(expected)
  })

  it('returns an empty string for invalid UTC timestamp inputs', () => {
    expect(formatUtcDateTimeAsLocal('not-a-date')).toBe('')
    expect(formatLocalDate('2026-02-31')).toBe('')
  })

  it('returns an empty string for invalid local time inputs', () => {
    expect(formatLocalTime('not-a-date')).toBe('')
    expect(formatLocalTime(null)).toBe('')
    expect(formatLocalDateTimeWithSeconds('not-a-date')).toBe('')
    expect(formatLocalDateTimeWithSeconds(undefined)).toBe('')
  })

  it('formats month buckets with localized month names', () => {
    const date = new Date('2026-04-15T12:00:00Z')
    const expected = new Intl.DateTimeFormat(getDateLocale(), { month: 'short', year: 'numeric' }).format(date)

    expect(formatLocalMonthYear(date)).toBe(expected)
  })

  it('formats local time and date-time seconds from the account convention', () => {
    const date = new Date('2026-04-22T20:22:15Z')

    setAccountFormatLocale('fr-FR')
    expect(formatLocalTime(date)).toBe(new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', minute: '2-digit' }).format(date))
    expect(formatLocalDateTimeWithSeconds(date)).toBe(new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' }).format(date))

    setAccountFormatLocale('en-US')
    expect(formatLocalTime(date)).toBe(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(date))
    expect(formatLocalDateTimeWithSeconds(date)).toBe(new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium' }).format(date))
  })

  it('generates localized labels for chart date ranges', () => {
    const startDate = new Date(Date.UTC(2026, 0, 31))
    const endDate = new Date(Date.UTC(2026, 1, 2))

    expect(generateChartDayLabels(true, startDate, endDate)).toEqual([
      formatLocalDateShort(utcCalendarDayAsLocalDate(startDate)),
      formatLocalDateShort(utcCalendarDayAsLocalDate(new Date(Date.UTC(2026, 1, 1)))),
      formatLocalDateShort(utcCalendarDayAsLocalDate(endDate)),
    ])
  })

  it('generates localized labels for billing-cycle charts', () => {
    const cycleStart = new Date(Date.UTC(2026, 2, 30))
    const cycleEnd = new Date(Date.UTC(2026, 3, 1))

    expect(generateMonthDays(true, cycleStart, cycleEnd)).toEqual([
      formatLocalDateShort(utcCalendarDayAsLocalDate(cycleStart)),
      formatLocalDateShort(utcCalendarDayAsLocalDate(new Date(Date.UTC(2026, 2, 31)))),
      formatLocalDateShort(utcCalendarDayAsLocalDate(cycleEnd)),
    ])
  })

  it('formats UTC date params without shifting for local midnight east of UTC', () => {
    // Europe-like: local Aug 7 00:00 is still Aug 6 in UTC for positive offsets.
    // formatUtcDateParam must use the instant's UTC calendar day, not local→ISO.
    const europeLocalMidnight = new Date('2026-08-06T22:00:00.000Z') // CEST Aug 7 00:00
    expect(formatUtcDateParam(europeLocalMidnight)).toBe('2026-08-06')

    const utcMidnight = new Date('2026-08-07T00:00:00.000Z')
    expect(formatUtcDateParam(utcMidnight)).toBe('2026-08-07')
    expect(formatUtcDateParam(normalizeToUtcStartOfDay(europeLocalMidnight))).toBe('2026-08-06')
  })

  it('builds last-30-days chart ranges on UTC midnight boundaries', () => {
    const range = getChartDateRange(false)
    expect(range.endDate.getUTCHours()).toBe(0)
    expect(range.endDate.getUTCMinutes()).toBe(0)
    expect(range.startDate.getUTCHours()).toBe(0)
    expect(formatUtcDateParam(range.endDate)).toBe(formatUtcDateParam(normalizeToUtcStartOfDay(new Date())))
    const daySpan = Math.round((range.endDate.getTime() - range.startDate.getTime()) / (24 * 60 * 60 * 1000))
    expect(daySpan).toBe(29)
  })

  it('keeps formatUtcDateParam stable for date-only strings', () => {
    expect(formatUtcDateParam('2026-08-07')).toBe('2026-08-07')
  })

  it('treats zone-less ISO datetimes as UTC in formatUtcDateParam', () => {
    expect(formatUtcDateParam('2026-08-07T15:30:00')).toBe('2026-08-07')
  })

  it('parses date-only billing boundaries as UTC days in getChartDateRange', () => {
    const range = getChartDateRange(true, '2026-08-07', '2026-09-07')
    expect(formatUtcDateParam(range.startDate)).toBe('2026-08-07')
    expect(formatUtcDateParam(range.endDate)).toBe('2026-09-07')
    expect(range.startDate.toISOString()).toBe('2026-08-07T00:00:00.000Z')
  })

  it('builds UTC day bounds for log navigation without local shift', () => {
    const selected = new Date('2026-08-07T00:00:00.000Z')
    const { start, end } = getUtcDayBounds(selected)
    expect(start.toISOString()).toBe('2026-08-07T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-08-07T23:59:59.999Z')
  })
})
