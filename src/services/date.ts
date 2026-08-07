import { i18n } from '~/modules/i18n'
import { getFormatLocale, resolveFormatLocale } from '~/services/formatLocale'

const ZONELESS_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDatePreservingUtc(date: Date | string | undefined | null): Date | null {
  if (!date)
    return null

  if (date instanceof Date)
    return Number.isNaN(date.getTime()) ? null : date

  const dateOnlyMatch = DATE_ONLY_RE.exec(date)
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch
    const parsedYear = Number(year)
    const parsedMonth = Number(month)
    const parsedDay = Number(day)
    const parsed = new Date(parsedYear, parsedMonth - 1, parsedDay)
    if (
      Number.isNaN(parsed.getTime())
      || parsed.getFullYear() !== parsedYear
      || parsed.getMonth() !== parsedMonth - 1
      || parsed.getDate() !== parsedDay
    ) {
      return null
    }
    return parsed
  }

  const normalized = ZONELESS_ISO_DATETIME_RE.test(date) ? `${date}Z` : date
  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function resolveDateLocale(formatLocale?: string | null): string {
  return resolveFormatLocale(formatLocale)
}

export function getDateLocale(): string {
  return getFormatLocale()
}
/**
 * Format a date using the account date and number convention.
 */
export function formatLocalDate(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleDateString(getDateLocale())
}

/**
 * Format a date with month name and day using the account date and number convention.
 */
export function formatLocalDateLong(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleDateString(getDateLocale(), { month: 'long', day: 'numeric' })
}

/**
 * Format a compact date for dense chart axes using the account date and number convention.
 */
export function formatLocalDateShort(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleDateString(getDateLocale(), { month: 'short', day: 'numeric' })
}

/**
 * Format a time using the account date and number convention.
 */
export function formatLocalTime(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleTimeString(getDateLocale(), { hour: 'numeric', minute: '2-digit' })
}

/**
 * Format a month/year bucket using the account date and number convention.
 */
export function formatLocalMonthYear(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleDateString(getDateLocale(), { month: 'short', year: 'numeric' })
}

/**
 * Format a date/time using the account date and number convention.
 */
export function formatLocalDateTime(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleString(getDateLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Format a date/time with seconds using the account date and number convention.
 */
export function formatLocalDateTimeWithSeconds(date: Date | string | undefined | null): string {
  const d = parseDatePreservingUtc(date)
  if (!d)
    return ''
  return d.toLocaleString(getDateLocale(), { dateStyle: 'medium', timeStyle: 'medium' })
}

export function formatUtcDateTimeAsLocal(date: Date | string | undefined | null): string {
  return formatLocalDateTime(date)
}

export function formatDate(date: string | undefined) {
  return formatLocalDateTime(date)
}

export function getDaysInCurrentMonth() {
  const date = new Date()

  return new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0,
  ).getDate()
}

export function getCurrentDayMonth() {
  const date = new Date()

  return date.getDate()
}

/**
 * Start of the UTC calendar day.
 * Dashboard daily stats (daily_mau, daily_version, CF Analytics) are bucketed in UTC,
 * so chart ranges and API date params must use UTC day boundaries — not the browser's local midnight.
 */
export function normalizeToUtcStartOfDay(date: Date = new Date()) {
  const normalized = new Date(date)
  normalized.setUTCHours(0, 0, 0, 0)
  return normalized
}

export function addUtcDays(date: Date, days: number) {
  const next = new Date(date)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/**
 * YYYY-MM-DD for API / DB date filters using the UTC calendar day.
 * Never derive this from local midnight via toISOString() — that shifts the day for viewers east of UTC.
 */
export function formatUtcDateParam(date: Date | string = new Date()) {
  const parsed = typeof date === 'string'
    ? (DATE_ONLY_RE.test(date) ? new Date(`${date}T00:00:00.000Z`) : new Date(date))
    : new Date(date)
  if (Number.isNaN(parsed.getTime()))
    return ''
  return parsed.toISOString().slice(0, 10)
}

/** Local Date with the same Y-M-D as the UTC calendar day (for localized chart labels). */
export function utcCalendarDayAsLocalDate(date: Date) {
  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function getDatesInRange(startDate: Date, endDate: Date) {
  const dates = []
  const currentDate = normalizeToUtcStartOfDay(startDate)
  const normalizedEndDate = normalizeToUtcStartOfDay(endDate)

  while (currentDate.getTime() <= normalizedEndDate.getTime()) {
    dates.push(utcCalendarDayAsLocalDate(currentDate))
    currentDate.setUTCDate(currentDate.getUTCDate() + 1)
  }

  return dates
}

export function getChartDateRange(useBillingPeriod: boolean, billingStart?: Date | string | null, billingEnd?: Date | string | null) {
  if (useBillingPeriod) {
    const startDate = normalizeToUtcStartOfDay(parseDatePreservingUtc(billingStart) ?? new Date())
    const endDate = normalizeToUtcStartOfDay(parseDatePreservingUtc(billingEnd) ?? new Date())
    return { startDate, endDate }
  }

  const endDate = normalizeToUtcStartOfDay(new Date())
  const startDate = addUtcDays(endDate, -29)
  return { startDate, endDate }
}

export function generateChartDayLabels(useBillingPeriod: boolean, startDate: Date, endDate: Date) {
  const { startDate: rangeStart, endDate: rangeEnd } = useBillingPeriod
    ? { startDate, endDate }
    : getChartDateRange(false)

  return getDatesInRange(rangeStart, rangeEnd).map(formatLocalDateShort)
}

export function generateMonthDays(useBillingPeriod: boolean, cycleStart: Date, cycleEnd: Date) {
  const { startDate, endDate } = useBillingPeriod
    ? { startDate: cycleStart, endDate: cycleEnd }
    : getChartDateRange(false)

  return getDatesInRange(startDate, endDate).map(formatLocalDateShort)
}

/**
 * Format a date as a relative time string (e.g., "2 hours ago", "3 days ago")
 */
export function formatDistanceToNow(date: Date | string | undefined | null): string {
  if (!date)
    return ''
  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime()))
    return ''

  const now = new Date()
  const diffInMs = now.getTime() - d.getTime()
  const diffInSeconds = Math.floor(diffInMs / 1000)
  const diffInMinutes = Math.floor(diffInSeconds / 60)
  const diffInHours = Math.floor(diffInMinutes / 60)
  const diffInDays = Math.floor(diffInHours / 24)

  if (diffInSeconds < 60) {
    return i18n.global.t('just-now')
  }
  else if (diffInMinutes < 60) {
    return i18n.global.t('minutes-ago', { count: diffInMinutes })
  }
  else if (diffInHours < 24) {
    return i18n.global.t('hours-ago', { count: diffInHours })
  }
  else if (diffInDays < 30) {
    return i18n.global.t('days-ago', { count: diffInDays })
  }
  else {
    return formatLocalDate(d)
  }
}
