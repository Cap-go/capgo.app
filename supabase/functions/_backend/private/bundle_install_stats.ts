import type { Context } from 'hono'
import type { UpdateDeliveryTimingEventCF } from '../utils/cloudflare.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { HTTPException } from 'hono/http-exception'
import { Hono } from 'hono/tiny'
import { CacheHelper } from '../utils/cache.ts'
import { MAX_ANALYTICS_QUERY_LIMIT, parseStatsDurationMs, readUpdateDeliveryTimingEventsCF, resolveUpdateDeliveryTimingDurationMs } from '../utils/cloudflare.ts'
import { parseBody, simpleError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../utils/pg.ts'
import { checkPermission } from '../utils/rbac.ts'
import { getRollingStatsPeriod } from '../utils/statsPeriod.ts'
import { supabaseWithAuth } from '../utils/supabase.ts'

dayjs.extend(utc)

const maxInstallMs = 7_200_000
const pairingLookbackMs = 2 * 60 * 60 * 1000
const pairingLookbackHours = pairingLookbackMs / (60 * 60 * 1000)
const BUNDLE_INSTALL_STATS_CACHE_TTL_SECONDS = 300
const BUNDLE_INSTALL_STATS_CACHE_PATH = '/.bundle-install-stats'
const supportedPeriodDays = [1, 3, 7, 30] as const
type BundleInstallPeriodDays = typeof supportedPeriodDays[number]

const installEndActions = ['set'] as const
const installStartActions = ['download_0', 'download_zip_start', 'download_manifest_start'] as const
const installTimingActions = [...installEndActions, ...installStartActions] as const
const installEndActionSet = new Set<string>(installEndActions)
const installStartActionSet = new Set<string>(installStartActions)

const durationExpression = String.raw`CASE
  WHEN s.metadata ? 'duration_ms'
    AND s.metadata ->> 'duration_ms' ~ '^[0-9]+(\.[0-9]+)?$'
    AND char_length(s.metadata ->> 'duration_ms') <= 15
    THEN (s.metadata ->> 'duration_ms')::double precision
  WHEN s.metadata ? 'duration'
    AND s.metadata ->> 'duration' ~ '^[0-9]+(\.[0-9]+)?$'
    AND char_length(s.metadata ->> 'duration') <= 15
    THEN (s.metadata ->> 'duration')::double precision
  ELSE NULL
END`

interface BundleInstallStatsRequest {
  app_id: string
  days?: number
  channel_id?: number
  version_name?: string
}

interface BundleSuccessRow {
  version_name: string
  install: number | string
  fail: number | string
}

interface BundleTimingRow {
  version_name: string
  samples: number | string
  p50_ms: number | string | null
  p70_ms: number | string | null
  p90_ms: number | string | null
  p95_ms: number | string | null
}

export interface BundleInstallStatsItem {
  version_name: string
  install: number
  fail: number
  success_rate: number | null
  timing: {
    samples: number
    p50_ms: number | null
    p70_ms: number | null
    p90_ms: number | null
    p95_ms: number | null
  }
}

export interface BundleInstallStatsResponse {
  period: {
    requested_days: number
    actual_days: number
    start: string
    end: string
  }
  bundles: BundleInstallStatsItem[]
  totals: {
    install: number
    fail: number
    success_rate: number | null
  }
}

interface InstallTimingSample {
  version_name: string
  duration_ms: number
}

type NumericValue = number | string | null | undefined

function normalizePeriodDays(days: number | undefined = 30): BundleInstallPeriodDays | null {
  const requestedDays = days ?? 30
  if (!Number.isInteger(requestedDays) || !supportedPeriodDays.includes(requestedDays as BundleInstallPeriodDays))
    return null
  return requestedDays as BundleInstallPeriodDays
}

function toCount(value: NumericValue) {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function toMetric(value: NumericValue, decimals = 0) {
  if (value === null || value === undefined || value === '')
    return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric))
    return null
  const factor = 10 ** decimals
  return Math.round(numeric * factor) / factor
}

