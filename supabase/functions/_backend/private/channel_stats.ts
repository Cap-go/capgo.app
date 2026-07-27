import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { checkPermission } from '../utils/rbac.ts'
import { readDeviceVersionCounts, readStatsVersion } from '../utils/stats.ts'
import { supabaseWithAuth } from '../utils/supabase.ts'
import { buildDailyReportedCountsByName, convertCountsToPercentagesByName, fillMissingDailyCounts } from '../utils/version_stats_helpers.ts'

dayjs.extend(utc)

interface ChannelStatsRequest {
  channel_id: number
  app_id: string
  days?: number
}

interface AppUsageByVersion {
  date: string
  app_id: string
  version_name: string
  get: number | null
  install: number | null
  uninstall: number | null
}

interface DeploymentHistoryEntry {
  version_name: string
  deployed_at: string
}

type StatsPeriodStartReason = 'requested_days' | 'current_version_release'
const supportedPeriodDays = [1, 3, 7, 30] as const
type StatsPeriodDays = typeof supportedPeriodDays[number]

function normalizeStatsPeriodDays(days: number | undefined): StatsPeriodDays | null {
  const requestedDays = days ?? 30
  if (!Number.isInteger(requestedDays) || !supportedPeriodDays.includes(requestedDays as StatsPeriodDays))
    return null

  return requestedDays as StatsPeriodDays
}

function getStatsPeriod(requestedDays: StatsPeriodDays, endDate: Date, currentVersionReleasedAt: string | null | undefined) {
  const end = dayjs(endDate).utc().startOf('day')
  const requestedStart = end.subtract(requestedDays - 1, 'day')
  let start = requestedStart
  let startReason: StatsPeriodStartReason = 'requested_days'

  if (requestedDays >= 30 && currentVersionReleasedAt) {
    const releaseStart = dayjs(currentVersionReleasedAt).utc().startOf('day')
    if (releaseStart.isValid() && releaseStart.isAfter(requestedStart) && !releaseStart.isAfter(end)) {
      start = releaseStart
      startReason = 'current_version_release'
    }
  }

  const labels = generateDateLabels(start.toDate(), end.toDate())

  return {
    startDate: start.toDate(),
    endDate,
    labels,
    requestedDays,
    actualDays: labels.length,
    startReason,
  }
}

function generateDateLabels(from: Date, to: Date) {
  const start = dayjs(from).utc().startOf('day')
  const end = dayjs(to).utc().startOf('day')

  if (start.isAfter(end))
    return [] as string[]

  const labels: string[] = []
  let cursor = start
  while (cursor.isBefore(end) || cursor.isSame(end)) {
    labels.push(cursor.format('YYYY-MM-DD'))
    cursor = cursor.add(1, 'day')
  }

  return labels
}

function trimTrailingEmptyLabels(labels: string[], countsByDate: Record<string, Record<string, number>>) {
  if (labels.length <= 1)
    return labels

  for (let index = labels.length - 1; index >= 0; index--) {
    const label = labels[index]
    const total = Object.values(countsByDate[label] ?? {}).reduce((sum, value) => sum + Math.round(value ?? 0), 0)
    if (total > 0)
      return labels.slice(0, index + 1)
  }

  return labels
}

function createPercentageDatasetsByName(
  versions: string[],
  dates: string[],
  percentagesByDate: { [date: string]: { [version: string]: number } },
  countsByDate: { [date: string]: { [version: string]: number } },
) {
  return versions.map((version) => {
    const percentageData = dates.map(date => percentagesByDate[date]?.[version] ?? 0)
    const countData = dates.map(date => Math.round(countsByDate[date]?.[version] ?? 0))

    return {
      label: version,
      data: percentageData,
      metaCounts: countData,
    }
  })
}

function selectRecentChannelVersions(
  deploymentHistory: DeploymentHistoryEntry[],
  currentVersionName: string,
  currentCounts: Record<string, number>,
  limit: number = 10,
) {
  const sortedByRecency = [...deploymentHistory]
    .sort((a, b) => dayjs(b.deployed_at).valueOf() - dayjs(a.deployed_at).valueOf())
    .map(entry => entry.version_name)

  const uniqueRecentDeployed: string[] = []
  for (const versionName of sortedByRecency) {
    if (!versionName || uniqueRecentDeployed.includes(versionName))
      continue
    uniqueRecentDeployed.push(versionName)
    if (uniqueRecentDeployed.length >= limit)
      break
  }

  if (currentVersionName && !uniqueRecentDeployed.includes(currentVersionName)) {
    uniqueRecentDeployed.unshift(currentVersionName)
    if (uniqueRecentDeployed.length > limit)
      uniqueRecentDeployed.length = limit
  }

  if (uniqueRecentDeployed.length > 0)
    return uniqueRecentDeployed

  return Object.entries(currentCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([versionName]) => versionName)
}
const otherVersionsLabel = 'Other versions'

