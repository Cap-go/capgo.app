import type { Context } from 'hono'
import { formatDateCF, PUBLIC_FAILURE_ACTIONS, runQueryToCFA } from './cloudflare.ts'
import { NOT_LEGACY_DOWNLOAD_FAIL_CF } from './legacyDownloadFail.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

/**
 * Public live update metrics: the single source of capgo.app/data, served by
 * GET /private/website_stats/live_updates. Percentages only, never raw counts.
 */

export const LIVE_UPDATE_KPI_WINDOW_DAYS = 30
export const LIVE_UPDATE_TREND_DAYS = 90
const LIVE_UPDATE_SPARKLINE_DAYS = 30

export interface PublicBreakdownMetric {
  key: string
  share: number
  success_rate: number | null
  top_failure: { reason: string, share: number } | null
}

export interface PublicDailyPlatformMetric {
  date: string
  ios: number | null
  android: number | null
}

export interface PublicLiveUpdateMetrics {
  success_rate: number
  first_try_rate: number | null
  first_day_rate: number | null
  first_day_success_rate: number | null
  rollback_rate: number | null
  zip_success_rate: number | null
  delta_success_rate: number | null
  period_days: number
  daily_window_days: number
  updated_at: string
  daily: Array<{ date: string, success_rate: number }>
  daily_platforms: PublicDailyPlatformMetric[]
  daily_platforms_sparkline: PublicDailyPlatformMetric[]
  hourly_platforms: PublicDailyPlatformMetric[]
  failures: Array<{ reason: string, share: number }>
  platforms: PublicBreakdownMetric[]
  countries: PublicBreakdownMetric[]
  updater_versions: PublicBreakdownMetric[]
}

const PUBLIC_MIN_DIMENSION_OUTCOMES = 50
const PUBLIC_TOP_COUNTRIES = 12
const PUBLIC_TOP_VERSIONS = 10
// Events proving an update was offered to the device or a download actually ran that day.
const PUBLIC_OFFER_ACTIONS = ['get', 'download_0', 'download_zip_start', 'download_manifest_start', 'download_complete', 'set_next'] as const
const PUBLIC_ZIP_FAIL_ACTIONS = ['unzip_fail', 'download_fail'] as const
const PUBLIC_DELTA_FAIL_ACTIONS = ['download_manifest_file_fail', 'download_manifest_checksum_fail', 'download_manifest_brotli_fail', 'manifest_path_fail'] as const

function roundPublicPercent(value: number) {
  return Number(value.toFixed(1))
}

function rawShare(part: number, total: number) {
  return total > 0 ? (part / total) * 100 : 0
}

function rateFromParts(part: number, total: number): number | null {
  return total > 0 ? roundPublicPercent((part / total) * 100) : null
}

function rateFromOutcomes(successes: number, failures: number): number | null {
  return rateFromParts(successes, successes + failures)
}

function sqlList(values: readonly string[]) {
  return values.map(value => `'${value}'`).join(', ')
}

function utcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function buildBreakdownMetrics(
  shareRows: Array<{ key: string, devices: number }>,
  outcomeRows: Array<{ key: string, successes: number, failures: number }>,
  failureRows: Array<{ key: string, action: string, devices: number }>,
  limit: number,
): PublicBreakdownMetric[] {
  const shareTotal = shareRows.reduce((sum, row) => sum + (Number(row.devices) || 0), 0)
  const outcomesByKey = new Map<string, { successes: number, failures: number }>()
  for (const row of outcomeRows) {
    const key = String(row.key || '').trim()
    if (!key)
      continue
    outcomesByKey.set(key, {
      successes: Number(row.successes) || 0,
      failures: Number(row.failures) || 0,
    })
  }
  const failuresByKey = new Map<string, Array<{ reason: string, devices: number }>>()
  for (const row of failureRows) {
    const key = String(row.key || '').trim()
    if (!key)
      continue
    const list = failuresByKey.get(key) ?? []
    list.push({ reason: row.action, devices: Number(row.devices) || 0 })
    failuresByKey.set(key, list)
  }

  // Rank/limit on raw volume first, then round percentages for the public payload.
  return shareRows
    .map((row) => {
      const key = String(row.key || '').trim()
      const devices = Number(row.devices) || 0
      const outcomes = outcomesByKey.get(key)
      const totalOutcomes = outcomes ? outcomes.successes + outcomes.failures : 0
      const success_rate = totalOutcomes >= PUBLIC_MIN_DIMENSION_OUTCOMES
        ? roundPublicPercent((outcomes!.successes / totalOutcomes) * 100)
        : null
      const dimFailures = failuresByKey.get(key) ?? []
      const failureTotal = dimFailures.reduce((sum, item) => sum + item.devices, 0)
      const top = [...dimFailures].sort((a, b) => b.devices - a.devices)[0]
      return {
        key,
        devices,
        success_rate,
        top_failure: top && failureTotal
          ? { reason: top.reason, share: roundPublicPercent(rawShare(top.devices, failureTotal)) }
          : null,
      }
    })
    .filter(row => row.key && row.devices > 0)
    .sort((a, b) => b.devices - a.devices || (b.success_rate ?? -1) - (a.success_rate ?? -1))
    .slice(0, limit)
    .map(({ key, devices, success_rate, top_failure }) => ({
      key,
      share: roundPublicPercent(rawShare(devices, shareTotal)),
      success_rate,
      top_failure,
    }))
}

function buildDailyPlatforms(rows: Array<{ date: string, key: string, successes: number, failures: number }>): PublicDailyPlatformMetric[] {
  const byDate = new Map<string, PublicDailyPlatformMetric>()
  for (const row of rows) {
    const date = String(row.date || '').trim()
    const key = String(row.key || '').trim()
    if (!date || (key !== 'ios' && key !== 'android'))
      continue
    const current = byDate.get(date) ?? { date, ios: null, android: null }
    current[key] = rateFromOutcomes(Number(row.successes) || 0, Number(row.failures) || 0)
    byDate.set(date, current)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** One row per UTC day of the `days` ending on `lastDay`, days without outcomes as gaps. */
function buildContiguousDailyPlatforms(rows: PublicDailyPlatformMetric[], lastDay: Date, days: number): PublicDailyPlatformMetric[] {
  const byDate = new Map(rows.map(row => [row.date, row]))
  const end = utcDay(lastDay)
  const result: PublicDailyPlatformMetric[] = []
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(end)
    date.setUTCDate(end.getUTCDate() - offset)
    const key = date.toISOString().slice(0, 10)
    result.push(byDate.get(key) ?? { date: key, ios: null, android: null })
  }
  return result
}

function buildDayWindow(referenceDate: Date, days: number) {
  const end = utcDay(referenceDate)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - days)
  return `timestamp >= toDateTime('${formatDateCF(start)}') AND timestamp < toDateTime('${formatDateCF(end)}')`
}

function buildRollingHourlyWindow(referenceDate: Date) {
  const end = new Date(referenceDate)
  end.setUTCMinutes(0, 0, 0)
  end.setUTCHours(end.getUTCHours() + 1)
  const start = new Date(end)
  start.setUTCHours(start.getUTCHours() - 24)
  return `timestamp >= toDateTime('${formatDateCF(start)}') AND timestamp < toDateTime('${formatDateCF(end)}')`
}

// The plugin also reports failed update checks (network errors, legacy or custom update responses) as download_fail.
// Those devices never had anything to install, so download_fail only counts when an update was offered that day.
function buildOutcomeBase(window: string, bucket: string) {
  const failureActions = sqlList(PUBLIC_FAILURE_ACTIONS)
  const offerActions = sqlList(PUBLIC_OFFER_ACTIONS)
  return `SELECT ${bucket} AS date, index1 AS app_id, blob1 AS device_id, max(if(blob2 = 'set', 1, 0)) AS succeeded, max(if(blob2 IN (${failureActions}) AND blob2 != 'download_fail', 1, 0)) AS install_failed, max(if(blob2 = 'download_fail', 1, 0)) AS download_failed, max(if(blob2 IN (${offerActions}), 1, 0)) AS offered, argMax(blob5, timestamp) AS platform, argMax(blob6, timestamp) AS country, argMax(blob7, timestamp) AS plugin_version FROM app_log WHERE ${window} AND (blob2 = 'set' OR blob2 IN (${failureActions}) OR blob2 IN (${offerActions})) GROUP BY date, app_id, device_id`
}

