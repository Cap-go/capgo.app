import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PgClient } from '../utils/pg.ts'
import { Hono } from 'hono/tiny'
import { middlewareAPISecret, parseBody, simpleError, useCors } from '../utils/hono.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { isTransientDatabaseError } from '../utils/pg_errors.ts'
import { queryJson } from '../utils/pg_rls.ts'
import { getRetryablePostgrestStatus, isRetryablePostgrestError, isRetryablePostgrestResult, isRetryablePostgrestStatus, retryWithBackoff } from '../utils/retry.ts'
import { readStatsBandwidth, readStatsMau, readStatsStorage, readStatsVersion } from '../utils/stats.ts'

interface DataToGet {
  appId?: string
  orgId?: string
  todayOnly?: boolean
  currentHour?: string
}

export const app = new Hono<MiddlewareKeyVariables>()

const SUPABASE_RETRY_ATTEMPTS = 3
const SUPABASE_RETRY_DELAY_MS = 300

interface SupabaseRetryResult<T> {
  data: T | null
  error: unknown
  status?: number | null
}

interface CycleInfo {
  subscription_anchor_start: string | null
  subscription_anchor_end: string | null
}

interface AppOwnerOrgRow {
  owner_org: string
}

interface VersionNameRow {
  id: number
  name: string
}

interface VersionMetaStorageRow {
  timestamp: string | Date
  version_id: number
  size: number
}

interface StorageVersionLifetime {
  addedAt?: number
  removedAt?: number
  size?: number
}

interface StorageHourlyRow {
  app_id: string
  owner_org: string
  date: string
  storage_byte_hours: number
  updated_at: string
}

interface StorageHourlyCalculationOptions {
  appId: string
  ownerOrg: string
  cycleStart: string
  cycleEnd: string
  currentHour?: string
}

interface StorageHourlyCalculationResult {
  rows: StorageHourlyRow[]
  skippedMissingAddition: number
  skippedInvalidInterval: number
  error?: string
}

type StorageIntervalSkipReason = 'missingAddition' | 'invalidInterval' | 'outsideCycle'

interface StorageInterval {
  start: number
  end: number
  size: number
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MAX_STORAGE_CYCLE_HOURS = 34 * 24

function parseTimestampMs(value: string | Date): number {
  const date = value instanceof Date ? value : new Date(value)
  const timestamp = date.getTime()
  if (!Number.isFinite(timestamp))
    throw new Error(`Invalid timestamp: ${String(value)}`)
  return timestamp
}

function floorToDay(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS) * DAY_MS
}

function formatUtcDay(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10)
}

function getStorageDailyDeleteRange(cycleStart: string, cycleEnd: string) {
  const cycleStartMs = parseTimestampMs(cycleStart)
  const cycleEndMs = parseTimestampMs(cycleEnd)
  const lastOverlappingDayMs = floorToDay(Math.max(cycleStartMs, cycleEndMs - 1))

  return {
    startDay: formatUtcDay(floorToDay(cycleStartMs)),
    endExclusiveDay: formatUtcDay(lastOverlappingDayMs + DAY_MS),
  }
}

function emptyStorageHourlyCalculationResult(): StorageHourlyCalculationResult {
  return {
    rows: [],
    skippedMissingAddition: 0,
    skippedInvalidInterval: 0,
  }
}

function assertStorageCycleWithinLimit(cycleStartMs: number, cycleEndMs: number) {
  const cycleHours = Math.ceil((cycleEndMs - cycleStartMs) / HOUR_MS)
  if (cycleHours > MAX_STORAGE_CYCLE_HOURS)
    throw new Error(`Billing cycle is too large for hourly storage calculation: ${cycleHours} hours`)
}

function applyStorageEvent(current: StorageVersionLifetime, event: VersionMetaStorageRow, timestamp: number) {
  if (event.size > 0) {
    if (current.addedAt === undefined || timestamp < current.addedAt) {
      current.addedAt = timestamp
      current.size = event.size
    }
    return
  }

  if (event.size < 0 && (current.removedAt === undefined || timestamp < current.removedAt))
    current.removedAt = timestamp
}

function collectStorageVersionLifetimes(events: VersionMetaStorageRow[]) {
  const versions = new Map<number, StorageVersionLifetime>()
  for (const event of events) {
    const timestamp = parseTimestampMs(event.timestamp)
    const current = versions.get(event.version_id) ?? {}
    applyStorageEvent(current, event, timestamp)
    versions.set(event.version_id, current)
  }
  return versions
}

