/**
 * Longest span, in days, the statistics endpoints accept between `from` and `to`.
 *
 * The console asks for the last 30 days or the current billing period, and a yearly
 * billing period is at most 366 days, so 400 days leaves room for every real caller while
 * stopping requests (e.g. 2000 → 2026) that would build thousands of daily rows per app.
 */
export const MAX_STATISTICS_RANGE_DAYS = 400

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/** Number of graph days between two dates, as the statistics endpoints count them. */
export function statisticsRangeDays(from: Date, to: Date): number {
  return Math.round(Math.abs((from.valueOf() - to.valueOf()) / ONE_DAY_MS))
}

export function isStatisticsRangeTooLarge(from: Date, to: Date): boolean {
  return statisticsRangeDays(from, to) > MAX_STATISTICS_RANGE_DAYS
}
