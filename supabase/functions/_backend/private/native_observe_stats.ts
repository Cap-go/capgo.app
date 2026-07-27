import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { Hono } from 'hono/tiny'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'

dayjs.extend(utc)

const supportedPeriodDays = [1, 3, 7, 30] as const
type NativeObservePeriodDays = typeof supportedPeriodDays[number]
type NativeObserveView = 'global' | 'plugins'

interface NativeObserveStatsRequest {
  app_id: string
  days?: number
  view?: NativeObserveView
}

interface NativeObserveMetricRow {
  day?: string
  action: string
  events: number | string
  devices: number | string
  p50_ms: number | string | null
  p90_ms: number | string | null
  p99_ms: number | string | null
}

interface NativeObserveVersionRow {
  version_name: string
  events: number | string
  devices: number | string
  issue_count: number | string
  affected_devices: number | string
  launch_p90_ms: number | string | null
  webview_load_p90_ms: number | string | null
}

interface NativeObservePluginVersionRow {
  plugin_version: string
  devices: number | string
  total_devices: number | string
}

interface NativeObserveOverviewRow {
  events: number | string
  devices: number | string
  issue_count: number | string
  affected_devices: number | string
  launch_timeout_count: number | string
  launch_p50_ms: number | string | null
  launch_p90_ms: number | string | null
  webview_load_p50_ms: number | string | null
  webview_load_p90_ms: number | string | null
}

interface NativeObserveReleaseMarker {
  version_name: string
  channel_name: string
  deployed_at: string
}

type NativeObserveNumericValue = number | string | null | undefined

interface BuildNativeObserveResponseInput {
  labels: string[]
  days: NativeObservePeriodDays
  start: string
  end: string
  dailyRows: NativeObserveMetricRow[]
  actionRows: NativeObserveMetricRow[]
  versionRows: NativeObserveVersionRow[]
  overviewRow: NativeObserveOverviewRow | undefined
  releaseMarkers: NativeObserveReleaseMarker[]
}

const nativeObserveActions = [
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'app_memory_warning',
  'app_launch_start',
  'app_launch_ready',
  'app_launch_timeout',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
  'webview_dom_content_loaded',
  'webview_page_loaded',
  'os_version_changed',
  'native_app_version_changed',
] as const

const issueActions = [
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'app_memory_warning',
  'app_launch_timeout',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
] as const

const issueActionSet = new Set<string>(issueActions)
const launchReadyAction = 'app_launch_ready'
const webviewPageLoadedAction = 'webview_page_loaded'

const durationExpression = String.raw`CASE
  WHEN metadata ? 'duration_ms' AND metadata ->> 'duration_ms' ~ '^[0-9]+(\.[0-9]+)?$' THEN (metadata ->> 'duration_ms')::double precision
  WHEN metadata ? 'duration' AND metadata ->> 'duration' ~ '^[0-9]+(\.[0-9]+)?$' THEN (metadata ->> 'duration')::double precision
  ELSE NULL
END`

const filteredStatsCte = `WITH filtered AS (
  SELECT
    to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
    action,
    COALESCE(NULLIF(version_name, ''), 'unknown') AS version_name,
    device_id,
    ${durationExpression} AS duration_ms
  FROM public.stats
  WHERE app_id = $1
    AND created_at >= $2::timestamptz
    AND created_at < $3::timestamptz
    AND action = ANY($4::public.stats_action[])
)`

const dailyStatsQuery = `${filteredStatsCte}
SELECT
  day,
  action::text AS action,
  count(*)::integer AS events,
  count(DISTINCT device_id)::integer AS devices,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p90_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p99_ms
FROM filtered
GROUP BY day, action
ORDER BY day ASC, action ASC`

const actionStatsQuery = `${filteredStatsCte}
SELECT
  action::text AS action,
  count(*)::integer AS events,
  count(DISTINCT device_id)::integer AS devices,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p90_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS p99_ms
FROM filtered
GROUP BY action
ORDER BY events DESC, action ASC`

const overviewStatsQuery = `${filteredStatsCte}
SELECT
  count(*)::integer AS events,
  count(DISTINCT device_id)::integer AS devices,
  count(*) FILTER (WHERE action = ANY($5::public.stats_action[]))::integer AS issue_count,
  count(DISTINCT device_id) FILTER (WHERE action = ANY($5::public.stats_action[]))::integer AS affected_devices,
  count(*) FILTER (WHERE action = 'app_launch_timeout'::public.stats_action)::integer AS launch_timeout_count,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'app_launch_ready'::public.stats_action AND duration_ms IS NOT NULL) AS launch_p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'app_launch_ready'::public.stats_action AND duration_ms IS NOT NULL) AS launch_p90_ms,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'webview_page_loaded'::public.stats_action AND duration_ms IS NOT NULL) AS webview_load_p50_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'webview_page_loaded'::public.stats_action AND duration_ms IS NOT NULL) AS webview_load_p90_ms
FROM filtered`

