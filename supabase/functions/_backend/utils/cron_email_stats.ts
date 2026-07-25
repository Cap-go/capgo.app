export interface WeeklyInstallStatsInput {
  all_updates: number | string | null | undefined
  failed_updates: number | string | null | undefined
  open_app?: number | string | null | undefined
}

export interface WeeklyInstallStatsResult {
  successfulInstalls: number
  failedUpdates: number
  totalUpdates: number
  successPercentage: number
  failureRate: number
  openApp: number
}

export interface VersionInstallRow {
  version_name?: string | null
  install?: number | string | null
}

/** Coerce analytics/SQL numeric fields that may arrive as strings. */
export function toStatNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Weekly email stats.
 * `daily_version.install` and `daily_version.fail` are independent action counters,
 * so success/failure rates must use install / (install + fail), never install - fail.
 */
export function computeWeeklyInstallStats(input: WeeklyInstallStatsInput): WeeklyInstallStatsResult {
  const successfulInstalls = Math.max(0, Math.round(toStatNumber(input.all_updates)))
  const failedUpdates = Math.max(0, Math.round(toStatNumber(input.failed_updates)))
  const totalUpdates = successfulInstalls + failedUpdates
  const openApp = Math.max(0, Math.round(toStatNumber(input.open_app)))

  if (totalUpdates === 0) {
    return {
      successfulInstalls,
      failedUpdates,
      totalUpdates,
      successPercentage: 0,
      failureRate: 0,
      openApp,
    }
  }

  const successPercentage = Math.round((successfulInstalls / totalUpdates) * 10_000) / 10_000
  const failureRate = Math.round((failedUpdates / totalUpdates) * 10_000) / 10_000

  return {
    successfulInstalls,
    failedUpdates,
    totalUpdates,
    successPercentage,
    failureRate,
    openApp,
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

export function sumVersionInstalls(
  versionStats: VersionInstallRow[],
  versionName?: string | null,
  versionId?: number | null,
): number {
  const versionIdStr = versionId != null ? String(versionId) : null
  return versionStats
    .filter(row => row.version_name === versionName || (versionIdStr != null && row.version_name === versionIdStr))
    .reduce((sum, row) => sum + toStatNumber(row.install), 0)
}

/** Keep retrying 24h deploy emails while analytics may still be catching up. */
export function shouldRetryDeployInstallStats(deployedAt: Date, now: Date = new Date(), retryWindowMs = 48 * 60 * 60 * 1000): boolean {
  if (Number.isNaN(deployedAt.getTime()))
    return false
  return (now.getTime() - deployedAt.getTime()) < retryWindowMs
}