function computeSuccessRate(install: number, fail: number): number | null {
  const total = install + fail
  if (total <= 0)
    return null
  return Math.round((install / total) * 1000) / 10
}

function percentileCont(sorted: number[], q: number): number | null {
  if (!sorted.length)
    return null
  if (sorted.length === 1)
    return sorted[0]!
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper)
    return sorted[lower]!
  const weight = index - lower
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight
}

function isValidDuration(durationMs: number | null | undefined): durationMs is number {
  return typeof durationMs === 'number'
    && Number.isFinite(durationMs)
    && durationMs >= 0
    && durationMs <= maxInstallMs
}

function buildInstallTimingsFromEvents(
  events: UpdateDeliveryTimingEventCF[],
  options: {
    periodStartMs: number
    versionFilter?: Set<string>
  },
): InstallTimingSample[] {
  const startsByKey = new Map<string, number[]>()
  for (const event of events) {
    if (!installStartActionSet.has(event.action))
      continue
    const createdAtMs = Date.parse(event.created_at)
    if (!Number.isFinite(createdAtMs))
      continue
    const versionName = event.version_name || 'unknown'
    if (options.versionFilter && !options.versionFilter.has(versionName))
      continue
    const key = `${event.app_id}\0${event.device_id}\0${versionName}`
    const list = startsByKey.get(key)
    if (list)
      list.push(createdAtMs)
    else
      startsByKey.set(key, [createdAtMs])
  }
  for (const list of startsByKey.values())
    list.sort((a, b) => a - b)

  const samples: InstallTimingSample[] = []
  for (const event of events) {
    if (!installEndActionSet.has(event.action))
      continue
    const endMs = Date.parse(event.created_at)
    if (!Number.isFinite(endMs) || endMs < options.periodStartMs)
      continue

    const versionName = event.version_name || 'unknown'
    if (options.versionFilter && !options.versionFilter.has(versionName))
      continue

    let durationMs = resolveUpdateDeliveryTimingDurationMs(event)
    if (!isValidDuration(durationMs)) {
      const key = `${event.app_id}\0${event.device_id}\0${versionName}`
      const starts = startsByKey.get(key)
      if (starts?.length) {
        let matchedStart: number | null = null
        for (let i = starts.length - 1; i >= 0; i -= 1) {
          const startMs = starts[i]!
          if (startMs > endMs)
            continue
          if (endMs - startMs > pairingLookbackMs)
            break
          matchedStart = startMs
          break
        }
        if (matchedStart !== null)
          durationMs = endMs - matchedStart
      }
    }

    if (!isValidDuration(durationMs))
      continue

    samples.push({ version_name: versionName, duration_ms: durationMs })
  }

  return samples
}

function aggregateInstallTimingsByVersion(samples: InstallTimingSample[]) {
  const byVersion = new Map<string, number[]>()
  for (const sample of samples) {
    const list = byVersion.get(sample.version_name)
    if (list)
      list.push(sample.duration_ms)
    else
      byVersion.set(sample.version_name, [sample.duration_ms])
  }

  const rows = new Map<string, BundleTimingRow>()
  for (const [versionName, durations] of byVersion.entries()) {
    const sorted = [...durations].sort((a, b) => a - b)
    rows.set(versionName, {
      version_name: versionName,
      samples: sorted.length,
      p50_ms: percentileCont(sorted, 0.5),
      p70_ms: percentileCont(sorted, 0.7),
      p90_ms: percentileCont(sorted, 0.9),
      p95_ms: percentileCont(sorted, 0.95),
    })
  }
  return rows
}