function getDailyTotal(counts: Record<string, number> | undefined) {
  return Object.values(counts ?? {}).reduce((sum, value) => sum + Math.round(value ?? 0), 0)
}

function getUniqueVersionNames(dailyVersion: AppUsageByVersion[], currentVersionName: string) {
  const versionNames = new Set<string>()
  if (currentVersionName)
    versionNames.add(currentVersionName)

  dailyVersion.forEach((row) => {
    if (row.version_name)
      versionNames.add(row.version_name)
  })

  return [...versionNames]
}

function createChartCountsByDate(
  labels: string[],
  countsByDate: Record<string, Record<string, number>>,
  selectedVersions: string[],
  allVersions: string[],
) {
  const visibleVersions = selectedVersions.filter((version, index, versions) => version && versions.indexOf(version) === index)
  const hiddenVersions = allVersions.filter(version => !visibleVersions.includes(version))
  const hasOtherVersions = hiddenVersions.some(version => labels.some(label => (countsByDate[label]?.[version] ?? 0) > 0))
  const chartVersions = hasOtherVersions ? [...visibleVersions, otherVersionsLabel] : visibleVersions
  const chartCountsByDate: Record<string, Record<string, number>> = {}

  labels.forEach((label) => {
    chartCountsByDate[label] = {}
    visibleVersions.forEach((version) => {
      chartCountsByDate[label][version] = Math.max(0, Math.round(countsByDate[label]?.[version] ?? 0))
    })
    if (hasOtherVersions) {
      chartCountsByDate[label][otherVersionsLabel] = hiddenVersions.reduce((sum, version) => {
        return sum + Math.max(0, Math.round(countsByDate[label]?.[version] ?? 0))
      }, 0)
    }
  })

  return { versions: chartVersions, countsByDate: chartCountsByDate }
}

