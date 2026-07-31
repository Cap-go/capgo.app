import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  formatLocalDate,
  formatLocalDateShort,
  formatLocalDateTime,
  formatLocalDateTimeWithSeconds,
  formatLocalMonthYear,
  formatLocalTime,
  formatUtcDateTimeAsLocal,
  generateChartDayLabels,
  generateMonthDays,
  getDateLocale,
  resolveDateLocale,
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
    const startDate = new Date(2026, 0, 31)
    const endDate = new Date(2026, 1, 2)

    expect(generateChartDayLabels(true, startDate, endDate)).toEqual([
      formatLocalDateShort(startDate),
      formatLocalDateShort(new Date(2026, 1, 1)),
      formatLocalDateShort(endDate),
    ])
  })

  it('generates localized labels for billing-cycle charts', () => {
    const cycleStart = new Date(2026, 2, 30)
    const cycleEnd = new Date(2026, 3, 1)

    expect(generateMonthDays(true, cycleStart, cycleEnd)).toEqual([
      formatLocalDateShort(cycleStart),
      formatLocalDateShort(new Date(2026, 2, 31)),
      formatLocalDateShort(cycleEnd),
    ])
  })
})
