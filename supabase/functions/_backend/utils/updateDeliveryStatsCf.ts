import type { Context } from 'hono'
import { escapeSqlString, formatDateCF, runQueryToCFA } from './cloudflare.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { getEnv } from './utils.ts'

const MAX_DELIVERY_MS = 7_200_000
const END_ACTIONS = ['download_complete', 'download_zip_complete'] as const
const START_ACTIONS = ['download_0', 'download_zip_start', 'download_manifest_start'] as const
const TIMING_ACTIONS = [...END_ACTIONS, ...START_ACTIONS] as const
const PAIRING_EVENT_LIMIT = 50_000
// Prefer double1 when present (>0). Fallback to blob4 JSON string extract (includes 0).
// Sentinel -1 means "no duration" so zero-duration metadata is not confused with missing.
const DURATION_MS_SQL = `if(
  double1 > 0 AND double1 <= 7200000,
  double1,
  toInt64(
    if(
      position('"duration_ms":"' IN blob4) > 0,
      substring(blob4, position('"duration_ms":"' IN blob4) + 15, position('"' IN substring(blob4, position('"duration_ms":"' IN blob4) + 15)) - 1),
      if(
        position('"duration":"' IN blob4) > 0,
        substring(blob4, position('"duration":"' IN blob4) + 12, position('"' IN substring(blob4, position('"duration":"' IN blob4) + 12)) - 1),
        '-1'
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
  /** Exact from pairing; null for AE metadata aggregates (distinct is not sampling-safe). */
  devices: number | null
  p50_ms: number | null
  p75_ms: number | null
  p95_ms: number | null
  p99_ms: number | null
}

export interface UpdateDeliveryStatsCFResult {
  dailyRows: UpdateDeliveryDailyRowCF[]
  overviewRow: UpdateDeliveryOverviewRowCF
}

type NumericValue = number | string | null | undefined

interface DeliveryAggRow {
  day?: string
  samples: number | string
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

function toCount(value: NumericValue) {
  const numeric = Number(value ?? 0)
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : 0
}

function toMetric(value: NumericValue) {
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

function parseDurationFromMetadata(metadata: string, double1: NumericValue) {
  // double1 defaults to 0 when unset in AE — only trust strictly positive doubles.
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
      if (!/^\d+(\.\d+)?$/.test(raw))
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

interface TimedEvent extends TimingEventRow {
  at: number
  version: string
}

function toTimedEvents(rows: TimingEventRow[], actions: readonly string[]) {
  const actionSet = new Set<string>(actions)
  return rows
    .filter(row => actionSet.has(row.action))
    .map(row => ({
      ...row,
      at: new Date(row.created_at).getTime(),
      version: row.version_name || 'unknown',
    }))
    .filter(row => Number.isFinite(row.at))
}

function findLatestStartBefore(starts: TimedEvent[], end: TimedEvent) {
  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const start = starts[i]
    if (start.app_id !== end.app_id || start.device_id !== end.device_id || start.version !== end.version)
      continue
    if (start.at > end.at || end.at - start.at > 2 * 60 * 60 * 1000)
      continue
    return start.at
  }
  return null
}

function resolveDeliveryDuration(end: TimedEvent, starts: TimedEvent[]) {
  const metaDuration = parseDurationFromMetadata(rowMetadata(end.metadata), end.double1)
  if (metaDuration !== null)
    return metaDuration
  const matchedStart = findLatestStartBefore(starts, end)
  return matchedStart === null ? null : end.at - matchedStart
}

function pairTimingEvents(
  rows: TimingEventRow[],
  options?: {
    periodStartMs?: number
    legacyOnly?: boolean
  },
) {
  const starts = toTimedEvents(rows, START_ACTIONS).sort((a, b) => a.at - b.at)
  const ends = toTimedEvents(rows, END_ACTIONS)
  const samples: Array<{ day: string, app_id: string, device_id: string, duration_ms: number }> = []
  const periodStartMs = options?.periodStartMs
  const legacyOnly = options?.legacyOnly === true

  for (const end of ends) {
    if (periodStartMs !== undefined && end.at < periodStartMs)
      continue
    const metaDuration = parseDurationFromMetadata(rowMetadata(end.metadata), end.double1)
    if (legacyOnly && metaDuration !== null)
      continue
    const duration = legacyOnly
      ? (() => {
          const matchedStart = findLatestStartBefore(starts, end)
          return matchedStart === null ? null : end.at - matchedStart
        })()
      : resolveDeliveryDuration(end, starts)
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

function mixMetric(a: number | null, b: number | null, aN: number, bN: number) {
  if (a === null)
    return b
  if (b === null)
    return a
  return Math.round((a * aN + b * bN) / (aN + bN))
}

function mergeDeliveryStats(
  primary: UpdateDeliveryStatsCFResult,
  secondary: UpdateDeliveryStatsCFResult,
): UpdateDeliveryStatsCFResult {
  if (secondary.overviewRow.samples === 0)
    return primary
  if (primary.overviewRow.samples === 0)
    return secondary

  const byDay = new Map<string, { samples: number, p50: number | null, p75: number | null, p95: number | null, p99: number | null }>()
  for (const row of [...primary.dailyRows, ...secondary.dailyRows]) {
    const prev = byDay.get(row.day)
    if (!prev) {
      byDay.set(row.day, {
        samples: row.samples,
        p50: row.p50_ms,
        p75: row.p75_ms,
        p95: row.p95_ms,
        p99: row.p99_ms,
      })
      continue
    }
    byDay.set(row.day, {
      samples: prev.samples + row.samples,
      p50: mixMetric(prev.p50, row.p50_ms, prev.samples, row.samples),
      p75: mixMetric(prev.p75, row.p75_ms, prev.samples, row.samples),
      p95: mixMetric(prev.p95, row.p95_ms, prev.samples, row.samples),
      p99: mixMetric(prev.p99, row.p99_ms, prev.samples, row.samples),
    })
  }

  const dailyRows: UpdateDeliveryDailyRowCF[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, row]) => ({
      day,
      samples: row.samples,
      p50_ms: row.p50,
      p75_ms: row.p75,
      p95_ms: row.p95,
      p99_ms: row.p99,
    }))

  const a = primary.overviewRow
  const b = secondary.overviewRow
  const total = a.samples + b.samples

  return {
    dailyRows,
    overviewRow: {
      samples: total,
      devices: a.devices === null || b.devices === null
        ? null
        : a.devices + b.devices,
      p50_ms: mixMetric(a.p50_ms, b.p50_ms, a.samples, b.samples),
      p75_ms: mixMetric(a.p75_ms, b.p75_ms, a.samples, b.samples),
      p95_ms: mixMetric(a.p95_ms, b.p95_ms, a.samples, b.samples),
      p99_ms: mixMetric(a.p99_ms, b.p99_ms, a.samples, b.samples),
    },
  }
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
WHERE duration_ms >= 0
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

  // Omit distinct devices: AE sampling makes count(DISTINCT ...) under-report.
  const overviewQuery = `
