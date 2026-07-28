import type { Context } from 'hono'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

const MAX_DELIVERY_MS = 7_200_000
const END_ACTIONS = ['download_complete', 'download_zip_complete'] as const
const START_ACTIONS = ['download_0', 'download_zip_start', 'download_manifest_start'] as const
const TIMING_ACTIONS = [...END_ACTIONS, ...START_ACTIONS] as const
const PAIRING_EVENT_LIMIT = 50_000
const DURATION_MS_SQL = `if(
  double1 > 0 AND double1 <= 7200000,
  double1,
  toUInt32(
    if(
      position('"duration_ms":"' IN blob4) > 0,
      substring(blob4, position('"duration_ms":"' IN blob4) + 15, position('"' IN substring(blob4, position('"duration_ms":"' IN blob4) + 15)) - 1),
      if(
        position('"duration":"' IN blob4) > 0,
        substring(blob4, position('"duration":"' IN blob4) + 12, position('"' IN substring(blob4, position('"duration":"' IN blob4) + 12)) - 1),
        '0'
      )
    )
  )
)`

export type UpdateDeliveryCfScope = 'app' | 'org' | 'platform'

export interface UpdateDeliveryDailyRowCF {
  day: string
  samples: number
  p50_ms: number | null
  p75_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}

export interface UpdateDeliveryOverviewRowCF {
  samples: number
  devices: number
  p50_ms: number | null
  p75_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}

export interface UpdateDeliveryStatsCFResult {
  dailyRows: UpdateDeliveryDailyRowCF[]
  overviewRow: UpdateDeliveryOverviewRowCF
}

interface DeliveryAggRow {
  day?: string
  samples: number | string
  devices?: number | string
  p50_ms: number | string | null
  p75_ms: number | string | null
  p95_ms: number | string | null
  p99_ms: number | string | null
}

interface TimingEventRow {
  app_id: string
  device_id: string
  version_name: string
  action: string
  metadata: string
  created_at: string | Date
  double1: number | string | null
}

function canQueryAppLog(c: Context) {
  return Boolean(
    c.env.APP_LOG
    && getEnv(c, 'CF_ANALYTICS_TOKEN')
    && getEnv(c, 'CF_ACCOUNT_ANALYTICS_ID'),
  )
}

function buildAppFilter(appIds?: string[]) {
  if (!appIds)
    return ''
  if (appIds.length === 0)
    return 'AND 1 = 0'
  if (appIds.length === 1)
    return `AND index1 = '${escapeSqlString(appIds[0])}'`
  const list = appIds.map(id => `'${escapeSqlString(id)}'`).join(',')
  return `AND index1 IN (${list})`
}

function toCount(value: number | string | null | undefined) {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function toMetric(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === '')
    return null
  const numeric = Number(value)
  if (!Number.isFinite(numeric))
    return null
  return Math.round(numeric)
}

function emptyOverview(): UpdateDeliveryOverviewRowCF {
  return {
    samples: 0,
    devices: 0,
    p50_ms: null,
    p75_ms: null,
    p95_ms: null,
    p99_ms: null,
  }
}

function percentile(sorted: number[], q: number) {
  if (sorted.length === 0)
    return null
  if (sorted.length === 1)
    return sorted[0]
  const index = (sorted.length - 1) * q
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper)
    return sorted[lower]
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

function parseDurationFromMetadata(metadata: string, double1: number | string | null | undefined) {
  const fromDouble = Number(double1)
  if (Number.isFinite(fromDouble) && fromDouble > 0 && fromDouble <= MAX_DELIVERY_MS)
    return fromDouble
  if (!metadata)
    return null
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>
    for (const key of ['duration_ms', 'duration']) {
      const raw = parsed[key]
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 15)
        continue
      if (!/^[0-9]+(\.[0-9]+)?$/.test(raw))
        continue
      const value = Number(raw)
      if (Number.isFinite(value) && value >= 0 && value <= MAX_DELIVERY_MS)
        return value
    }
  }
  catch {
    // ignore malformed metadata
  }
  return null
}

function dayKeyUTC(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime()))
    return null
  return date.toISOString().slice(0, 10)
}