function buildBundleInstallResponse(input: {
  days: BundleInstallPeriodDays
  start: string
  end: string
  successRows: BundleSuccessRow[]
  timingRows: Map<string, BundleTimingRow>
  versionFilter?: Set<string>
}): BundleInstallStatsResponse {
  const versionNames = new Set<string>()
  for (const row of input.successRows) {
    if (row.version_name)
      versionNames.add(row.version_name)
  }
  for (const versionName of input.timingRows.keys())
    versionNames.add(versionName)

  let names = [...versionNames]
  if (input.versionFilter)
    names = names.filter(name => input.versionFilter!.has(name))

  const successByVersion = new Map(input.successRows.map(row => [row.version_name, row]))
  const bundles: BundleInstallStatsItem[] = names.map((versionName) => {
    const success = successByVersion.get(versionName)
    const timing = input.timingRows.get(versionName)
    const install = toCount(success?.install)
    const fail = toCount(success?.fail)
    return {
      version_name: versionName,
      install,
      fail,
      success_rate: computeSuccessRate(install, fail),
      timing: {
        samples: toCount(timing?.samples),
        p50_ms: toMetric(timing?.p50_ms),
        p70_ms: toMetric(timing?.p70_ms),
        p90_ms: toMetric(timing?.p90_ms),
        p95_ms: toMetric(timing?.p95_ms),
      },
    }
  }).sort((a, b) => {
    const aTotal = a.install + a.fail
    const bTotal = b.install + b.fail
    if (bTotal !== aTotal)
      return bTotal - aTotal
    return a.version_name.localeCompare(b.version_name)
  })

  const totalInstall = bundles.reduce((sum, bundle) => sum + bundle.install, 0)
  const totalFail = bundles.reduce((sum, bundle) => sum + bundle.fail, 0)

  const endDate = dayjs(input.end).utc().startOf('day')
  const startDate = dayjs(input.start).utc().startOf('day')
  const actualDays = endDate.diff(startDate, 'day') + 1

  return {
    period: {
      requested_days: input.days,
      actual_days: Math.max(1, actualDays),
      start: input.start,
      end: input.end,
    },
    bundles,
    totals: {
      install: totalInstall,
      fail: totalFail,
      success_rate: computeSuccessRate(totalInstall, totalFail),
    },
  }
}

function buildSuccessRateQuery(hasVersionFilter: boolean) {
  const versionClause = hasVersionFilter ? '\n  AND version_name = ANY($4::text[])' : ''
  return `SELECT
  version_name,
  COALESCE(SUM(install), 0)::bigint AS install,
  COALESCE(SUM(fail), 0)::bigint AS fail
FROM public.daily_version
WHERE app_id = $1
  AND date >= $2::date
  AND date <= $3::date${versionClause}
GROUP BY version_name`
}

function buildInstallTimingQuery(hasVersionFilter: boolean) {
  const versionClause = hasVersionFilter
    ? `\n    AND COALESCE(NULLIF(s.version_name, ''), 'unknown') = ANY($6::text[])`
    : ''
  return `WITH scoped AS (
  SELECT
    s.app_id,
    s.device_id,
    COALESCE(NULLIF(s.version_name, ''), 'unknown') AS version_name,
    s.action,
    s.created_at,
    ${durationExpression} AS meta_duration_ms
  FROM public.stats s
  WHERE s.app_id = $1
    AND s.created_at >= ($2::timestamptz - INTERVAL '${pairingLookbackHours} hours')
    AND s.created_at < $3::timestamptz
    AND s.action = ANY($4::public.stats_action[])${versionClause}
),
installs AS (
  SELECT *
  FROM scoped
  WHERE action = 'set'
    AND created_at >= $2::timestamptz
),
starts AS (
  SELECT *
  FROM scoped
  WHERE action = ANY($5::public.stats_action[])
),
install_timings AS (
  SELECT
    i.version_name,
    COALESCE(
      i.meta_duration_ms,
      EXTRACT(EPOCH FROM (i.created_at - start_event.created_at)) * 1000
    ) AS duration_ms
  FROM installs i
  LEFT JOIN LATERAL (
    SELECT s.created_at
    FROM starts s
    WHERE s.app_id = i.app_id
      AND s.device_id = i.device_id
      AND s.version_name = i.version_name
      AND s.created_at <= i.created_at
      AND s.created_at > i.created_at - INTERVAL '${pairingLookbackHours} hours'
    ORDER BY s.created_at DESC
    LIMIT 1
  ) AS start_event ON TRUE
  WHERE COALESCE(
    i.meta_duration_ms,
    EXTRACT(EPOCH FROM (i.created_at - start_event.created_at)) * 1000
  ) IS NOT NULL
    AND COALESCE(
      i.meta_duration_ms,
      EXTRACT(EPOCH FROM (i.created_at - start_event.created_at)) * 1000
    ) >= 0
    AND COALESCE(
      i.meta_duration_ms,
      EXTRACT(EPOCH FROM (i.created_at - start_event.created_at)) * 1000
    ) <= ${maxInstallMs}
)
SELECT
  version_name,
  count(*)::integer AS samples,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.70) WITHIN GROUP (ORDER BY duration_ms) AS p70_ms,
  percentile_cont(0.90) WITHIN GROUP (ORDER BY duration_ms) AS p90_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms
FROM install_timings
GROUP BY version_name`
}

