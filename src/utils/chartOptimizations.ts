/**
 * Optimized chart data processing utilities
 */

import { addUtcDays, normalizeToUtcStartOfDay } from '~/services/date'

const DAY_MS = 1000 * 60 * 60 * 24

/**
 * Fast array initialization with undefined values
 */
export function createUndefinedArray(length: number): (number | undefined)[] {
  const arr: (number | undefined)[] = Array.from({ length })
  // Don't fill with undefined - Array.from already does this
  return arr
}

/**
 * Optimized array increment with undefined handling
 */
export function incrementArrayValue(arr: (number | undefined)[], index: number, increment: number): void {
  arr[index] = (arr[index] ?? 0) + increment
}

export interface DashboardDailySeriesWindow {
  /** Inclusive UTC midnight of the first fetched/bucketed day */
  seriesStart: Date
  /** UTC midnight of today */
  todayUtc: Date
  /** Exclusive upper bound (next UTC midnight) for timestamp queries */
  exclusiveEnd: Date
  dayCount: number
}

/**
 * Fetch/render window for dashboard daily series.
 * Billing mode starts at the cycle anchor so 31-day cycles keep day 1.
 */
export function resolveDashboardDailySeriesWindow(
  useBillingPeriod: boolean,
  billingStart: Date,
  now: Date = new Date(),
): DashboardDailySeriesWindow {
  const todayUtc = normalizeToUtcStartOfDay(now)
  const exclusiveEnd = addUtcDays(todayUtc, 1)
  let seriesStart = addUtcDays(todayUtc, -29)
  const cycleStart = normalizeToUtcStartOfDay(billingStart)

  if (useBillingPeriod && !Number.isNaN(cycleStart.getTime())) {
    const elapsedDays = Math.floor((todayUtc.getTime() - cycleStart.getTime()) / DAY_MS)
    if (elapsedDays >= 0 && elapsedDays <= 366)
      seriesStart = cycleStart
  }

  const dayCount = Math.max(Math.floor((todayUtc.getTime() - seriesStart.getTime()) / DAY_MS) + 1, 1)
  return { seriesStart, todayUtc, exclusiveEnd, dayCount }
}

/**
 * Remap a trailing UTC daily series onto the current billing cycle length.
 * Days are indexed from seriesStart (UTC midnight).
 */
export function filterDailySeriesToBillingPeriod(fullData: number[], seriesStart: Date, billingStart: Date) {
  const currentDate = normalizeToUtcStartOfDay()
  const cycleStart = normalizeToUtcStartOfDay(billingStart)

  if (Number.isNaN(cycleStart.getTime()) || cycleStart.getTime() > currentDate.getTime())
    return { data: [] as number[] }

  const currentBillingDay = Math.floor((currentDate.getTime() - cycleStart.getTime()) / DAY_MS) + 1
  const billingData = Array.from({ length: currentBillingDay }).fill(0) as number[]
  const windowStart = normalizeToUtcStartOfDay(seriesStart)

  for (let i = 0; i < fullData.length; i++) {
    const dataDate = addUtcDays(windowStart, i)
    if (dataDate.getTime() < cycleStart.getTime() || dataDate.getTime() > currentDate.getTime())
      continue
    const billingIndex = Math.floor((dataDate.getTime() - cycleStart.getTime()) / DAY_MS)
    if (billingIndex >= 0 && billingIndex < currentBillingDay)
      billingData[billingIndex] = fullData[i] ?? 0
  }

  return { data: billingData }
}