function getLatestCounts(labels: string[], countsByDate: Record<string, Record<string, number>>) {
  if (labels.length === 0)
    return {} as Record<string, number>

  // Prefer the latest non-zero snapshot to avoid false "no devices" when
  // the most recent day is temporarily empty due ingestion lag.
  for (let index = labels.length - 1; index >= 0; index--) {
    const label = labels[index]
    const counts = countsByDate[label] ?? {}
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
    if (total > 0)
      return counts
  }

  const latestLabel = labels[labels.length - 1]
  return countsByDate[latestLabel] ?? {}
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<ChannelStatsRequest>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post channel_stats body', body })

  if (!body.channel_id || !body.app_id) {
    throw simpleError('missing_params', 'channel_id and app_id are required')
  }
  const days = normalizeStatsPeriodDays(body.days)
  if (!days)
    throw simpleError('invalid_days', 'days must be one of 1, 3, 7, or 30')

  if (!(await checkPermission(c, 'app.read', { appId: body.app_id }))) {
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })
  }

  try {
    const auth = c.get('auth')
    if (!auth) {
      throw simpleError('not_authenticated', 'Authentication required')
    }

    const supabase = supabaseWithAuth(c, auth)

    const { data: channelData, error: channelError } = await supabase
      .from('channels')
      .select('id, name, version, version (name, created_at)')
      .eq('id', body.channel_id)
      .eq('app_id', body.app_id)
      .single()

    if (channelError || !channelData) {
      throw simpleError('channel_not_found', 'Channel not found')
    }

    const currentVersionName = (channelData.version as any)?.name ?? ''

    const endDate = dayjs().utc().endOf('day').toDate()

    const { data: deployHistory, error: deployError } = await supabase
      .from('deploy_history')
      .select('version_id, deployed_at, app_versions(name)')
      .eq('channel_id', body.channel_id)
      .eq('app_id', body.app_id)
      .order('deployed_at', { ascending: true })

    if (deployError) {
      cloudlog({ requestId: c.get('requestId'), message: 'Error fetching deploy history', error: deployError })
    }

    const deploymentHistory = (deployHistory || [])
      .map((deploy) => {
        const versionName = (deploy.app_versions as any)?.name
        if (!versionName || !deploy.deployed_at)
          return null
        return {
          version_name: versionName,
          deployed_at: dayjs(deploy.deployed_at).utc().toISOString(),
        } satisfies DeploymentHistoryEntry
      })
      .filter(Boolean) as DeploymentHistoryEntry[]

    const versionIdToName: Record<string, string> = {}

    for (const deploy of (deployHistory || [])) {
      const versionName = (deploy.app_versions as any)?.name
      const versionId = deploy.version_id
      if (versionName && versionId !== null && versionId !== undefined)
        versionIdToName[String(versionId)] = versionName
    }

    const currentVersionRelease = deploymentHistory
      .filter(entry => entry.version_name === currentVersionName)
      .sort((a, b) => dayjs(b.deployed_at).valueOf() - dayjs(a.deployed_at).valueOf())[0]
    const currentVersionCreatedAt = (channelData.version as any)?.created_at
    const currentVersionReleasedAt = currentVersionRelease?.deployed_at
      ?? (currentVersionCreatedAt ? dayjs(currentVersionCreatedAt).utc().toISOString() : null)
    const period = getStatsPeriod(days, endDate, currentVersionReleasedAt)
    const { startDate } = period
    const usageRows = await readStatsVersion(
      c,
      body.app_id,
      dayjs(startDate).utc().startOf('day').toISOString(),
      dayjs(endDate).utc().add(1, 'day').startOf('day').toISOString(),
    )

    const dailyVersion = (usageRows as unknown as AppUsageByVersion[])
      .map((row) => {
        const mapped = versionIdToName[row.version_name]
        return {
          ...row,
          version_name: mapped ?? row.version_name,
          date: dayjs(row.date).utc().format('YYYY-MM-DD'),
        }
      })
      .filter(row => row.version_name)

    const allVersionNames = getUniqueVersionNames(dailyVersion, currentVersionName)
    const rawAllCountsByDate = buildDailyReportedCountsByName(dailyVersion, period.labels, allVersionNames)
    const labels = trimTrailingEmptyLabels(period.labels, rawAllCountsByDate)
    const allCountsByDate = fillMissingDailyCounts(rawAllCountsByDate, labels, allVersionNames)

    const currentCounts = await readDeviceVersionCounts(c, body.app_id, channelData.name)

    const selectedVersions = selectRecentChannelVersions(deploymentHistory, currentVersionName, currentCounts, 10)
    const chartCounts = createChartCountsByDate(labels, allCountsByDate, selectedVersions, allVersionNames)

    const activeVersions = chartCounts.versions.filter((version) => {
      if (version === currentVersionName)
        return true
      return labels.some(label => (chartCounts.countsByDate[label]?.[version] ?? 0) > 0)
    })

    const percentagesByDate = convertCountsToPercentagesByName(chartCounts.countsByDate, labels, activeVersions)
    const datasets = createPercentageDatasetsByName(activeVersions, labels, percentagesByDate, chartCounts.countsByDate)
    const dailyTotals = labels.map(label => getDailyTotal(allCountsByDate[label]))

    const latestDailyCounts = getLatestCounts(labels, allCountsByDate)
    const totalDevices = getDailyTotal(latestDailyCounts)
    const devicesOnCurrent = currentVersionName ? Math.round(latestDailyCounts[currentVersionName] ?? 0) : 0
    const percentOnCurrent = totalDevices > 0 ? Math.round((devicesOnCurrent / totalDevices) * 1000) / 10 : 0
    const deploymentHistorySorted = [...deploymentHistory].sort((a, b) => dayjs(b.deployed_at).valueOf() - dayjs(a.deployed_at).valueOf())

    return c.json({
      labels,
      datasets,
      dailyTotals,
      latestVersion: {
        name: currentVersionName,
        percentage: percentOnCurrent.toFixed(1),
      },
      currentVersion: currentVersionName,
      currentVersionReleasedAt,
      deploymentHistory: deploymentHistorySorted.slice(0, 10),
      lastDeploymentAt: deploymentHistorySorted[0]?.deployed_at ?? null,
      totalDeployments: deploymentHistorySorted.length,
      period: {
        requested_days: period.requestedDays,
        actual_days: labels.length,
        start: dayjs.utc(labels[0] ?? period.startDate).startOf('day').toISOString(),
        end: dayjs.utc(labels[labels.length - 1] ?? period.endDate).endOf('day').toISOString(),
        start_reason: period.startReason,
      },
      totals: {
        total_devices: totalDevices,
        devices_on_current: devicesOnCurrent,
        devices_on_other: Math.max(0, totalDevices - devicesOnCurrent),
        percent_on_current: percentOnCurrent,
      },
    })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Error fetching channel stats', error })
    throw simpleError('fetch_error', 'Failed to fetch channel statistics', { error: String(error) })
  }
})

export const channelStatsTestUtils = {
  generateDateLabels,
  buildDailyReportedCountsByName,
  fillMissingDailyCounts,
  convertCountsToPercentagesByName,
  selectRecentChannelVersions,
  getLatestCounts,
  getStatsPeriod,
  normalizeStatsPeriodDays,
  trimTrailingEmptyLabels,
}
