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

export interface WeeklyEmailMetadata {
  [key: string]: unknown
  app_id: string
  month_name: string
  week_number: string
  weekly_updates: string
  fun_comparison: string
  weekly_install: string
  weekly_install_success: string
  fun_comparison_2: string
  weekly_fail: string
  weekly_open: string
  fun_comparison_3: string
}

const thresholds = {
  updates: [100, 1000, 10000],
  // Inclusive upper bounds for non-zero fail bands.
  // 0 < rate <= 0.10 → under/about one in ten
  // 0.10 < rate <= 0.20 → about one in five
  // rate > 0.20 → nearly a third / worse
  failRate: [0.10, 0.20],
  appOpen: [500, 1500, 5000],
}

const funComparisons = {
  updates: [
    'a cupcake to every student in a small school!',
    'a pizza to every resident of a small town!',
    'a burger to everyone in a big city!',
  ],
  failRate: [
    'Flawless streak—no failed updates this week! 🏅',
    'About one in ten updates failed; looking solid overall.',
    'About one in five updates failed; let\'s squash those errors.',
    'Heads up: nearly a third of updates are failing—worth a closer look.',
  ],
  appOpen: [
    'Your app was opened more times than a popular local bakery\'s door!',
    'Your app was more popular than the latest episode of a hit TV show!',
    'Your app was opened more times than a blockbuster movie on its opening weekend!',
  ],
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
 * This matches admin success_rate: installs / (installs + fails).
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

export function getThresholdFunComparison(
  comparison: 'updates' | 'appOpen',
  stat: number,
): string {
  const bands = thresholds[comparison]
  let chosenIndex = 0
  for (let i = bands.length - 1; i >= 0; i -= 1) {
    if (stat >= bands[i]) {
      chosenIndex = i
      break
    }
  }
  const text = funComparisons[comparison][chosenIndex]
  if (!text)
    throw new Error(`Cannot find index for fun comparison, ${chosenIndex}`)
  return text
}

/**
 * Flawless copy is reserved for zero failures only.
 * Do not use rounded failureRate === 0, or large weeks with 1 fail look "flawless".
 */
export function getFailRateFunComparison(failedUpdates: number, failureRate: number): string {
  if (failedUpdates <= 0)
    return funComparisons.failRate[0]

  if (failureRate <= thresholds.failRate[0])
    return funComparisons.failRate[1]
  if (failureRate <= thresholds.failRate[1])
    return funComparisons.failRate[2]
  return funComparisons.failRate[3]
}

/** ISO-8601 week number (UTC). */
export function getIsoWeekNumber(now: Date = new Date()): number {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  // ISO weeks start on Monday; the Thursday of this week determines the ISO week year/number.
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
}

export function buildWeeklyEmailMetadata(
  appId: string,
  stats: WeeklyInstallStatsResult,
  now: Date = new Date(),
): WeeklyEmailMetadata {
  return {
    app_id: appId,
    month_name: now.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }),
    week_number: getIsoWeekNumber(now).toString(),
    weekly_updates: stats.totalUpdates.toString(),
    fun_comparison: getThresholdFunComparison('updates', stats.totalUpdates),
    weekly_install: stats.successfulInstalls.toString(),
    weekly_install_success: (stats.successPercentage * 100).toString(),
    fun_comparison_2: getFailRateFunComparison(stats.failedUpdates, stats.failureRate),
    weekly_fail: stats.failedUpdates.toString(),
    weekly_open: stats.openApp.toString(),
    fun_comparison_3: getThresholdFunComparison('appOpen', stats.openApp),
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
    .reduce((sum, row) => sum + toStatNumber(row.install), 0)
}

/** Keep retrying 24h deploy emails while analytics may still be catching up. */
export function shouldRetryDeployInstallStats(deployedAt: Date, now: Date = new Date(), retryWindowMs = 48 * 60 * 60 * 1000): boolean {
  if (Number.isNaN(deployedAt.getTime()))
    return false
  const elapsedMs = now.getTime() - deployedAt.getTime()
  return elapsedMs >= 0 && elapsedMs < retryWindowMs
}

export function shouldSendDeployInstallStatsEmail(installs: number): boolean {
  return installs > 1
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
): DeviceVersionAdoptionSummary {
  const totalDevices = Object.values(counts).reduce((sum, value) => {
    return sum + Math.max(0, Math.round(toStatNumber(value)))
  }, 0)
  const deviceCount = versionName
    ? Math.max(0, Math.round(toStatNumber(counts[versionName] ?? 0)))
    : 0
  const adoptionPercent = totalDevices > 0
    ? (Math.round((deviceCount / totalDevices) * 1000) / 10).toFixed(1)
    : '0.0'

  return {
    device_count: deviceCount,
    total_devices: totalDevices,
    adoption_percent: adoptionPercent,
  }
}
