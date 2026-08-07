/**
 * Optimized chart data processing utilities
 */

import { addUtcDays, normalizeToUtcStartOfDay } from '~/services/date'

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
  arr[index] = (arr[index] === undefined ? 0 : arr[index]) + increment
}

/**
 * Remap a fixed 30-day UTC series onto the current billing cycle length.
 * Days are indexed from last30DaysStart (UTC midnight).
 */
export function filterDailySeriesToBillingPeriod(fullData: number[], last30DaysStart: Date, billingStart: Date) {
  const currentDate = normalizeToUtcStartOfDay()

  let currentBillingDay: number
  if (billingStart.getUTCDate() === 1) {
    currentBillingDay = currentDate.getUTCDate()
  }
  else {
    const billingStartDay = billingStart.getUTCDate()
    const daysInMonth = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() + 1, 0)).getUTCDate()
    currentBillingDay = (currentDate.getUTCDate() - billingStartDay + 1 + daysInMonth) % daysInMonth
    if (currentBillingDay === 0)
      currentBillingDay = daysInMonth
  }

  const billingData = Array.from({ length: currentBillingDay }).fill(0) as number[]
  for (let i = 0; i < 30; i++) {
    const dataDate = addUtcDays(last30DaysStart, i)
    if (dataDate >= billingStart && dataDate <= currentDate) {
      const billingIndex = Math.floor((dataDate.getTime() - billingStart.getTime()) / (1000 * 60 * 60 * 24))
      if (billingIndex >= 0 && billingIndex < currentBillingDay)
        billingData[billingIndex] = fullData[i]
    }
  }

  return { data: billingData }
}
