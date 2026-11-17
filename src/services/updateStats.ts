/** Days per get_update_daily_counts request (the RPC refuses windows over 370 days). */
export const UPDATE_STATS_MAX_WINDOW_DAYS = 366

/** Apps per get_update_daily_counts request (the RPC refuses more than 1000). */
export const UPDATE_STATS_MAX_APPS = 1000

const DAY_MS = 24 * 60 * 60 * 1000

/** Split app ids into disjoint chunks the daily update RPC accepts. */
export function splitUpdateStatsAppIds(appIds: readonly string[], maxApps = UPDATE_STATS_MAX_APPS): string[][] {
  const chunks: string[][] = []
  for (let index = 0; index < appIds.length; index += maxApps)
    chunks.push(appIds.slice(index, index + maxApps))
  return chunks
}

export interface UpdateStatsWindow {
  /** Inclusive start date, YYYY-MM-DD (UTC). */
  start: string
  /** Inclusive end date, YYYY-MM-DD (UTC). */
  end: string
}

function parseUtcDate(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`)
}

function formatUtcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

/**
 * Split an inclusive [start, end] date range into consecutive windows the
 * daily update RPC accepts. A normal billing cycle is one window; an old
 * subscription start (more than a year ago) becomes a few windows instead of
 * an error.
 */
export function splitUpdateStatsWindow(start: string, end: string, maxDays = UPDATE_STATS_MAX_WINDOW_DAYS): UpdateStatsWindow[] {
  const startTime = parseUtcDate(start)
  const endTime = parseUtcDate(end)
  if (Number.isNaN(startTime) || Number.isNaN(endTime) || endTime < startTime)
    return [{ start, end }]
  const windows: UpdateStatsWindow[] = []
  for (let cursor = startTime; cursor <= endTime; cursor += maxDays * DAY_MS) {
    const windowEnd = Math.min(cursor + (maxDays - 1) * DAY_MS, endTime)
    windows.push({ start: formatUtcDate(cursor), end: formatUtcDate(windowEnd) })
  }
  return windows
}

/** A bigint sum: a number, or a string when it is too large for JSON numbers. */
type DailyCountValue = number | string | null

export interface UpdateDailyCountRow {
  app_id: string
  date: string
  install_count: DailyCountValue
  fail_count: DailyCountValue
  get_count: DailyCountValue
}

export interface DailyVersionStat {
  app_id: string
  date: string
  install: number
  fail: number
  get: number
}

/** Map an aggregated RPC row onto the daily_version shape the chart sums. */
export function toDailyVersionStat(row: UpdateDailyCountRow): DailyVersionStat {
  return {
    app_id: row.app_id,
    date: row.date,
    install: Number(row.install_count ?? 0),
    fail: Number(row.fail_count ?? 0),
    get: Number(row.get_count ?? 0),
  }
}