function getStorageInterval(
  version: StorageVersionLifetime,
  cycleStartMs: number,
  calculationEndMs: number,
  cycleEndMs: number,
): StorageInterval | { skipReason: StorageIntervalSkipReason } {
  if (version.addedAt === undefined || version.size === undefined || version.size <= 0)
    return { skipReason: 'missingAddition' }

  const start = Math.max(version.addedAt, cycleStartMs)
  const end = Math.min(version.removedAt ?? calculationEndMs, calculationEndMs, cycleEndMs)
  if (end <= cycleStartMs || start >= calculationEndMs)
    return { skipReason: 'outsideCycle' }
  if (end <= start)
    return { skipReason: 'invalidInterval' }

  return { start, end, size: version.size }
}

function addStorageIntervalToDailyBuckets(dailyBuckets: Map<number, number>, interval: StorageInterval) {
  for (let bucketStart = floorToDay(interval.start); bucketStart < interval.end; bucketStart += DAY_MS) {
    const overlapStart = Math.max(bucketStart, interval.start)
    const overlapEnd = Math.min(bucketStart + DAY_MS, interval.end)
    if (overlapEnd <= overlapStart)
      continue

    const byteHours = interval.size * ((overlapEnd - overlapStart) / HOUR_MS)
    dailyBuckets.set(bucketStart, (dailyBuckets.get(bucketStart) ?? 0) + byteHours)
  }
}

function buildStorageHourlyRows(dailyBuckets: Map<number, number>, options: StorageHourlyCalculationOptions) {
  const now = new Date().toISOString()
  return Array.from(dailyBuckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([dateMs, storageByteHours]) => ({
      app_id: options.appId,
      owner_org: options.ownerOrg,
      date: formatUtcDay(dateMs),
      storage_byte_hours: storageByteHours,
      updated_at: now,
    }))
}

export function calculateStorageHourlyRows(
  events: VersionMetaStorageRow[],
  options: StorageHourlyCalculationOptions,
): StorageHourlyCalculationResult {
  const cycleStartMs = parseTimestampMs(options.cycleStart)
  const cycleEndMs = parseTimestampMs(options.cycleEnd)
  const currentHourMs = options.currentHour ? parseTimestampMs(options.currentHour) : Date.now()
  const calculationEndMs = Math.min(cycleEndMs, currentHourMs)

  if (calculationEndMs <= cycleStartMs)
    return emptyStorageHourlyCalculationResult()

  assertStorageCycleWithinLimit(cycleStartMs, cycleEndMs)
  const versions = collectStorageVersionLifetimes(events)
  const dailyBuckets = new Map<number, number>()
  let skippedMissingAddition = 0
  let skippedInvalidInterval = 0

  for (const version of versions.values()) {
    const interval = getStorageInterval(version, cycleStartMs, calculationEndMs, cycleEndMs)
    if ('skipReason' in interval) {
      if (interval.skipReason === 'missingAddition')
        skippedMissingAddition++
      else if (interval.skipReason === 'invalidInterval')
        skippedInvalidInterval++
      continue
    }

    addStorageIntervalToDailyBuckets(dailyBuckets, interval)
  }

  return {
    rows: buildStorageHourlyRows(dailyBuckets, options),
    skippedMissingAddition,
    skippedInvalidInterval,
  }
}

async function runSupabaseResultWithRetry<T>(
  c: Context,
  label: string,
  operation: () => Promise<SupabaseRetryResult<T>>,
): Promise<SupabaseRetryResult<T>> {
  const { result, attempts } = await retryWithBackoff(async () => {
    try {
      return await operation()
    }
    catch (error) {
      return {
        data: null,
        error,
      }
    }
  }, {
    attempts: SUPABASE_RETRY_ATTEMPTS,
    baseDelayMs: SUPABASE_RETRY_DELAY_MS,
    shouldRetry: result => isRetryablePostgrestResult(result) || isTransientDatabaseError(result?.error),
  })

  if (!result) {
    throw new Error(`${label} returned no result`)
  }

  if (attempts > 1) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'cron_stat_app retry finished',
      label,
      attempts,
      hadError: Boolean(result.error || isRetryablePostgrestStatus(getRetryablePostgrestStatus(result))),
    })
  }

  if (result.error) {
    throw result.error
  }

  if (typeof result.status === 'number' && result.status >= 400) {
    throw new Error(`${label} failed with status ${result.status}`)
  }

  return result
}

