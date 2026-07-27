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
import { supabaseClient as useSupabaseClient } from '../utils/supabase.ts'

dayjs.extend(utc)

const maxPeriodDays = 365
type UpdateDeliveryPeriodDays = number
type UpdateDeliveryScope = 'app' | 'org' | 'platform'

interface UpdateDeliveryStatsRequest {
  scope?: UpdateDeliveryScope
  app_id?: string
  org_id?: string
  days?: number
}

interface UpdateDeliveryDailyRow {
  day: string
  samples: number | string
  p50_ms: number | string | null
  p75_ms: number | string | null
  p95_ms: number | string | null
  p99_ms: number | string | null
}

interface UpdateDeliveryOverviewRow {
  samples: number | string
  devices: number | string
  p50_ms: number | string | null
  p75_ms: number | string | null
  p95_ms: number | string | null
  p99_ms: number | string | null
}

type NumericValue = number | string | null | undefined

const endActions = ['download_complete', 'download_zip_complete'] as const
const startActions = ['download_0', 'download_zip_start', 'download_manifest_start'] as const
const timingActions = [...endActions, ...startActions] as const

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

function buildScopedDeliveriesCte(scope: UpdateDeliveryScope) {
  const appFilter = scope === 'app'
    ? 'AND s.app_id = $1'
    : scope === 'org'
      ? 'AND s.app_id IN (SELECT apps.app_id FROM public.apps WHERE apps.owner_org = $1)'
      : ''

  // Platform stays metadata-only to avoid unbounded start/end pairing across all apps.
  if (scope === 'platform') {
    return `WITH deliveries AS (
  SELECT
    to_char(date_trunc('day', s.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
    s.app_id,
    s.device_id,
    duration_ms
  FROM (
    SELECT
      s.created_at,
      s.app_id,
      s.device_id,
      ${durationExpression} AS duration_ms
    FROM public.stats s
    WHERE s.created_at >= $1::timestamptz
      AND s.created_at < $2::timestamptz
      AND s.action = ANY($3::public.stats_action[])
  ) s
  WHERE duration_ms IS NOT NULL
    AND duration_ms >= 0
    AND duration_ms <= 7200000
)`
  }

  return `WITH scoped AS (
  SELECT
    s.app_id,
    s.device_id,
    COALESCE(NULLIF(s.version_name, ''), 'unknown') AS version_name,
    s.action,
    s.created_at,
    ${durationExpression} AS meta_duration_ms
  FROM public.stats s
  WHERE s.created_at >= ($2::timestamptz - INTERVAL '2 hours')
    AND s.created_at < $3::timestamptz
    AND s.action = ANY($4::public.stats_action[])
    ${appFilter}
),
ends AS (
  SELECT *
  FROM scoped
  WHERE action = ANY($5::public.stats_action[])
    AND created_at >= $2::timestamptz
),
starts AS (
  SELECT *
  FROM scoped
  WHERE action = ANY($6::public.stats_action[])
),
deliveries AS (
  SELECT
    to_char(date_trunc('day', e.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
    e.app_id,
    e.device_id,
    COALESCE(
      e.meta_duration_ms,
      EXTRACT(EPOCH FROM (e.created_at - start_event.created_at)) * 1000
    ) AS duration_ms
  FROM ends e
  LEFT JOIN LATERAL (
    SELECT s.created_at
    FROM starts s
    WHERE s.app_id = e.app_id
      AND s.device_id = e.device_id
      AND s.version_name = e.version_name
      AND s.created_at <= e.created_at
      AND s.created_at > e.created_at - INTERVAL '2 hours'
    ORDER BY s.created_at DESC
    LIMIT 1
  ) AS start_event ON TRUE
  WHERE COALESCE(
    e.meta_duration_ms,
    EXTRACT(EPOCH FROM (e.created_at - start_event.created_at)) * 1000
  ) IS NOT NULL
    AND COALESCE(
      e.meta_duration_ms,
      EXTRACT(EPOCH FROM (e.created_at - start_event.created_at)) * 1000
    ) >= 0
    AND COALESCE(
      e.meta_duration_ms,
      EXTRACT(EPOCH FROM (e.created_at - start_event.created_at)) * 1000
    ) <= 7200000
)`
}