const FAILED_OUTCOME = `if(succeeded = 0 AND (install_failed = 1 OR (download_failed = 1 AND offered = 1)), 1, 0)`

/**
 * Analytics Engine rejects more than one level of subquery, so every query is a
 * per-device-day (or per-device) subquery with one aggregation on top.
 */
export function buildPublicLiveUpdateQueries(referenceDate = new Date()) {
  const window = buildDayWindow(referenceDate, LIVE_UPDATE_KPI_WINDOW_DAYS)
  const trendWindow = buildDayWindow(referenceDate, LIVE_UPDATE_TREND_DAYS)
  const hourlyWindow = buildRollingHourlyWindow(referenceDate)
  const zipFailActions = sqlList(PUBLIC_ZIP_FAIL_ACTIONS)
  const deltaFailActions = sqlList(PUBLIC_DELTA_FAIL_ACTIONS)
  const day = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d')`
  const hour = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' HOUR), '%Y-%m-%d %H:00')`
  // Failure breakdowns count every failure log, so they drop download_fail of older plugins (failed update checks).
  const isBreakdownFailure = `blob2 IN (${sqlList(PUBLIC_FAILURE_ACTIONS)}) AND ${NOT_LEGACY_DOWNLOAD_FAIL_CF}`
  const outcomeBase = buildOutcomeBase(window, day)
  const trendOutcomeBase = buildOutcomeBase(trendWindow, day)
  const hourlyOutcomeBase = buildOutcomeBase(hourlyWindow, hour)

  return {
    outcomes: `SELECT date, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures, sum(if(succeeded = 1 AND install_failed = 0 AND download_failed = 0, 1, 0)) AS first_tries FROM (${outcomeBase}) GROUP BY date`,
    rollback: `SELECT sum(has_reset) AS rollbacks, sum(if(has_set + has_reset > 0, 1, 0)) AS outcomes FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, max(if(blob2 = 'reset', 1, 0)) AS has_reset, max(if(blob2 = 'set', 1, 0)) AS has_set FROM app_log WHERE ${window} AND blob2 IN ('set', 'reset') GROUP BY date, app_id, device_id)`,
    package: `SELECT sum(if(zip_ok = 1, 1, 0)) AS zip_successes, sum(if(zip_ok = 0 AND zip_fail = 1, 1, 0)) AS zip_failures, sum(if(delta_ok = 1, 1, 0)) AS delta_successes, sum(if(delta_ok = 0 AND delta_fail = 1, 1, 0)) AS delta_failures FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, max(if(blob2 = 'download_zip_complete', 1, 0)) AS zip_ok, max(if(blob2 IN (${zipFailActions}) AND ${NOT_LEGACY_DOWNLOAD_FAIL_CF}, 1, 0)) AS zip_fail, max(if(blob2 = 'download_manifest_complete', 1, 0)) AS delta_ok, max(if(blob2 IN (${deltaFailActions}), 1, 0)) AS delta_fail FROM app_log WHERE ${window} AND blob2 IN ('download_zip_complete', 'download_manifest_complete', ${zipFailActions}, ${deltaFailActions}) GROUP BY date, app_id, device_id)`,
    failures: `SELECT action, count() AS devices FROM (SELECT ${day} AS date, blob2 AS action, index1 AS app_id, blob1 AS device_id FROM app_log WHERE ${window} AND ${isBreakdownFailure} GROUP BY date, action, app_id, device_id) GROUP BY action`,
    platformsShare: `SELECT platform, count() AS devices FROM (SELECT double1 AS platform, index1 AS app_id, blob1 AS device_id FROM device_usage WHERE ${window} AND double1 IN (0.0, 1.0, 2.0) GROUP BY platform, app_id, device_id) GROUP BY platform`,
    platformsDaily: `SELECT date, platform AS key, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures FROM (${trendOutcomeBase}) WHERE platform IN ('ios', 'android') GROUP BY date, platform`,
    platformsHourly: `SELECT date, platform AS key, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures FROM (${hourlyOutcomeBase}) WHERE platform IN ('ios', 'android') GROUP BY date, platform`,
    platformsOutcome: `SELECT platform AS key, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures FROM (${outcomeBase}) WHERE platform IN ('ios', 'android', 'electron') GROUP BY platform`,
    platformsFailure: `SELECT platform AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob5, timestamp) AS platform FROM app_log WHERE ${window} AND ${isBreakdownFailure} GROUP BY date, app_id, device_id, action) WHERE platform IN ('ios', 'android', 'electron') GROUP BY platform, action`,
    countriesShare: `SELECT country AS key, count() AS devices FROM (SELECT index1 AS app_id, blob1 AS device_id, argMax(blob10, timestamp) AS country FROM device_info WHERE ${window} AND blob10 != '' GROUP BY app_id, device_id) WHERE country != '' GROUP BY country`,
    countriesOutcome: `SELECT country AS key, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures FROM (${outcomeBase}) WHERE country != '' GROUP BY country`,
    countriesFailure: `SELECT country AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob6, timestamp) AS country FROM app_log WHERE ${window} AND ${isBreakdownFailure} GROUP BY date, app_id, device_id, action) WHERE country != '' GROUP BY country, action`,
    versionsShare: `SELECT version AS key, count() AS devices FROM (SELECT index1 AS app_id, blob1 AS device_id, argMax(blob3, timestamp) AS version FROM device_info WHERE ${window} AND blob3 != '' GROUP BY app_id, device_id) WHERE version != '' GROUP BY version`,
    versionsOutcome: `SELECT plugin_version AS key, sum(succeeded) AS successes, sum(${FAILED_OUTCOME}) AS failures FROM (${outcomeBase}) WHERE plugin_version != '' GROUP BY plugin_version`,
    versionsFailure: `SELECT plugin_version AS key, action, count() AS devices FROM (SELECT ${day} AS date, index1 AS app_id, blob1 AS device_id, blob2 AS action, argMax(blob7, timestamp) AS plugin_version FROM app_log WHERE ${window} AND ${isBreakdownFailure} GROUP BY date, app_id, device_id, action) WHERE plugin_version != '' GROUP BY plugin_version, action`,
  }
}