async function readVersionMetaStorageRows(pg: PgClient, appId: string, calculationEnd: string) {
  const { rows } = await pg.query<VersionMetaStorageRow>(
    `
      SELECT timestamp, version_id, size
      FROM public.version_meta
      WHERE app_id = $1
        AND timestamp < $2::timestamp
      ORDER BY version_id, timestamp
    `,
    [appId, calculationEnd],
  )
  return rows
}

// Same as a PostgREST bulk upsert: missing keys become NULL and only the listed
// columns are written. Table, column and conflict names are fixed by callers.
async function upsertRows(
  pg: PgClient,
  table: string,
  columns: Record<string, string>,
  conflictColumns: string[],
  rows: object[],
) {
  if (rows.length === 0)
    return
  const names = Object.keys(columns)
  const recordset = names.map(name => `"${name}" ${columns[name]}`).join(', ')
  const updates = names.filter(name => !conflictColumns.includes(name)).map(name => `"${name}" = EXCLUDED."${name}"`).join(', ')
  await pg.query(
    `INSERT INTO public.${table} (${names.map(name => `"${name}"`).join(', ')})
    SELECT ${names.map(name => `r."${name}"`).join(', ')} FROM pg_catalog.jsonb_to_recordset($1::jsonb) AS r(${recordset})
    ON CONFLICT (${conflictColumns.map(name => `"${name}"`).join(', ')}) DO UPDATE SET ${updates}`,
    [JSON.stringify(rows)],
  )
}

async function refreshStorageHourly(
  c: Context,
  pg: PgClient,
  appId: string,
  ownerOrg: string,
  cycleInfo: CycleInfo,
  currentHour?: string,
) {
  if (!cycleInfo.subscription_anchor_start || !cycleInfo.subscription_anchor_end)
    throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { cycleInfo })

  const calculationEnd = currentHour ?? new Date().toISOString()
  const events = await readVersionMetaStorageRows(pg, appId, calculationEnd)
  const calculation = calculateStorageHourlyRows(events, {
    appId,
    ownerOrg,
    cycleStart: cycleInfo.subscription_anchor_start,
    cycleEnd: cycleInfo.subscription_anchor_end,
    currentHour: calculationEnd,
  })

  if (calculation.skippedMissingAddition > 0 || calculation.skippedInvalidInterval > 0) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'storage hourly skipped invalid version metadata',
      appId,
      skippedMissingAddition: calculation.skippedMissingAddition,
      skippedInvalidInterval: calculation.skippedInvalidInterval,
    })
  }

  const deleteRange = getStorageDailyDeleteRange(cycleInfo.subscription_anchor_start, cycleInfo.subscription_anchor_end)
  await runSupabaseResultWithRetry(c, 'delete_daily_storage_hourly', async () => {
    await pg.query(
      'DELETE FROM public.daily_storage_hourly WHERE app_id = $1 AND date >= $2::date AND date < $3::date',
      [appId, deleteRange.startDay, deleteRange.endExclusiveDay],
    )
    return { data: null, error: null }
  })

  if (calculation.rows.length === 0)
    return calculation

  await runSupabaseResultWithRetry(c, 'upsert_daily_storage_hourly', async () => {
    await upsertRows(pg, 'daily_storage_hourly', {
      app_id: 'varchar',
      owner_org: 'uuid',
      date: 'date',
      storage_byte_hours: 'double precision',
      updated_at: 'timestamptz',
    }, ['app_id', 'date'], calculation.rows)
    return { data: null, error: null }
  })

  return calculation
}

async function syncAppStatsRefresh(
  c: Context,
  pg: PgClient,
  appId: string,
): Promise<string> {
  const { data } = await runSupabaseResultWithRetry<string | null>(c, 'sync_app_stats_refresh', async () => {
    const result = await pg.query<{ refreshed_at: string | null }>(
      'SELECT pg_catalog.to_json(public.mark_app_stats_refreshed(p_app_id => $1)) AS refreshed_at',
      [appId],
    )
    return { data: result.rows[0]?.refreshed_at ?? null, error: null }
  })

  if (!data) {
    throw new Error('sync_app_stats_refresh returned no timestamp')
  }

  return data
}

app.use('/', useCors)

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<DataToGet>(c)
  cloudlog({ requestId: c.get('requestId'), message: 'post cron_stat_app body', body })
  if (!body.appId)
    throw simpleError('no_appId', 'No appId', { body })
  if (!body.orgId)
    throw simpleError('no_orgId', 'No orgId', { body })
  const appId = body.appId
  const orgId = body.orgId

  const pg = await getPgClient(c)
  try {
    return await saveAppStats(c, pg, body, appId, orgId)
  }
  finally {
    closeClient(c, pg)
  }
})