function filterResponseByVersionName(
  response: BundleInstallStatsResponse,
  versionName?: string,
): BundleInstallStatsResponse {
  if (!versionName)
    return response
  const bundles = response.bundles.filter(bundle => bundle.version_name === versionName)
  const totalInstall = bundles.reduce((sum, bundle) => sum + bundle.install, 0)
  const totalFail = bundles.reduce((sum, bundle) => sum + bundle.fail, 0)
  return {
    ...response,
    bundles,
    totals: {
      install: totalInstall,
      fail: totalFail,
      success_rate: computeSuccessRate(totalInstall, totalFail),
    },
  }
}

async function resolveChannelVersionFilter(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  channelId: number,
): Promise<Set<string>> {
  const auth = c.get('auth')
  if (!auth)
    throw simpleError('not_authenticated', 'Authentication required')

  const supabase = supabaseWithAuth(c, auth)
  const { data, error } = await supabase
    .from('deploy_history')
    .select('app_versions(name)')
    .eq('channel_id', channelId)
    .eq('app_id', appId)

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'bundle_install_stats deploy_history error', error })
    throw simpleError('fetch_error', 'Failed to fetch channel deployment history')
  }

  const versionNames = new Set<string>()
  for (const row of data ?? []) {
    const name = (row.app_versions as { name?: string } | null)?.name
    if (name)
      versionNames.add(name)
  }

  const { data: channelData } = await supabase
    .from('channels')
    .select('version:app_versions(name)')
    .eq('id', channelId)
    .eq('app_id', appId)
    .single()

  const currentName = (channelData?.version as { name?: string } | null)?.name
  if (currentName)
    versionNames.add(currentName)

  return versionNames
}

async function readInstallTimingEventsCFChunked(
  c: Context<MiddlewareKeyVariables>,
  params: {
    appId: string
    queryStart: dayjs.Dayjs
    endExclusive: dayjs.Dayjs
    versionNames?: string[]
  },
) {
  // One AE query per UTC day keeps the request bounded (≈ days+1 queries with
  // lookback). If a day still hits the 50k row cap, fail closed instead of
  // returning truncated percentiles or fanning into hundreds of sub-slices.
  const events: UpdateDeliveryTimingEventCF[] = []
  let cursor = params.queryStart.utc().startOf('day')
  const end = params.endExclusive.utc()

  while (cursor.isBefore(end)) {
    const next = cursor.add(1, 'day')
    const chunkEnd = next.isBefore(end) ? next : end
    const chunk = await readUpdateDeliveryTimingEventsCF(c, {
      start_date: cursor.toISOString(),
      end_date: chunkEnd.toISOString(),
      actions: [...installTimingActions],
      app_ids: [params.appId],
      version_names: params.versionNames,
    })
    if (chunk.length >= MAX_ANALYTICS_QUERY_LIMIT) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'bundle_install_stats timing day window capped',
        app_id: params.appId,
        start: cursor.toISOString(),
        end: chunkEnd.toISOString(),
        rows: chunk.length,
      })
      throw simpleError('fetch_error', 'Install timing sample set too large for this period')
    }
    events.push(...chunk)
    cursor = next
  }

  return events
}

