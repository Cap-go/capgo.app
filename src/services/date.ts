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

export function normalizeToStartOfDay(date: Date) {
  const normalized = new Date(date)
  normalized.setHours(0, 0, 0, 0)
  return normalized
}

function getDatesInRange(startDate: Date, endDate: Date) {
  const dates = []
  const currentDate = normalizeToStartOfDay(startDate)
  const normalizedEndDate = normalizeToStartOfDay(endDate)

  while (currentDate.getTime() <= normalizedEndDate.getTime()) {
    dates.push(new Date(currentDate))
    currentDate.setDate(currentDate.getDate() + 1)
  }

  return dates
}

export function getChartDateRange(useBillingPeriod: boolean, billingStart?: Date | string | null, billingEnd?: Date | string | null) {
  if (useBillingPeriod) {
    const startDate = parseDatePreservingUtc(billingStart) ?? new Date()
    const endDate = parseDatePreservingUtc(billingEnd) ?? new Date()
    startDate.setHours(0, 0, 0, 0)
    endDate.setHours(0, 0, 0, 0)
    return { startDate, endDate }
  }

  const endDate = normalizeToStartOfDay(new Date())
  const startDate = new Date(endDate)
  startDate.setDate(startDate.getDate() - 29)
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
