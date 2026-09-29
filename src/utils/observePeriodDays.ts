import type { PeriodDayOption } from '~/utils/periodDays'

/** Smallest supported rollup window (1, 3, 7, 30 days) that fully covers the selected range. */
export function legacyStatsDaysFromRange(start: Date, end: Date): PeriodDayOption {
  const ms = Math.max(0, end.getTime() - start.getTime())
  const hours = ms / (60 * 60 * 1000)
  if (hours <= 36)
    return 1
  if (hours <= 3.5 * 24)
    return 3
  if (hours <= 7.5 * 24)
    return 7
  return 30
}