async function readBundleInstallStatsSB(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  days: BundleInstallPeriodDays,
  start: dayjs.Dayjs,
  endExclusive: dayjs.Dayjs,
  endInclusive: dayjs.Dayjs,
  versionFilter?: Set<string>,
) {
  const db = getPgClient(c, true)
  try {
    const startDate = start.format('YYYY-MM-DD')
    const endDate = endInclusive.format('YYYY-MM-DD')
    const versionNames = versionFilter ? [...versionFilter] : undefined
    const hasVersionFilter = Boolean(versionNames?.length)

    const successParams: unknown[] = [appId, startDate, endDate]
    const timingParams: unknown[] = [
      appId,
      start.toISOString(),
      endExclusive.toISOString(),
      [...installTimingActions],
      [...installStartActions],
    ]
    if (hasVersionFilter) {
      successParams.push(versionNames)
      timingParams.push(versionNames)
    }

    const [successResult, timingResult] = await Promise.all([
      db.query<BundleSuccessRow>(buildSuccessRateQuery(hasVersionFilter), successParams),
      db.query<BundleTimingRow>(buildInstallTimingQuery(hasVersionFilter), timingParams),
    ])

    const timingRows = new Map<string, BundleTimingRow>()
    for (const row of timingResult.rows)
      timingRows.set(row.version_name, row)

    return buildBundleInstallResponse({
      days,
      start: start.toISOString(),
      end: endInclusive.toISOString(),
      successRows: successResult.rows,
      timingRows,
      versionFilter,
    })
  }
  catch (error) {
    logPgError(c, 'readBundleInstallStatsSB', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

async function readBundleInstallStatsCF(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  days: BundleInstallPeriodDays,
  start: dayjs.Dayjs,
  endExclusive: dayjs.Dayjs,
  endInclusive: dayjs.Dayjs,
  versionFilter?: Set<string>,
) {
  const queryStart = start.subtract(2, 'hour')
  const versionNames = versionFilter ? [...versionFilter] : undefined
  const events = await readInstallTimingEventsCFChunked(c, {
    appId,
    queryStart,
    endExclusive,
    versionNames,
  })

  const timingSamples = buildInstallTimingsFromEvents(events, {
    periodStartMs: start.valueOf(),
    versionFilter,
  })
  const timingRows = aggregateInstallTimingsByVersion(timingSamples)

  const auth = c.get('auth')
  if (!auth)
    throw simpleError('not_authenticated', 'Authentication required')

  const supabase = supabaseWithAuth(c, auth)
  const startDate = start.format('YYYY-MM-DD')
  const endDate = endInclusive.format('YYYY-MM-DD')

  let dailyQuery = supabase
    .from('daily_version')
    .select('version_name, install, fail')
    .eq('app_id', appId)
    .gte('date', startDate)
    .lte('date', endDate)
  if (versionNames?.length)
    dailyQuery = dailyQuery.in('version_name', versionNames)

  const { data: dailyRows, error } = await dailyQuery

  if (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'bundle_install_stats daily_version error', error })
    throw simpleError('fetch_error', 'Failed to fetch bundle success rates')
  }

  const successByVersion = new Map<string, { install: number, fail: number }>()
  for (const row of dailyRows ?? []) {
    if (!row.version_name)
      continue
    const current = successByVersion.get(row.version_name) ?? { install: 0, fail: 0 }
    current.install += toCount(row.install)
    current.fail += toCount(row.fail)
    successByVersion.set(row.version_name, current)
  }

  const successRows: BundleSuccessRow[] = [...successByVersion.entries()].map(([version_name, counts]) => ({
    version_name,
    install: counts.install,
    fail: counts.fail,
  }))

  if (timingRows.size === 0 && events.length > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'bundle_install_stats CF produced zero install timing samples',
      app_id: appId,
      event_count: events.length,
    })
  }

  return buildBundleInstallResponse({
    days,
    start: start.toISOString(),
    end: endInclusive.toISOString(),
    successRows,
    timingRows,
    versionFilter,
  })
}