function aggregateDeliveries(samples: Array<{ day: string, app_id: string, device_id: string, duration_ms: number }>): UpdateDeliveryStatsCFResult {
  if (samples.length === 0) {
    return { dailyRows: [], overviewRow: emptyOverview() }
  }

  const byDay = new Map<string, number[]>()
  const devices = new Set<string>()
  const all: number[] = []
  for (const sample of samples) {
    devices.add(`${sample.app_id}:${sample.device_id}`)
    all.push(sample.duration_ms)
    const list = byDay.get(sample.day) ?? []
    list.push(sample.duration_ms)
    byDay.set(sample.day, list)
  }

  const dailyRows: UpdateDeliveryDailyRowCF[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, values]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return {
        day,
        samples: sorted.length,
        p50_ms: toMetric(percentile(sorted, 0.5)),
        p75_ms: toMetric(percentile(sorted, 0.75)),
        p95_ms: toMetric(percentile(sorted, 0.95)),
        p99_ms: toMetric(percentile(sorted, 0.99)),
      }
    })

  const overviewSorted = [...all].sort((a, b) => a - b)
  return {
    dailyRows,
    overviewRow: {
      samples: overviewSorted.length,
      devices: devices.size,
      p50_ms: toMetric(percentile(overviewSorted, 0.5)),
      p75_ms: toMetric(percentile(overviewSorted, 0.75)),
      p95_ms: toMetric(percentile(overviewSorted, 0.95)),
      p99_ms: toMetric(percentile(overviewSorted, 0.99)),
    },
  }
}

function pairTimingEvents(rows: TimingEventRow[]) {
  const endSet = new Set<string>(END_ACTIONS)
  const startSet = new Set<string>(START_ACTIONS)
  const starts = rows
    .filter(row => startSet.has(row.action))
    .map(row => ({
      ...row,
      at: new Date(row.created_at).getTime(),
      version: row.version_name || 'unknown',
    }))
    .filter(row => Number.isFinite(row.at))
    .sort((a, b) => a.at - b.at)

  const ends = rows
    .filter(row => endSet.has(row.action))
    .map(row => ({
      ...row,
      at: new Date(row.created_at).getTime(),
      version: row.version_name || 'unknown',
    }))
    .filter(row => Number.isFinite(row.at))

  const samples: Array<{ day: string, app_id: string, device_id: string, duration_ms: number }> = []
  for (const end of ends) {
    const metaDuration = parseDurationFromMetadata(rowMetadata(end.metadata), end.double1)
    let duration = metaDuration
    if (duration === null) {
      let matchedStart: number | null = null
      for (let i = starts.length - 1; i >= 0; i -= 1) {
        const start = starts[i]
        if (start.app_id !== end.app_id || start.device_id !== end.device_id || start.version !== end.version)
          continue
        if (start.at > end.at)
          continue
        if (end.at - start.at > 2 * 60 * 60 * 1000)
          continue
        matchedStart = start.at
        break
      }
      if (matchedStart !== null)
        duration = end.at - matchedStart
    }
    if (duration === null || duration < 0 || duration > MAX_DELIVERY_MS)
      continue
    const day = dayKeyUTC(end.created_at)
    if (!day)
      continue
    samples.push({
      day,
      app_id: end.app_id,
      device_id: end.device_id,
      duration_ms: duration,
    })
  }
  return aggregateDeliveries(samples)
}

function rowMetadata(metadata: string) {
  return typeof metadata === 'string' ? metadata : ''
}

