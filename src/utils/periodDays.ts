export type PeriodDayOption = 1 | 3 | 7 | 30
const PERIOD_DAY_OPTIONS: PeriodDayOption[] = [1, 3, 7, 30]
export const DEFAULT_PERIOD_DAYS: PeriodDayOption = 1

export function parsePeriodDays(value: unknown): PeriodDayOption | null {
  const raw = Array.isArray(value) ? value[0] : value
  const days = Number(raw)
  if (!PERIOD_DAY_OPTIONS.includes(days as PeriodDayOption))
    return null
  return days as PeriodDayOption
}