async function readBundleInstallStats(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  days: BundleInstallPeriodDays,
  channelId?: number,
  versionName?: string,
) {
  const cache = new CacheHelper(c)
  // Exclude version_name from the cache key: filtering happens after lookup so
  // callers cannot cache-bust with unique version_name values.
  const cacheKey = cache.buildRequest(BUNDLE_INSTALL_STATS_CACHE_PATH, {
    appId,
    days: String(days),
    channelId: channelId ? String(channelId) : '',
  })
  const cached = await cache.matchJson<BundleInstallStatsResponse>(cacheKey)
  if (cached)
    return filterResponseByVersionName(cached, versionName)

  let versionFilter: Set<string> | undefined
  if (channelId) {
    versionFilter = await resolveChannelVersionFilter(c, appId, channelId)
    if (versionFilter.size === 0) {
      const emptyPeriod = getRollingStatsPeriod(days)
      const empty = buildBundleInstallResponse({
        days,
        start: emptyPeriod.start,
        end: emptyPeriod.endInclusive,
        successRows: [],
        timingRows: new Map(),
        versionFilter,
      })
      return filterResponseByVersionName(empty, versionName)
    }
  }

  const period = getRollingStatsPeriod(days)
  const start = dayjs(period.start)
  const endExclusive = dayjs(period.endExclusive)
  const endInclusive = dayjs(period.endInclusive)

  let response: BundleInstallStatsResponse
  if (c.env.APP_LOG) {
    try {
      response = await readBundleInstallStatsCF(c, appId, days, start, endExclusive, endInclusive, versionFilter)
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'CF bundle install stats failed, falling back to Postgres',
        error: serializeError(error),
        app_id: appId,
      })
      response = await readBundleInstallStatsSB(c, appId, days, start, endExclusive, endInclusive, versionFilter)
    }
  }
  else {
    response = await readBundleInstallStatsSB(c, appId, days, start, endExclusive, endInclusive, versionFilter)
  }

  if (response.bundles.length > 0)
    await cache.putJson(cacheKey, response, BUNDLE_INSTALL_STATS_CACHE_TTL_SECONDS)

  return filterResponseByVersionName(response, versionName)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<BundleInstallStatsRequest>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post bundle_install_stats body', body })

  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw simpleError('missing_params', 'app_id is required')

  if (typeof body.app_id !== 'string' || !body.app_id.trim())
    throw simpleError('missing_params', 'app_id is required')

  const appId = body.app_id.trim()
  const days = normalizePeriodDays(body.days)
  if (!days)
    throw simpleError('invalid_days', 'days must be one of 1, 3, 7, or 30')

  if (!(await checkPermission(c, 'app.read', { appId }))) {
    throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: appId })
  }

  const versionName = typeof body.version_name === 'string' && body.version_name.trim()
    ? body.version_name.trim()
    : undefined
  const channelId = typeof body.channel_id === 'number' && Number.isFinite(body.channel_id)
    ? body.channel_id
    : undefined

  try {
    return c.json(await readBundleInstallStats(c, appId, days, channelId, versionName))
  }
  catch (error) {
    if (error instanceof HTTPException)
      throw error
    cloudlog({ requestId: c.get('requestId'), message: 'Error fetching bundle install stats', error: serializeError(error) })
    throw simpleError('fetch_error', 'Failed to fetch bundle install statistics')
  }
})

export const bundleInstallStatsTestUtils = {
  normalizePeriodDays,
  computeSuccessRate,
  percentileCont,
  buildInstallTimingsFromEvents,
  aggregateInstallTimingsByVersion,
  buildBundleInstallResponse,
  filterResponseByVersionName,
  parseMetaDurationMs: parseStatsDurationMs,
}