SELECT
  sum(weight) AS samples,
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
          devices: null,
          p50_ms: toMetric(overview.p50_ms),
          p75_ms: toMetric(overview.p75_ms),
          p95_ms: toMetric(overview.p95_ms),
          p99_ms: toMetric(overview.p99_ms),
        }
      : emptyOverview(),
  }
}

function toDate(value: Date | string) {
  return typeof value === 'string' ? new Date(value) : value
}

async function readPairedTimingStatsCF(
  c: Context,
  start: Date | string,
  end: Date | string,
  appIds?: string[],
  legacyOnly = false,
): Promise<UpdateDeliveryStatsCFResult> {
  const appFilter = buildAppFilter(appIds)
  const periodStart = toDate(start)
  const startFilter = formatDateCF(new Date(periodStart.getTime() - 2 * 60 * 60 * 1000))
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
  return pairTimingEvents(rows, {
    periodStartMs: periodStart.getTime(),
    legacyOnly,
  })
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
    if (params.scope === 'platform')
      return metadataStats

    // Always add legacy start/end pairs for completions without duration metadata.
    const legacyStats = await readPairedTimingStatsCF(c, params.start, params.end, params.appIds, true)
    return mergeDeliveryStats(metadataStats, legacyStats)
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
  mergeDeliveryStats,
}