async function saveAppStats(c: Context, pg: PgClient, body: DataToGet, appId: string, orgId: string) {
  const appResult = await runSupabaseResultWithRetry<AppOwnerOrgRow>(c, 'load_app', async () => {
    const result = await pg.query<AppOwnerOrgRow>('SELECT owner_org FROM public.apps WHERE app_id = $1 LIMIT 2', [appId])
    if (result.rows.length > 1)
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    return { data: result.rows[0] ?? null, error: null }
  })
  if (!appResult.data) {
    cloudlog({ requestId: c.get('requestId'), message: 'cron_stat_app skipping missing app', body })
    return c.json({ status: 'skipped', reason: 'app_not_found' })
  }
  if (appResult.data.owner_org !== orgId) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'cron_stat_app skipping owner mismatch',
      body,
      app_owner_org: appResult.data.owner_org,
    })
    return c.json({ status: 'skipped', reason: 'owner_org_mismatch' })
  }

  // get the period of the billing of the organization
  const cycleInfoResult = await runSupabaseResultWithRetry<CycleInfo>(c, 'get_cycle_info_org', async () => {
    const rows = await queryJson<CycleInfo>(pg, 'SELECT * FROM public.get_cycle_info_org(orgid => $1)', [orgId])
    if (rows.length !== 1)
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } }
    return { data: rows[0], error: null }
  })
  const cycleInfo = cycleInfoResult.data
  if (!cycleInfo?.subscription_anchor_start || !cycleInfo?.subscription_anchor_end)
    throw simpleError('cannot_get_cycle_info', 'Cannot get cycle info', { cycleInfoResult })

  cloudlog({ requestId: c.get('requestId'), message: 'cycleInfo', cycleInfo })
  const startDate = cycleInfo.subscription_anchor_start
  const endDate = cycleInfo.subscription_anchor_end

  // get mau
  let mau = await readStatsMau(c, appId, startDate, endDate)
  // get bandwidth
  let bandwidth = await readStatsBandwidth(c, appId, startDate, endDate)
  // get storage
  let storage = await readStatsStorage(c, appId, startDate, endDate)
  let versionUsage = await readStatsVersion(c, appId, startDate, endDate)

  if (body.todayOnly) {
    // take only the last day
    mau = mau.slice(-1)
    bandwidth = bandwidth.slice(-1)
    storage = storage.slice(-1)
    // version usage has one row per (date, version): keep every version of the last day
    const lastVersionDate = versionUsage.at(-1)?.date
    versionUsage = versionUsage.filter(v => v.date === lastVersionDate)
  }

  // Handle backwards compatibility: old Cloudflare data has numeric version_id in blob2,
  // new data has version_name string. Detect and resolve old data.
  const versionNamesToResolve = versionUsage
    .filter(v => /^\d+$/.test(String(v.version_name)))
    .map(v => Number(v.version_name))

  let versionIdToNameMap: Record<number, string> = {}
  if (versionNamesToResolve.length > 0) {
    // Only resolve ids of this app's bundles, and never rewrite a value that is also
    // a real bundle name of this app (bundles can be named "123").
    const [{ data: versions }, { data: numericNamedVersions }] = await Promise.all([
      runSupabaseResultWithRetry<VersionNameRow[]>(c, 'resolve_version_names', async () => ({
        data: await queryJson<VersionNameRow>(pg, 'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND id = ANY($2::bigint[])', [appId, versionNamesToResolve]),
        error: null,
      })),
      runSupabaseResultWithRetry<VersionNameRow[]>(c, 'resolve_numeric_version_names', async () => ({
        data: await queryJson<VersionNameRow>(pg, 'SELECT id, name FROM public.app_versions WHERE app_id = $1 AND name = ANY($2::varchar[])', [appId, versionNamesToResolve.map(String)]),
        error: null,
      })),
    ])
    const realNumericNames = new Set((numericNamedVersions ?? []).map(v => v.name))
    if (versions) {
      versionIdToNameMap = Object.fromEntries(versions
        .filter(v => !realNumericNames.has(String(v.id)))
        .map(v => [v.id, v.name]))
    }
  }

  // Map version_name for old data (numeric version_id -> actual version name)
  const mappedVersionUsage = versionUsage.map((v) => {
    const versionNameOrId = String(v.version_name)
    if (/^\d+$/.test(versionNameOrId)) {
      // Old data: resolve version_id to version_name
      const resolvedName = versionIdToNameMap[Number(versionNameOrId)]
      return { ...v, version_name: resolvedName || versionNameOrId }
    }
    return v
  })

  // Aggregate entries with same (app_id, date, version_name) after mapping
  // This handles the transition period where old (version_id) and new (version_name) data coexist
  const aggregationMap = new Map<string, typeof mappedVersionUsage[0]>()
  for (const entry of mappedVersionUsage) {
    const key = `${entry.app_id}|${entry.date}|${entry.version_name}`
    const existing = aggregationMap.get(key)
    if (existing) {
      // Aggregate stats
      existing.get += entry.get
      existing.fail += entry.fail
      existing.install += entry.install
      existing.uninstall += entry.uninstall
    }
    else {
      // Clone to avoid mutating original
      aggregationMap.set(key, { ...entry })
    }
  }
  const resolvedVersionUsage = Array.from(aggregationMap.values())

  cloudlog({ requestId: c.get('requestId'), message: 'mau', mauLength: mau.length, mauCount: mau.reduce((acc, curr) => acc + curr.mau, 0), mau: JSON.stringify(mau) })
  cloudlog({ requestId: c.get('requestId'), message: 'bandwidth', bandwidthLength: bandwidth.length, bandwidthCount: bandwidth.reduce((acc, curr) => acc + curr.bandwidth, 0), bandwidth: JSON.stringify(bandwidth) })
  cloudlog({ requestId: c.get('requestId'), message: 'storage', storageLength: storage.length, storageCount: storage.reduce((acc, curr) => acc + curr.storage, 0), storage: JSON.stringify(storage) })
  cloudlog({ requestId: c.get('requestId'), message: 'versionUsage', versionUsageLength: resolvedVersionUsage.length, versionUsageCount: resolvedVersionUsage.reduce((acc, curr) => acc + curr.get + curr.fail + curr.install + curr.uninstall, 0), versionUsage: JSON.stringify(resolvedVersionUsage) })

  // save to daily_mau, daily_bandwidth and daily_storage
  // Note: daily_version upsert uses type cast because auto-generated types are stale
  // (migration adds version_name column but types haven't been regenerated)
  await Promise.all([
    runSupabaseResultWithRetry(c, 'upsert_daily_mau', async () => {
      await upsertRows(pg, 'daily_mau', { app_id: 'varchar', date: 'date', mau: 'bigint' }, ['app_id', 'date'], mau)
      return { data: null, error: null }
    }),
    runSupabaseResultWithRetry(c, 'upsert_daily_bandwidth', async () => {
      await upsertRows(pg, 'daily_bandwidth', { app_id: 'varchar', date: 'date', bandwidth: 'bigint' }, ['app_id', 'date'], bandwidth)
      return { data: null, error: null }
    }),
    runSupabaseResultWithRetry(c, 'upsert_daily_storage', async () => {
      await upsertRows(pg, 'daily_storage', { app_id: 'varchar', date: 'date', storage: 'bigint' }, ['app_id', 'date'], storage)
      return { data: null, error: null }
    }),
    runSupabaseResultWithRetry(c, 'upsert_daily_version', async () => {
      await upsertRows(pg, 'daily_version', {
        app_id: 'varchar',
        date: 'date',
        version_name: 'varchar',
        get: 'bigint',
        fail: 'bigint',
        install: 'bigint',
        uninstall: 'bigint',
      }, ['app_id', 'date', 'version_name'], resolvedVersionUsage)
      return { data: null, error: null }
    }),
  ])

  let storageHourly: StorageHourlyCalculationResult
  try {
    storageHourly = await refreshStorageHourly(c, pg, appId, orgId, cycleInfo, body.currentHour)
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Failed to refresh shadow hourly storage', appId, orgId, error })
    storageHourly = {
      rows: [],
      skippedMissingAddition: 0,
      skippedInvalidInterval: 0,
      error: 'storage_hourly_refresh_failed',
    }
  }

  cloudlog({ requestId: c.get('requestId'), message: 'stats saved', mauLength: mau.length, bandwidthLength: bandwidth.length, storageLength: storage.length, versionUsageLength: versionUsage.length })
  await syncAppStatsRefresh(c, pg, appId)

  return c.json({ status: 'Stats saved', mau, bandwidth, storage, storageHourly, versionUsage })
}

export const cronStatAppTestUtils = {
  isRetryablePostgrestError,
  runSupabaseResultWithRetry,
}
