import type { Context } from 'hono'
import type { VersionUsageChannel } from './types.ts'
import { buildAppLogFailureChannelFilterCF, buildVersionUsageChannelFilterCF, DAY_BUCKET_CF, escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { isLegacyDownloadFailPlugin } from './legacyDownloadFail.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

// Rollout auto-pause reads install and fail totals of each channel's rollout
// version. Analytics Engine SQL API calls share one token limited to 1,200
// requests per 5 minutes, so the channels of one app are read with one
// version_usage query and one app_log query instead of two per channel.
//
// Never put several apps in one query: Analytics Engine picks the sample rate
// of the whole query from the data it covers, so a small app read together with
// a big one gets coarser (different) counts than when read alone.

export interface RolloutChannelWindow {
  appId: string
  channel: VersionUsageChannel
  versionName: string
  start: string
}

export interface RolloutChannelTotals {
  installs: number
  failures: number
}

function stripLeadingAnd(filter: string) {
  return filter.trim().replace(/^AND\s+/, '')
}

function channelWindowCondition(window: RolloutChannelWindow, channelMatch: string, versionColumn: string) {
  const parts = [
    `timestamp >= toDateTime('${formatDateCF(window.start)}')`,
    `${versionColumn} = '${escapeSqlString(window.versionName)}'`,
  ]
  if (channelMatch)
    parts.push(channelMatch)
  return parts.map(part => `(${part})`).join(' AND ')
}

function earliestStart(windows: RolloutChannelWindow[]) {
  return windows.reduce((min, window) => new Date(window.start).getTime() < new Date(min).getTime() ? window.start : min, windows[0]!.start)
}

function singleAppId(windows: RolloutChannelWindow[]) {
  const appIds = new Set(windows.map(window => window.appId))
  if (appIds.size !== 1)
    throw new Error('Rollout totals are read for the channels of exactly one app per query')
  return `'${escapeSqlString(windows[0]!.appId)}'`
}

/**
 * One version_usage query for the channels of one app: install and fail sums per day of
 * each channel's rollout version inside its own window (columns i<n> / f<n>).
 */
export function buildRolloutVersionTotalsCFQuery(windows: RolloutChannelWindow[], end: string) {
  const columns = windows.flatMap((window, index) => {
    const condition = channelWindowCondition(window, stripLeadingAnd(buildVersionUsageChannelFilterCF(window.channel)), 'blob2')
    return [
      `sum(if(${condition} AND blob3 = 'install', _sample_interval, 0)) AS i${index}`,
      `sum(if(${condition} AND blob3 = 'fail', _sample_interval, 0)) AS f${index}`,
    ]
  })
  return `SELECT
  ${DAY_BUCKET_CF} AS date,
  blob1 AS app_id,
  ${columns.join(',\n  ')}
FROM version_usage
WHERE
  index1 = ${singleAppId(windows)}
  AND timestamp >= toDateTime('${formatDateCF(earliestStart(windows))}')
  AND timestamp < toDateTime('${formatDateCF(end)}')
  AND blob3 IN ('install', 'fail')
GROUP BY date, app_id`
}

/** The legacy download_fail correction of buildRolloutVersionTotalsCFQuery (columns l<n>). */
export function buildRolloutLegacyFailsCFQuery(windows: RolloutChannelWindow[], end: string) {
  const columns = windows.map((window, index) => {
    const condition = channelWindowCondition(window, stripLeadingAnd(buildAppLogFailureChannelFilterCF(window.channel)), 'blob3')
    return `sum(if(${condition}, _sample_interval, 0)) AS l${index}`
  })
  return `SELECT
  ${DAY_BUCKET_CF} AS bucket,
  blob7 AS plugin_version,
  ${columns.join(',\n  ')}
FROM app_log
WHERE
  index1 = ${singleAppId(windows)}
  AND blob2 = 'download_fail'
  AND blob7 != ''
  AND blob10 = ''
  AND timestamp >= toDateTime('${formatDateCF(earliestStart(windows))}')
  AND timestamp < toDateTime('${formatDateCF(end)}')
GROUP BY bucket, plugin_version`
}

type RolloutTotalsRow = Record<string, string | number | null>

/**
 * Totals per channel, equal to summing readStatsVersionCF(app, start, end,
 * channel) rows of the rollout version: daily fails minus that day's legacy
 * download_fail, never below zero. Returns null when either query fails, so
 * the caller can retry those channels on its next run instead of deciding on
 * partial data.
 */
export async function readRolloutVersionTotalsCF(c: Context, windows: RolloutChannelWindow[], end: string, options: { signal?: AbortSignal } = {}): Promise<RolloutChannelTotals[] | null> {
  const totals = windows.map(() => ({ installs: 0, failures: 0 }))
  if (!c.env.VERSION_USAGE || windows.length === 0)
    return totals

  const query = buildRolloutVersionTotalsCFQuery(windows, end)
  const legacyQuery = c.env.APP_LOG ? buildRolloutLegacyFailsCFQuery(windows, end) : null
  cloudlog({ requestId: c.get('requestId'), message: 'readRolloutVersionTotalsCF query', channelCount: windows.length })
  const [usage, legacy] = await Promise.all([
    runQueryToCFA<RolloutTotalsRow>(c, query, options.signal).catch((e) => {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading rollout version totals', error: serializeError(e), query })
      return null
    }),
    legacyQuery
      ? runQueryToCFA<RolloutTotalsRow>(c, legacyQuery, options.signal).catch((e) => {
        cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading rollout legacy download_fail', error: serializeError(e), query: legacyQuery })
        return null
      })
      : Promise.resolve(null),
  ])
  if (!usage || (legacyQuery && !legacy))
    return null

  // Legacy fails per channel and day, counted like sumLegacyDownloadFails.
  const legacyByChannel = windows.map(() => new Map<string, number>())
  for (const row of legacy ?? []) {
    if (!isLegacyDownloadFailPlugin(String(row.plugin_version ?? '')))
      continue
    windows.forEach((_window, index) => {
      const count = Number(row[`l${index}`])
      if (!Number.isFinite(count) || count <= 0)
        return
      const bucket = String(row.bucket)
      legacyByChannel[index]!.set(bucket, (legacyByChannel[index]!.get(bucket) ?? 0) + count)
    })
  }

  for (const row of usage) {
    windows.forEach((_window, index) => {
      totals[index]!.installs += Number(row[`i${index}`] ?? 0)
      const fails = Number(row[`f${index}`] ?? 0)
      const legacyFails = legacyByChannel[index]!.get(String(row.date))
      totals[index]!.failures += legacyFails ? Math.max(0, fails - legacyFails) : fails
    })
  }
  return totals
}