export async function getPublicLiveUpdateMetricsCF(c: Context, referenceDate = new Date()): Promise<PublicLiveUpdateMetrics> {
  if (!c.env.APP_LOG || !c.env.DEVICE_USAGE || !c.env.DEVICE_INFO || !getEnv(c, 'CF_ANALYTICS_TOKEN') || !getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'))
    throw new Error('Public live update metric bindings are unavailable')

  const queries = buildPublicLiveUpdateQueries(referenceDate)
  try {
    const [
      outcomeRows,
      rollbackRows,
      packageRows,
      failureRows,
      platformShareRows,
      platformDailyRows,
      platformHourlyRows,
      platformOutcomeRows,
      platformFailureRows,
      countryShareRows,
      countryOutcomeRows,
      countryFailureRows,
      versionShareRows,
      versionOutcomeRows,
      versionFailureRows,
    ] = await Promise.all([
      runQueryToCFA<{ date: string, successes: number, failures: number, first_tries: number }>(c, queries.outcomes),
      runQueryToCFA<{ rollbacks: number, outcomes: number }>(c, queries.rollback),
      runQueryToCFA<{ zip_successes: number, zip_failures: number, delta_successes: number, delta_failures: number }>(c, queries.package),
      runQueryToCFA<{ action: string, devices: number }>(c, queries.failures),
      runQueryToCFA<{ platform: number, devices: number }>(c, queries.platformsShare),
      runQueryToCFA<{ date: string, key: string, successes: number, failures: number }>(c, queries.platformsDaily),
      runQueryToCFA<{ date: string, key: string, successes: number, failures: number }>(c, queries.platformsHourly),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, queries.platformsOutcome),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, queries.platformsFailure),
      runQueryToCFA<{ key: string, devices: number }>(c, queries.countriesShare),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, queries.countriesOutcome),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, queries.countriesFailure),
      runQueryToCFA<{ key: string, devices: number }>(c, queries.versionsShare),
      runQueryToCFA<{ key: string, successes: number, failures: number }>(c, queries.versionsOutcome),
      runQueryToCFA<{ key: string, action: string, devices: number }>(c, queries.versionsFailure),
    ])

    const daily = outcomeRows.map((row) => {
      const successes = Number(row.successes) || 0
      const failures = Number(row.failures) || 0
      const outcomes = successes + failures
      return { date: row.date, success_rate: outcomes ? roundPublicPercent((successes / outcomes) * 100) : 0 }
    }).sort((a, b) => a.date.localeCompare(b.date))
    const totalSuccesses = outcomeRows.reduce((sum, row) => sum + (Number(row.successes) || 0), 0)
    const totalFailures = outcomeRows.reduce((sum, row) => sum + (Number(row.failures) || 0), 0)
    const totalFirstTries = outcomeRows.reduce((sum, row) => sum + (Number(row.first_tries) || 0), 0)
    const totalOutcomes = totalSuccesses + totalFailures
    const rollback = rollbackRows[0]
    const packages = packageRows[0]
    const failureTotal = failureRows.reduce((sum, row) => sum + (Number(row.devices) || 0), 0)
    const failures = [...failureRows]
      .map(row => ({ reason: row.action, devices: Number(row.devices) || 0 }))
      .sort((a, b) => b.devices - a.devices)
      .slice(0, 8)
      .map(row => ({
        reason: row.reason,
        share: failureTotal ? roundPublicPercent(rawShare(row.devices, failureTotal)) : 0,
      }))
    const platformShareMapped = platformShareRows.map((row) => {
      const platform = Number(row.platform)
      const key = platform === 0 ? 'android' : platform === 1 ? 'ios' : platform === 2 ? 'electron' : ''
      return { key, devices: Number(row.devices) || 0 }
    }).filter(row => row.key)

    // Daily queries stop at the start of the current UTC day, so the series ends on yesterday.
    const lastCompleteDay = utcDay(referenceDate)
    lastCompleteDay.setUTCDate(lastCompleteDay.getUTCDate() - 1)
    const daily_platforms = buildContiguousDailyPlatforms(buildDailyPlatforms(platformDailyRows), lastCompleteDay, LIVE_UPDATE_TREND_DAYS)

    return {
      success_rate: totalOutcomes ? roundPublicPercent((totalSuccesses / totalOutcomes) * 100) : 0,
      first_try_rate: rateFromParts(totalFirstTries, totalSuccesses),
      // Needs a second level of subquery, which Analytics Engine rejects.
      first_day_rate: null,
      first_day_success_rate: null,
      rollback_rate: rateFromParts(Number(rollback?.rollbacks) || 0, Number(rollback?.outcomes) || 0),
      zip_success_rate: rateFromOutcomes(Number(packages?.zip_successes) || 0, Number(packages?.zip_failures) || 0),
      delta_success_rate: rateFromOutcomes(Number(packages?.delta_successes) || 0, Number(packages?.delta_failures) || 0),
      period_days: LIVE_UPDATE_KPI_WINDOW_DAYS,
      daily_window_days: LIVE_UPDATE_TREND_DAYS,
      updated_at: referenceDate.toISOString(),
      daily,
      daily_platforms,
      daily_platforms_sparkline: daily_platforms.slice(-LIVE_UPDATE_SPARKLINE_DAYS),
      hourly_platforms: buildDailyPlatforms(platformHourlyRows),
      failures,
      platforms: buildBreakdownMetrics(platformShareMapped, platformOutcomeRows, platformFailureRows, 3),
      countries: buildBreakdownMetrics(countryShareRows, countryOutcomeRows, countryFailureRows, PUBLIC_TOP_COUNTRIES),
      updater_versions: buildBreakdownMetrics(versionShareRows, versionOutcomeRows, versionFailureRows, PUBLIC_TOP_VERSIONS),
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading public live update metrics', error: serializeError(error) })
    throw error
  }
}