function buildStatsQuery(scope: UpdateDeliveryScope) {
  // One deliveries CTE shared by daily + overview so platform/org/app avoid a second full scan.
  return `${buildScopedDeliveriesCte(scope)},
daily AS (
  SELECT
    day,
    count(*)::integer AS samples,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms) AS p75_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
  FROM deliveries
  GROUP BY day
),
overview AS (
  SELECT
    count(*)::integer AS samples,
    count(DISTINCT (app_id, device_id))::integer AS devices,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms) AS p75_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
  FROM deliveries
)
SELECT
  COALESCE(
    (SELECT json_agg(row_to_json(d) ORDER BY d.day) FROM daily d),
    '[]'::json
  ) AS daily,
  COALESCE(
    (SELECT row_to_json(o) FROM overview o),
    json_build_object(
      'samples', 0,
      'devices', 0,
      'p50_ms', null,
      'p75_ms', null,
      'p95_ms', null,
      'p99_ms', null
    )
  ) AS overview`
}

function normalizePeriodDays(days: number | undefined = 7): UpdateDeliveryPeriodDays | null {
  if (!Number.isInteger(days) || days < 1 || days > maxPeriodDays)
    return null
  return days as UpdateDeliveryPeriodDays
}

function normalizeScope(value: unknown): UpdateDeliveryScope | null {
  if (value === undefined || value === 'app')
    return 'app'
  if (value === 'org' || value === 'platform')
    return value
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

function buildUpdateDeliveryResponse(input: {
  labels: string[]
  days: UpdateDeliveryPeriodDays
  start: string
  end: string
  scope: UpdateDeliveryScope
  dailyRows: UpdateDeliveryDailyRow[]
  overviewRow: UpdateDeliveryOverviewRow | undefined
}) {
  const labelIndex = new Map(input.labels.map((label, index) => [label, index]))
  const samples = Array.from({ length: input.labels.length }).fill(0)
  const p50 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const p75 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const p95 = Array.from<number | null>({ length: input.labels.length }).fill(null)
  const p99 = Array.from<number | null>({ length: input.labels.length }).fill(null)

  for (const row of input.dailyRows) {
    const index = labelIndex.get(row.day)
    if (index === undefined)
      continue
    samples[index] = toCount(row.samples)
    p50[index] = toMetric(row.p50_ms)
    p75[index] = toMetric(row.p75_ms)
    p95[index] = toMetric(row.p95_ms)
    p99[index] = toMetric(row.p99_ms)
  }

  const overview = input.overviewRow ?? {
    samples: 0,
    devices: 0,
    p50_ms: null,
    p75_ms: null,
    p95_ms: null,
    p99_ms: null,
  }

  return {
    scope: input.scope,
    labels: input.labels,
    period: {
      requested_days: input.days,
      actual_days: input.labels.length,
      start: input.start,
      end: input.end,
    },
    overview: {
      samples: toCount(overview.samples),
      devices: toCount(overview.devices),
      p50_ms: toMetric(overview.p50_ms),
      p75_ms: toMetric(overview.p75_ms),
      p95_ms: toMetric(overview.p95_ms),
      p99_ms: toMetric(overview.p99_ms),
    },
    daily: {
      samples,
      p50_ms: p50,
      p75_ms: p75,
      p95_ms: p95,
      p99_ms: p99,
    },
  }
}

async function assertPlatformAdmin(c: Context<MiddlewareKeyVariables>) {
  const authToken = c.req.header('authorization')
  if (!authToken)
    throw simpleError('not_authorized', 'Not authorized')

  const supabaseClient = useSupabaseClient(c, authToken)
  const { data: isAdmin, error: adminError } = await supabaseClient.rpc('is_platform_admin')
  if (adminError) {
    cloudlog({ requestId: c.get('requestId'), message: 'is_admin_error', error: adminError })
    throw simpleError('is_admin_error', 'Is admin error', { adminError })
  }
  if (!isAdmin)
    throw simpleError('not_admin', 'Not admin - only admin users can access platform delivery latency')
}

async function readUpdateDeliveryStats(
  c: Context<MiddlewareKeyVariables>,
  scope: UpdateDeliveryScope,
  days: UpdateDeliveryPeriodDays,
  scopeId?: string,
) {
  const endExclusive = dayjs().utc().add(1, 'day').startOf('day')
  const start = endExclusive.subtract(days, 'day')
  const endInclusive = endExclusive.subtract(1, 'millisecond')
  const labels = generateDateLabels(start.toDate(), endExclusive.subtract(1, 'day').toDate())
  const db = getPgClient(c, true)

  try {
    const query = buildStatsQuery(scope)
    const params = scope === 'platform'
      ? [start.toISOString(), endExclusive.toISOString(), [...endActions]]
      : [scopeId, start.toISOString(), endExclusive.toISOString(), [...timingActions], [...endActions], [...startActions]]

    const result = await db.query<{
      daily: UpdateDeliveryDailyRow[] | string
      overview: UpdateDeliveryOverviewRow | string
    }>(query, params)

    const row = result.rows[0]
    const dailyRows = typeof row?.daily === 'string'
      ? JSON.parse(row.daily) as UpdateDeliveryDailyRow[]
      : (row?.daily ?? [])
    const overviewRow = typeof row?.overview === 'string'
      ? JSON.parse(row.overview) as UpdateDeliveryOverviewRow
      : row?.overview

    return buildUpdateDeliveryResponse({
      labels,
      days,
      start: start.toISOString(),
      end: endInclusive.toISOString(),
      scope,
      dailyRows: Array.isArray(dailyRows) ? dailyRows : [],
      overviewRow: overviewRow ?? undefined,
    })
  }
  catch (error) {
    logPgError(c, 'readUpdateDeliveryStats', error)
    throw error
  }
  finally {
    await closeClient(c, db)
  }
}

export const app = new Hono<MiddlewareKeyVariables>()

app.use('/', useCors)

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<UpdateDeliveryStatsRequest>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post update_delivery_stats body', body })

  const scope = normalizeScope(body.scope)
  if (!scope)
    throw simpleError('invalid_scope', 'scope must be app, org, or platform')

  const days = normalizePeriodDays(body.days)
  if (!days)
    throw simpleError('invalid_days', `days must be an integer from 1 to ${maxPeriodDays}`)

  if (scope === 'platform') {
    await assertPlatformAdmin(c)
    try {
      return c.json(await readUpdateDeliveryStats(c, scope, days))
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'Error fetching platform update delivery stats', error })
      throw simpleError('fetch_error', 'Failed to fetch update delivery statistics', { error: String(error) })
    }
  }

  if (scope === 'app') {
    if (!body.app_id)
      throw simpleError('missing_params', 'app_id is required for app scope')
    if (!(await checkPermission(c, 'app.read', { appId: body.app_id })))
      throw simpleError('app_access_denied', 'You can\'t access this app', { app_id: body.app_id })
    try {
      return c.json(await readUpdateDeliveryStats(c, scope, days, body.app_id))
    }
    catch (error) {
      cloudlog({ requestId: c.get('requestId'), message: 'Error fetching app update delivery stats', error })
      throw simpleError('fetch_error', 'Failed to fetch update delivery statistics', { error: String(error) })
    }
  }

  if (!body.org_id)
    throw simpleError('missing_params', 'org_id is required for org scope')
  if (!(await checkPermission(c, 'org.read', { orgId: body.org_id })))
    throw simpleError('org_access_denied', 'You can\'t access this organization', { org_id: body.org_id })

  try {
    return c.json(await readUpdateDeliveryStats(c, scope, days, body.org_id))
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'Error fetching org update delivery stats', error })
    throw simpleError('fetch_error', 'Failed to fetch update delivery statistics', { error: String(error) })
  }
})

export const updateDeliveryStatsTestUtils = {
  buildUpdateDeliveryResponse,
  generateDateLabels,
  normalizePeriodDays,
  normalizeScope,
  toMetric,
}