const versionStatsQuery = `${filteredStatsCte}
SELECT
  version_name,
  count(*)::integer AS events,
  count(DISTINCT device_id)::integer AS devices,
  count(*) FILTER (WHERE action = ANY($5::public.stats_action[]))::integer AS issue_count,
  count(DISTINCT device_id) FILTER (WHERE action = ANY($5::public.stats_action[]))::integer AS affected_devices,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'app_launch_ready'::public.stats_action AND duration_ms IS NOT NULL) AS launch_p90_ms,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE action = 'webview_page_loaded'::public.stats_action AND duration_ms IS NOT NULL) AS webview_load_p90_ms
FROM filtered
GROUP BY version_name
ORDER BY events DESC, version_name ASC
LIMIT 12`

const pluginVersionStatsQuery = `SELECT
  COALESCE(NULLIF(plugin_version, ''), 'unknown') AS plugin_version,
  count(*)::integer AS devices,
  sum(count(*)) OVER ()::integer AS total_devices
FROM public.devices
WHERE app_id = $1
  AND is_prod IS TRUE
  AND is_emulator IS NOT TRUE
GROUP BY COALESCE(NULLIF(plugin_version, ''), 'unknown')
ORDER BY devices DESC, plugin_version ASC
LIMIT 12`

const releaseMarkersQuery = `SELECT
  COALESCE(NULLIF(app_versions.name, ''), 'unknown') AS version_name,
  COALESCE(NULLIF(channels.name, ''), 'unknown') AS channel_name,
  deploy_history.deployed_at::text AS deployed_at
FROM public.deploy_history
INNER JOIN public.app_versions ON app_versions.id = deploy_history.version_id
INNER JOIN public.channels ON channels.id = deploy_history.channel_id
WHERE deploy_history.app_id = $1
  AND deploy_history.deployed_at >= $2::timestamptz
  AND deploy_history.deployed_at < $3::timestamptz
ORDER BY deploy_history.deployed_at DESC
LIMIT 20`

function normalizeNativeObservePeriodDays(days: number | undefined = 7): NativeObservePeriodDays | null {
  if (!Number.isInteger(days) || !supportedPeriodDays.includes(days as NativeObservePeriodDays))
    return null

  return days as NativeObservePeriodDays
}

function normalizeNativeObserveView(value: unknown): NativeObserveView | null {
  if (value === undefined || value === 'global')
    return 'global'
  if (value === 'plugins')
    return 'plugins'
  return null
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

function toCount(value: NativeObserveNumericValue) {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function toMetric(value: NativeObserveNumericValue, decimals = 0) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric))
    return null

  const factor = 10 ** decimals
  return Math.round(numeric * factor) / factor
}

function createSeries(length: number): number[] {
  return Array.from<number>({ length }).fill(0)
}

function setMetric(series: Array<number | null>, index: number, value: NativeObserveNumericValue) {
  const metric = toMetric(value)
  if (metric !== null)
    series[index] = metric
}

function buildNativeObserveResponse(input: BuildNativeObserveResponseInput) {
  const labelIndex = new Map(input.labels.map((label, index) => [label, index]))
  const totalEvents = createSeries(input.labels.length)
  const issueEvents = createSeries(input.labels.length)
  const launches = createSeries(input.labels.length)
  const webviewLoads = createSeries(input.labels.length)
  const launchP50 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const launchP90 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const webviewLoadP50 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const webviewLoadP90 = Array.from<number | null>({ length: input.labels.length }).fill(null)

  for (const row of input.dailyRows) {
    if (!row.day)
      continue

    const index = labelIndex.get(row.day)
    if (index === undefined)
      continue

    const events = toCount(row.events)
    totalEvents[index] += events

    if (issueActionSet.has(row.action))
      issueEvents[index] += events

    if (row.action === launchReadyAction) {
      launches[index] += events
      setMetric(launchP50, index, row.p50_ms)
      setMetric(launchP90, index, row.p90_ms)
    }

    if (row.action === webviewPageLoadedAction) {
      webviewLoads[index] += events
      setMetric(webviewLoadP50, index, row.p50_ms)
      setMetric(webviewLoadP90, index, row.p90_ms)
    }
  }

  const overview = input.overviewRow ?? {
    events: 0,
    devices: 0,
    issue_count: 0,
    affected_devices: 0,
    launch_timeout_count: 0,
    launch_p50_ms: null,
    launch_p90_ms: null,
    webview_load_p50_ms: null,
    webview_load_p90_ms: null,
  }
  const totalDevices = toCount(overview.devices)
  const affectedDevices = toCount(overview.affected_devices)
  const issueFreeRate = totalDevices > 0
    ? toMetric(((totalDevices - affectedDevices) / totalDevices) * 100, 1) ?? 0
    : 100

  return {
    labels: input.labels,
    period: {
      requested_days: input.days,
      actual_days: input.labels.length,
      start: input.start,
      end: input.end,
    },
    overview: {
      total_events: toCount(overview.events),
      total_devices: totalDevices,
      issue_count: toCount(overview.issue_count),
      affected_devices: affectedDevices,
      issue_free_rate: issueFreeRate,
      launch_timeout_count: toCount(overview.launch_timeout_count),
      launch_p50_ms: toMetric(overview.launch_p50_ms),
      launch_p90_ms: toMetric(overview.launch_p90_ms),
      webview_load_p50_ms: toMetric(overview.webview_load_p50_ms),
      webview_load_p90_ms: toMetric(overview.webview_load_p90_ms),
    },
    daily: {
      total_events: totalEvents,
      issue_events: issueEvents,
      launches,
      webview_loads: webviewLoads,
      launch_p50_ms: launchP50,
      launch_p90_ms: launchP90,
      webview_load_p50_ms: webviewLoadP50,
      webview_load_p90_ms: webviewLoadP90,
    },
    actionBreakdown: input.actionRows.map(row => ({
      action: row.action,
      events: toCount(row.events),
      devices: toCount(row.devices),
      p50_ms: toMetric(row.p50_ms),
      p90_ms: toMetric(row.p90_ms),
      p99_ms: toMetric(row.p99_ms),
      is_issue: issueActionSet.has(row.action),
    })),
    versions: input.versionRows.map(row => ({
      version_name: row.version_name,
      events: toCount(row.events),
      devices: toCount(row.devices),
      issue_count: toCount(row.issue_count),
      affected_devices: toCount(row.affected_devices),
      issue_free_rate: toCount(row.devices) > 0
        ? toMetric(((toCount(row.devices) - toCount(row.affected_devices)) / toCount(row.devices)) * 100, 1) ?? 0
        : 100,
      launch_p90_ms: toMetric(row.launch_p90_ms),
      webview_load_p90_ms: toMetric(row.webview_load_p90_ms),
    })),
    releaseMarkers: input.releaseMarkers,
  }
}

