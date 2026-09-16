import type { PeriodDayOption } from '~/utils/periodDays'

/** Map a wall-clock range to bundle install / delivery stats `days` (1, 3, 7, 30). */
export function legacyStatsDaysFromRange(start: Date, end: Date): PeriodDayOption {
  const ms = Math.max(0, end.getTime() - start.getTime())
  const hours = ms / (60 * 60 * 1000)
  if (hours <= 36)
    return 1
  if (hours <= 3.5 * 24)
    return 3
  if (hours <= 10 * 24)
    return 7
  return 30
}
