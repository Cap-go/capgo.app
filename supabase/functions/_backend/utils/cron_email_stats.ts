export interface WeeklyInstallStatsInput {
  all_updates: number | string | null | undefined
  failed_updates: number | string | null | undefined
  update_checks: number | string | null | undefined
}

export interface WeeklyInstallStatsResult {
  successfulInstalls: number
  failedUpdates: number
  updateChecks: number
}

export interface VersionInstallRow {
  version_name?: string | null
  install?: number | string | null
}

/** Coerce optional analytics fields used outside the weekly report. */
export function toStatNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** SQL aggregates must be present and valid; missing data is not zero activity. */
function weeklyCount(value: WeeklyInstallStatsInput['all_updates']): number {
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^\d+$/.test(value)))
    throw new Error('Missing or malformed weekly event count')
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error('Invalid weekly event count')
  return count
}

/** Independent event counters, not app opens, unique devices or release outcomes. */
export function computeWeeklyInstallStats(input: WeeklyInstallStatsInput): WeeklyInstallStatsResult {
  return {
    successfulInstalls: weeklyCount(input.all_updates),
    failedUpdates: weeklyCount(input.failed_updates),
    updateChecks: weeklyCount(input.update_checks),
  }
}

/** Seven completed UTC days, excluding today's partial aggregate. */
export function getWeeklyReportRange(now: Date = new Date()): { start: string, end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const start = new Date(end.getTime() - 7 * 86_400_000)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

// The (app_id, date) index bounds this scan to one app and seven daily buckets.
// Keep the legacy get_weekly_stats RPC intact for existing callers.
export const WEEKLY_REPORT_SQL = `SELECT
  COALESCE(SUM(install), 0) AS all_updates,
  COALESCE(SUM(fail), 0) AS failed_updates,
  COALESCE(SUM(get), 0) AS update_checks
FROM public.daily_version
WHERE app_id = $1 AND date >= $2::date AND date < $3::date`

export function buildWeeklyEmailMetadata(
  appId: string,
  stats: WeeklyInstallStatsResult,
  range: { start: string, end: string },
) {
  return {
    app_id: appId,
    report_schema_version: '2',
    window_start: range.start,
    window_end: range.end,
    weekly_install: stats.successfulInstalls.toString(),
    weekly_install_formatted: stats.successfulInstalls.toLocaleString('en-US'),
    weekly_fail: stats.failedUpdates.toString(),
    weekly_fail_formatted: stats.failedUpdates.toLocaleString('en-US'),
    weekly_update_checks: stats.updateChecks.toString(),
    weekly_update_checks_formatted: stats.updateChecks.toLocaleString('en-US'),
  }
}

/** Previous calendar month as an inclusive UTC start / exclusive UTC end. */
export function getPreviousMonthUtcRange(now: Date = new Date()): { startIso: string, endExclusiveIso: string, monthName: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0, 0))
  const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
  const monthName = start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })
  return {
    startIso: start.toISOString(),
    endExclusiveIso: endExclusive.toISOString(),
    monthName,
  }
}

/** Count whether an ISO timestamp falls in the previous-month email window. */
export function isInPreviousMonthRange(isoTimestamp: string, now: Date = new Date()): boolean {
  const { startIso, endExclusiveIso } = getPreviousMonthUtcRange(now)
  return isoTimestamp >= startIso && isoTimestamp < endExclusiveIso
}

export function sumVersionInstalls(
  versionStats: VersionInstallRow[],
  versionName?: string | null,
  versionId?: number | null,
): number {
  const hasVersionName = typeof versionName === 'string' && versionName.length > 0
  const versionIdStr = versionId != null ? String(versionId) : null
  return versionStats
    .filter((row) => {
      if (hasVersionName && row.version_name === versionName)
        return true
      // Legacy Analytics Engine rows stored numeric version_id in blob2.
      if (versionIdStr != null && row.version_name === versionIdStr)
        return true
      return false
    })
    .reduce((sum, row) => {
      const value = row.install
      if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value.trim())))
        throw new Error('Missing or malformed install count')
      const count = Number(value)
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(sum + count))
        throw new Error('Invalid install count')
      return sum + count
    }, 0)
}

/** Keep retrying 24h deploy emails while analytics may still be catching up. */
export function shouldRetryDeployInstallStats(deployedAt: Date, now: Date = new Date(), retryWindowMs = 48 * 60 * 60 * 1000): boolean {
  if (Number.isNaN(deployedAt.getTime()))
    return false
  const elapsedMs = now.getTime() - deployedAt.getTime()
  return elapsedMs >= 0 && elapsedMs < retryWindowMs
}

export function shouldSendDeployInstallStatsEmail(installs: number): boolean {
  return Number.isSafeInteger(installs) && installs > 1
}

export interface DeviceVersionAdoptionSummary {
  device_count: number
  total_devices: number
  adoption_percent: string
}

/** Live unique-device reach for a deployed bundle from version_name counts. */
export function summarizeDeviceVersionAdoption(
  counts: Record<string, number | string | null | undefined>,
  versionName?: string | null,
  versionId?: number | null,
): DeviceVersionAdoptionSummary {
  const totalDevices = Object.values(counts).reduce<number>((sum, value) => {
    return sum + Math.max(0, Math.round(toStatNumber(value)))
  }, 0)
  const namedCount = versionName ? counts[versionName] : undefined
  const idCount = versionId != null ? counts[String(versionId)] : undefined
  const deviceCount = Math.max(0, Math.round(toStatNumber(namedCount ?? idCount ?? 0)))
  const adoptionPercent = totalDevices > 0
    ? (Math.round((deviceCount / totalDevices) * 1000) / 10).toFixed(1)
    : '0.0'

  return {
    device_count: deviceCount,
    total_devices: totalDevices,
    adoption_percent: adoptionPercent,
  }
}