function buildNativeObservePluginResponse(pluginVersionRows: NativeObservePluginVersionRow[]) {
  return {
    pluginVersions: pluginVersionRows.map(row => ({
      plugin_version: row.plugin_version,
      devices: toCount(row.devices),
      total_devices: toCount(row.total_devices),
    })),
  }
}

async function readNativeObserveStats(c: Context<MiddlewareKeyVariables>, appId: string, days: NativeObservePeriodDays) {
  const endExclusive = dayjs().utc().add(1, 'day').startOf('day')
  const start = endExclusive.subtract(days, 'day')
  const endInclusive = endExclusive.subtract(1, 'millisecond')
  const labels = generateDateLabels(start.toDate(), endExclusive.subtract(1, 'day').toDate())
  const params = [appId, start.toISOString(), endExclusive.toISOString(), nativeObserveActions]
  const paramsWithIssues = [...params, issueActions]
  const db = getPgClient(c, true)

  try {
    const dailyResult = await db.query<NativeObserveMetricRow>(dailyStatsQuery, params)
    const actionResult = await db.query<NativeObserveMetricRow>(actionStatsQuery, params)
    const overviewResult = await db.query<NativeObserveOverviewRow>(overviewStatsQuery, paramsWithIssues)
    const versionResult = await db.query<NativeObserveVersionRow>(versionStatsQuery, paramsWithIssues)
    const releaseMarkersResult = await db.query<NativeObserveReleaseMarker>(releaseMarkersQuery, params.slice(0, 3))

    return buildNativeObserveResponse({
      labels,
      days,
      start: start.toISOString(),
      end: endInclusive.toISOString(),
      dailyRows: dailyResult.rows,
      actionRows: actionResult.rows,
      versionRows: versionResult.rows,
      overviewRow: overviewResult.rows[0],
      releaseMarkers: releaseMarkersResult.rows,
    })
  }
  catch (error) {
    logPgError(c, 'readNativeObserveStats', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

async function readNativeObservePluginStats(c: Context<MiddlewareKeyVariables>, appId: string) {
  const db = getPgClient(c, true)

  try {
    const pluginVersionResult = await db.query<NativeObservePluginVersionRow>(pluginVersionStatsQuery, [appId])
    return buildNativeObservePluginResponse(pluginVersionResult.rows)
  }
  catch (error) {
    logPgError(c, 'readNativeObservePluginStats', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<NativeObserveStatsRequest>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post native_observe_stats body', body })

  if (!body.app_id)
    throw simpleError('missing_params', 'app_id is required')

  const view = normalizeNativeObserveView(body.view)
  if (!view)
    throw simpleError('invalid_view', 'view must be global or plugins')

  const days = normalizeNativeObservePeriodDays(body.days)
  if (view === 'global' && !days)
    throw simpleError('invalid_days', 'days must be one of 1, 3, 7, or 30')

  if (!(await checkPermission(c, 'app.read', { appId: body.app_id })))
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })

  try {
    if (view === 'plugins')
      return c.json(await readNativeObservePluginStats(c, body.app_id))

    return c.json(await readNativeObserveStats(c, body.app_id, days as NativeObservePeriodDays))
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Error fetching native observe stats', error })
    throw simpleError('fetch_error', 'Failed to fetch native observe statistics', { error: String(error) })
  }
})

export const nativeObserveStatsTestUtils = {
  buildNativeObservePluginResponse,
  buildNativeObserveResponse,
  generateDateLabels,
  normalizeNativeObservePeriodDays,
  normalizeNativeObserveView,
}