async function readMetadataDurationStatsCF(
  c: Context,
  start: Date | string,
  end: Date | string,
  appIds?: string[],
): Promise<UpdateDeliveryStatsCFResult> {
  const appFilter = buildAppFilter(appIds)
  const startFilter = formatDateCF(start)
  const endFilter = formatDateCF(end)
  const endActionsSql = END_ACTIONS.map(action => `'${escapeSqlString(action)}'`).join(', ')
  const dayExpr = `formatDateTime(toStartOfInterval(timestamp, INTERVAL '1' DAY), '%Y-%m-%d')`
  const baseFrom = `
FROM (
  SELECT
    ${dayExpr} AS day,
    index1 AS app_id,
    blob1 AS device_id,
    (${DURATION_MS_SQL}) AS duration_ms,
    _sample_interval AS weight
  FROM app_log
  WHERE timestamp >= toDateTime('${startFilter}')
    AND timestamp < toDateTime('${endFilter}')
    AND blob2 IN (${endActionsSql})
    ${appFilter}
)
WHERE duration_ms > 0
  AND duration_ms <= ${MAX_DELIVERY_MS}`

  const dailyQuery = `
SELECT
  day,
  sum(weight) AS samples,
  quantileExactWeighted(0.50)(duration_ms, weight) AS p50_ms,
  quantileExactWeighted(0.75)(duration_ms, weight) AS p75_ms,
  quantileExactWeighted(0.95)(duration_ms, weight) AS p95_ms,
  quantileExactWeighted(0.99)(duration_ms, weight) AS p99_ms
${baseFrom}
GROUP BY day
ORDER BY day`

  const overviewQuery = `
SELECT
  sum(weight) AS samples,
  count(DISTINCT format('{}:{}', app_id, device_id)) AS devices,
  quantileExactWeighted(0.50)(duration_ms, weight) AS p50_ms,
  quantileExactWeighted(0.75)(duration_ms, weight) AS p75_ms,
  quantileExactWeighted(0.95)(duration_ms, weight) AS p95_ms,
  quantileExactWeighted(0.99)(duration_ms, weight) AS p99_ms
${baseFrom}`

  const [dailyRaw, overviewRaw] = await Promise.all([
    runQueryToCFA<DeliveryAggRow>(c, dailyQuery),
    runQueryToCFA<DeliveryAggRow>(c, overviewQuery),
  ])

  const dailyRows = dailyRaw.map(row => ({
    day: String(row.day ?? ''),
    samples: toCount(row.samples),
    p50_ms: toMetric(row.p50_ms),
    p75_ms: toMetric(row.p75_ms),
    p95_ms: toMetric(row.p95_ms),
    p99_ms: toMetric(row.p99_ms),
  })).filter(row => row.day)

  const overview = overviewRaw[0]
  return {
    dailyRows,
    overviewRow: overview
      ? {
          samples: toCount(overview.samples),
          devices: toCount(overview.devices),
          p50_ms: toMetric(overview.p50_ms),
          p75_ms: toMetric(overview.p75_ms),
          p95_ms: toMetric(overview.p95_ms),
          p99_ms: toMetric(overview.p99_ms),
        }
      : emptyOverview(),
  }
}

async function readPairedTimingStatsCF(
  c: Context,
  start: Date | string,
  end: Date | string,
  appIds?: string[],
): Promise<UpdateDeliveryStatsCFResult> {
  const appFilter = buildAppFilter(appIds)
  const startFilter = formatDateCF(
    typeof start === 'string' ? new Date(new Date(start).getTime() - 2 * 60 * 60 * 1000) : new Date(start.getTime() - 2 * 60 * 60 * 1000),
  )
  const endFilter = formatDateCF(end)
  const actionsSql = TIMING_ACTIONS.map(action => `'${escapeSqlString(action)}'`).join(', ')
  const query = `
SELECT
  index1 AS app_id,
  blob1 AS device_id,
  blob3 AS version_name,
  blob2 AS action,
  blob4 AS metadata,
  double1,
  timestamp AS created_at
FROM app_log
WHERE timestamp >= toDateTime('${startFilter}')
  AND timestamp < toDateTime('${endFilter}')
  AND blob2 IN (${actionsSql})
  ${appFilter}
ORDER BY timestamp DESC
LIMIT ${PAIRING_EVENT_LIMIT}`

  const rows = await runQueryToCFA<TimingEventRow>(c, query)
  return pairTimingEvents(rows)
}

export async function readUpdateDeliveryStatsCF(
  c: Context,
  params: {
    scope: UpdateDeliveryCfScope
    appIds?: string[]
    start: Date | string
    end: Date | string
  },
): Promise<UpdateDeliveryStatsCFResult | null> {
  if (!canQueryAppLog(c))
    return null

  try {
    const metadataStats = await readMetadataDurationStatsCF(c, params.start, params.end, params.appIds)
    if (metadataStats.overviewRow.samples > 0 || params.scope === 'platform')
      return metadataStats

    // App/org: also try start/end pairing when duration metadata is absent.
    return await readPairedTimingStatsCF(c, params.start, params.end, params.appIds)
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'readUpdateDeliveryStatsCF failed',
      error: serializeError(error),
      scope: params.scope,
    })
    throw error
  }
}

export const updateDeliveryStatsCfTestUtils = {
  parseDurationFromMetadata,
  percentile,
  pairTimingEvents,
  aggregateDeliveries,
}
