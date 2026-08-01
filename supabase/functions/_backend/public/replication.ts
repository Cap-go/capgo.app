import type { Context } from 'hono'
import { sql } from 'drizzle-orm'
import { CacheHelper } from '../utils/cache.ts'
import { honoFactory, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'
import { validatePlatformAdminOrApiSecret } from '../utils/platform_admin_access.ts'

const DEFAULT_THRESHOLD_SECONDS = 180
const DEFAULT_THRESHOLD_BYTES = 16 * 1024 * 1024
const DATA_CANARY_TABLE = 'app_versions'
const DATA_CANARY_TTL_SECONDS = 300
const DATA_CANARY_TTL_MS = DATA_CANARY_TTL_SECONDS * 1000
const DATA_CANARY_THRESHOLD_PERCENT = 0.01
const DATA_CANARY_CACHE_TIMEOUT_MS = 250

type SlotStatus = 'ok' | 'ko'
type CheckStatus = 'ok' | 'ko' | 'skipped'
type ReplicationQueryMode = 'wal_stats' | 'replication_stats' | 'slots_only'

interface ReplicationSlotLag {
  slot_name: string
  active: boolean
  confirmed_flush_lsn: string | null
  restart_lsn: string | null
  lag_bytes: number | null
  slot_lag: string | null
  lag_seconds: number | null
  lag_seconds_est: number | null
  effective_lag_seconds: number | null
  lag_minutes: number | null
  status: SlotStatus
  reasons: string[]
}

export interface SubscriptionWorkerRow {
  subname: string
  subenabled: boolean
  has_apply_worker: boolean
  apply_lag_seconds: number | null
  last_msg_receipt_time: string | null
}

export interface SubscriptionHealthResult {
  status: CheckStatus
  checked_at: string
  threshold_seconds: number
  subscriptions: Array<{
    subname: string
    enabled: boolean
    has_apply_worker: boolean
    apply_lag_seconds: number | null
    last_msg_receipt_time: string | null
    status: SlotStatus
    reasons: string[]
  }>
  reasons: string[]
}

export interface DataCanaryResult {
  status: CheckStatus
  table: typeof DATA_CANARY_TABLE
  primary_count: number | null
  replica_count: number | null
  diff: number | null
  diff_percent: number | null
  threshold_percent: number
  checked_at: string
  expires_at: string
  cached: boolean
  reasons: string[]
}

interface DataCanaryCacheEntry extends Omit<DataCanaryResult, 'cached'> {
  expiresAt: number
}

const dataCanaryMemoryCache = new Map<string, DataCanaryCacheEntry>()
const dataCanaryInflight = new Map<string, Promise<DataCanaryResult>>()

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  const num = Number(value)
  if (!Number.isFinite(num))
    return null
  return num
}

function isReplicaDatabaseSource(source: string): boolean {
  return source.startsWith('HYPERDRIVE_CAPGO_READ') || source === 'local_read_replica'
}

export function evaluateAppVersionsCanary(
  primaryCount: number,
  replicaCount: number,
  thresholdPercent = DATA_CANARY_THRESHOLD_PERCENT,
): Pick<DataCanaryResult, 'status' | 'diff' | 'diff_percent' | 'reasons'> {
  const diff = Math.abs(primaryCount - replicaCount)
  const baseline = Math.max(primaryCount, replicaCount, 0)
  const diffPercent = baseline === 0 ? 0 : diff / baseline
  const reasons: string[] = []

  if (primaryCount > 0 && replicaCount === 0)
    reasons.push('replica_empty')
  else if (diffPercent > thresholdPercent)
    reasons.push('count_mismatch')

  return {
    status: reasons.length > 0 ? 'ko' : 'ok',
    diff,
    diff_percent: Number(diffPercent.toFixed(6)),
    reasons,
  }
}

export function evaluateSubscriptionHealth(
  rows: SubscriptionWorkerRow[],
  thresholdSeconds = DEFAULT_THRESHOLD_SECONDS,
  checkedAt = new Date().toISOString(),
): SubscriptionHealthResult {
  if (rows.length === 0) {
    return {
      status: 'ko',
      checked_at: checkedAt,
      threshold_seconds: thresholdSeconds,
      subscriptions: [],
      reasons: ['no_subscription'],
    }
  }

  const subscriptions = rows.map((row) => {
    const reasons: string[] = []
    if (!row.subenabled)
      reasons.push('subscription_disabled')
    if (!row.has_apply_worker)
      reasons.push('no_apply_worker')
    if (row.apply_lag_seconds !== null && row.apply_lag_seconds > thresholdSeconds)
      reasons.push('apply_lag_threshold_exceeded')

    return {
      subname: row.subname,
      enabled: row.subenabled,
      has_apply_worker: row.has_apply_worker,
      apply_lag_seconds: row.apply_lag_seconds,
      last_msg_receipt_time: row.last_msg_receipt_time,
      status: (reasons.length > 0 ? 'ko' : 'ok') as SlotStatus,
      reasons,
    }
  })

  const hasHealthy = subscriptions.some(sub => sub.status === 'ok')
  const reasons = hasHealthy
    ? []
    : [...new Set(subscriptions.flatMap(sub => sub.reasons))]

  return {
    status: hasHealthy ? 'ok' : 'ko',
    checked_at: checkedAt,
    threshold_seconds: thresholdSeconds,
    subscriptions,
    reasons: reasons.length > 0 ? reasons : (hasHealthy ? [] : ['subscription_unhealthy']),
  }
}

function getFreshDataCanaryMemoryEntry(cacheKey: string, now = Date.now()): DataCanaryResult | null {
  const cached = dataCanaryMemoryCache.get(cacheKey)
  if (!cached)
    return null
  if (cached.expiresAt <= now) {
    dataCanaryMemoryCache.delete(cacheKey)
    return null
  }
  const { expiresAt: _expiresAt, ...payload } = cached
  return { ...payload, cached: true }
}

function setDataCanaryMemoryEntry(cacheKey: string, entry: DataCanaryCacheEntry) {
  dataCanaryMemoryCache.set(cacheKey, entry)
}

/** Test helper: clear in-process canary cache between unit tests. */
export function clearDataCanaryCacheForTests() {
  dataCanaryMemoryCache.clear()
  dataCanaryInflight.clear()
}

function buildReplicationQuery(mode: ReplicationQueryMode) {
  const slotsCte = sql`
      WITH slots AS (
        SELECT
          slot_name,
          active,
          confirmed_flush_lsn,
          restart_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS slot_lag
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
          AND slot_name !~ '^pg_[0-9]+_sync_[0-9]+_[0-9]+$'
          AND slot_name !~ '^supabase_'
      )
  `

  if (mode === 'wal_stats') {
    return sql`
      WITH wal_stats AS (
        SELECT
          wal_bytes::numeric AS wal_bytes,
          EXTRACT(EPOCH FROM (now() - stats_reset))::numeric AS seconds_since_reset
        FROM pg_stat_wal
      ),
      slots AS (
        SELECT
          slot_name,
          active,
          confirmed_flush_lsn,
          restart_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS slot_lag
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
          AND slot_name !~ '^pg_[0-9]+_sync_[0-9]+_[0-9]+$'
          AND slot_name !~ '^supabase_'
      )
      SELECT
        slots.*,
        NULL::numeric AS lag_seconds,
        CASE
          WHEN wal_stats.seconds_since_reset > 0
            AND wal_stats.wal_bytes > 0
            AND slots.lag_bytes IS NOT NULL
            THEN (slots.lag_bytes / (wal_stats.wal_bytes / wal_stats.seconds_since_reset))
          ELSE NULL
        END AS lag_seconds_est
      FROM slots
      CROSS JOIN wal_stats
      ORDER BY slots.slot_name
    `
  }

  if (mode === 'replication_stats') {
    return sql`
      ${slotsCte}
      SELECT
        slots.*,
        EXTRACT(EPOCH FROM COALESCE(sr.flush_lag, sr.write_lag, sr.replay_lag))::numeric AS lag_seconds,
        NULL::numeric AS lag_seconds_est
      FROM slots
      LEFT JOIN pg_stat_replication sr ON sr.slot_name = slots.slot_name
      ORDER BY slots.slot_name
    `
  }

  return sql`
    ${slotsCte}
    SELECT
      slots.*,
      NULL::numeric AS lag_seconds,
      NULL::numeric AS lag_seconds_est
    FROM slots
    ORDER BY slots.slot_name
  `
}

async function executeReplicationQuery(
  c: Parameters<typeof cloudlogErr>[0],
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ rows: any[], mode: ReplicationQueryMode }> {
  const modes: ReplicationQueryMode[] = ['wal_stats', 'slots_only']
  let lastError: unknown = null

  for (const mode of modes) {
    try {
      const query = buildReplicationQuery(mode)
      const result = await drizzleClient.execute(query)
      return { rows: result.rows as any[], mode }
    }
    catch (error) {
      lastError = error
      cloudlogErr({
        requestId: c.requestId,
        message: 'replication_lag_query_failed',
        error,
        mode,
      })
    }
  }

  throw lastError
}

async function querySubscriptionHealth(
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  thresholdSeconds: number,
): Promise<SubscriptionHealthResult> {
  const checkedAt = new Date().toISOString()
  const result = await drizzleClient.execute(sql`
    SELECT
      s.subname,
      s.subenabled,
      COALESCE(bool_or(ss.pid IS NOT NULL AND ss.last_msg_receipt_time IS NOT NULL), false) AS has_apply_worker,
      MAX(EXTRACT(EPOCH FROM (now() - ss.last_msg_receipt_time)))
        FILTER (WHERE ss.last_msg_receipt_time IS NOT NULL) AS apply_lag_seconds,
      MAX(ss.last_msg_receipt_time) AS last_msg_receipt_time
    FROM pg_subscription s
    LEFT JOIN pg_stat_subscription ss ON ss.subname = s.subname
    GROUP BY s.subname, s.subenabled
    ORDER BY s.subname
  `)

  const rows: SubscriptionWorkerRow[] = (result.rows as any[]).map(row => ({
    subname: String(row.subname),
    subenabled: Boolean(row.subenabled),
    has_apply_worker: Boolean(row.has_apply_worker),
    apply_lag_seconds: toNumber(row.apply_lag_seconds),
    last_msg_receipt_time: row.last_msg_receipt_time
      ? new Date(row.last_msg_receipt_time).toISOString()
      : null,
  }))

  return evaluateSubscriptionHealth(rows, thresholdSeconds, checkedAt)
}

async function countAppVersions(drizzleClient: ReturnType<typeof getDrizzleClient>): Promise<number> {
  const result = await drizzleClient.execute(sql`
    SELECT COUNT(*)::bigint AS count
    FROM public.app_versions
  `)
  const count = toNumber((result.rows as any[])[0]?.count)
  if (count === null)
    throw new Error('app_versions count missing')
  return count
}

async function queryDataCanary(
  primaryDrizzle: ReturnType<typeof getDrizzleClient>,
  replicaDrizzle: ReturnType<typeof getDrizzleClient>,
): Promise<Omit<DataCanaryResult, 'cached' | 'expires_at'> & { expiresAt: number }> {
  const checkedAt = new Date().toISOString()
  const expiresAt = Date.now() + DATA_CANARY_TTL_MS
  const [primaryCount, replicaCount] = await Promise.all([
    countAppVersions(primaryDrizzle),
    countAppVersions(replicaDrizzle),
  ])
  const evaluation = evaluateAppVersionsCanary(primaryCount, replicaCount)

  return {
    status: evaluation.status,
    table: DATA_CANARY_TABLE,
    primary_count: primaryCount,
    replica_count: replicaCount,
    diff: evaluation.diff,
    diff_percent: evaluation.diff_percent,
    threshold_percent: DATA_CANARY_THRESHOLD_PERCENT,
    checked_at: checkedAt,
    expiresAt,
    reasons: evaluation.reasons,
  }
}

async function getCachedDataCanary(
  c: Context,
  primaryDrizzle: ReturnType<typeof getDrizzleClient>,
  replicaDrizzle: ReturnType<typeof getDrizzleClient>,
  replicaSource: string,
): Promise<DataCanaryResult> {
  const cacheKey = `app_versions:${replicaSource}`
  const memoryEntry = getFreshDataCanaryMemoryEntry(cacheKey)
  if (memoryEntry)
    return memoryEntry

  const existingQuery = dataCanaryInflight.get(cacheKey)
  if (existingQuery)
    return existingQuery

  const cacheHelper = new CacheHelper(c)
  const cacheRequest = cacheHelper.buildRequest('/cache/replication-data-canary', { source: cacheKey })
  const cachedEntry = await cacheHelper.matchJson<DataCanaryCacheEntry>(cacheRequest, {
    timeoutMs: DATA_CANARY_CACHE_TIMEOUT_MS,
  })

  if (cachedEntry && cachedEntry.expiresAt > Date.now()) {
    setDataCanaryMemoryEntry(cacheKey, cachedEntry)
    const { expiresAt: _expiresAt, ...payload } = cachedEntry
    return { ...payload, cached: true }
  }

  const existingQueryAfterCache = dataCanaryInflight.get(cacheKey)
  if (existingQueryAfterCache)
    return existingQueryAfterCache

  const query = queryDataCanary(primaryDrizzle, replicaDrizzle)
    .then(async (result) => {
      const cacheEntry: DataCanaryCacheEntry = {
        status: result.status,
        table: result.table,
        primary_count: result.primary_count,
        replica_count: result.replica_count,
        diff: result.diff,
        diff_percent: result.diff_percent,
        threshold_percent: result.threshold_percent,
        checked_at: result.checked_at,
        expires_at: new Date(result.expiresAt).toISOString(),
        expiresAt: result.expiresAt,
        reasons: result.reasons,
      }
      setDataCanaryMemoryEntry(cacheKey, cacheEntry)
      await cacheHelper.putJson(cacheRequest, cacheEntry, DATA_CANARY_TTL_SECONDS)
      const { expiresAt: _expiresAt, ...payload } = cacheEntry
      return { ...payload, cached: false }
    })
    .finally(() => {
      dataCanaryInflight.delete(cacheKey)
    })

  dataCanaryInflight.set(cacheKey, query)
  return query
}

function skippedSubscription(reason: string): SubscriptionHealthResult {
  return {
    status: 'skipped',
    checked_at: new Date().toISOString(),
    threshold_seconds: DEFAULT_THRESHOLD_SECONDS,
    subscriptions: [],
    reasons: [reason],
  }
}

function skippedDataCanary(reason: string): DataCanaryResult {
  const checkedAt = new Date().toISOString()
  return {
    status: 'skipped',
    table: DATA_CANARY_TABLE,
    primary_count: null,
    replica_count: null,
    diff: null,
    diff_percent: null,
    threshold_percent: DATA_CANARY_THRESHOLD_PERCENT,
    checked_at: checkedAt,
    expires_at: checkedAt,
    cached: false,
    reasons: [reason],
  }
}

export const app = honoFactory.createApp()

app.use('*', useCors)

app.get('/', async (c) => {
  await validatePlatformAdminOrApiSecret(c, {
    logPrefix: 'replication',
    forbiddenMessage: 'Not admin - only admin users can access replication status',
  })

  const thresholdSeconds = DEFAULT_THRESHOLD_SECONDS
  const thresholdBytes = DEFAULT_THRESHOLD_BYTES

  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)
  let replicaPgClient: ReturnType<typeof getPgClient> | null = null

  try {
    const { rows, mode } = await executeReplicationQuery({ requestId: c.get('requestId') }, drizzleClient)

    const slots: ReplicationSlotLag[] = rows.map((row: any) => {
      const lagSeconds = toNumber(row.lag_seconds)
      const lagSecondsEst = toNumber(row.lag_seconds_est)
      const lagBytes = toNumber(row.lag_bytes)
      const active = Boolean(row.active)

      let effectiveLagSeconds = lagSeconds ?? lagSecondsEst
      if (effectiveLagSeconds === null && lagBytes === 0)
        effectiveLagSeconds = 0

      const reasons: string[] = []
      if (!active)
        reasons.push('inactive')
      if (effectiveLagSeconds === null) {
        if (lagBytes === null) {
          reasons.push('lag_unknown')
        }
        else if (lagBytes > thresholdBytes) {
          reasons.push('lag_bytes_threshold_exceeded')
        }
      }
      else if (effectiveLagSeconds > thresholdSeconds) {
        reasons.push('lag_threshold_exceeded')
      }

      const status: SlotStatus = reasons.length > 0 ? 'ko' : 'ok'

      return {
        slot_name: row.slot_name,
        active,
        confirmed_flush_lsn: row.confirmed_flush_lsn ?? null,
        restart_lsn: row.restart_lsn ?? null,
        lag_bytes: lagBytes,
        slot_lag: row.slot_lag ?? null,
        lag_seconds: lagSeconds,
        lag_seconds_est: lagSecondsEst,
        effective_lag_seconds: effectiveLagSeconds,
        lag_minutes: effectiveLagSeconds !== null ? Number((effectiveLagSeconds / 60).toFixed(2)) : null,
        status,
        reasons,
      }
    })

    const activeCount = slots.filter(slot => slot.active).length
    const inactiveCount = slots.length - activeCount
    const maxLagSlot = slots.reduce<{ slot: string | null, lag: number | null }>((acc, slot) => {
      if (slot.effective_lag_seconds === null)
        return acc
      if (acc.lag === null || slot.effective_lag_seconds > acc.lag) {
        return { slot: slot.slot_name, lag: slot.effective_lag_seconds }
      }
      return acc
    }, { slot: null, lag: null })

    let subscription = skippedSubscription('no_replica_connection')
    let dataCanary = skippedDataCanary('no_replica_connection')

    try {
      replicaPgClient = getPgClient(c, true)
      const replicaSource = c.res.headers.get('X-Database-Source') ?? ''
      if (!isReplicaDatabaseSource(replicaSource)) {
        subscription = skippedSubscription('no_replica_connection')
        dataCanary = skippedDataCanary('no_replica_connection')
      }
      else {
        const replicaDrizzle = getDrizzleClient(replicaPgClient)
        subscription = await querySubscriptionHealth(replicaDrizzle, thresholdSeconds)
        dataCanary = await getCachedDataCanary(c, drizzleClient, replicaDrizzle, replicaSource)
      }
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'replication_replica_check_failed', error })
      subscription = {
        ...skippedSubscription('replica_check_failed'),
        status: 'ko',
      }
      dataCanary = {
        ...skippedDataCanary('replica_check_failed'),
        status: 'ko',
      }
    }

    const slotStatus: SlotStatus = slots.length === 0 || slots.some(slot => slot.status === 'ko') ? 'ko' : 'ok'
    const failingChecks = [
      slotStatus === 'ko',
      subscription.status === 'ko',
      dataCanary.status === 'ko',
    ]
    const overallStatus: SlotStatus = failingChecks.some(Boolean) ? 'ko' : 'ok'

    const response = {
      status: overallStatus,
      estimation_source: mode,
      threshold_seconds: thresholdSeconds,
      threshold_minutes: Number((thresholdSeconds / 60).toFixed(2)),
      threshold_bytes: thresholdBytes,
      checked_at: new Date().toISOString(),
      slot_count: slots.length,
      active_count: activeCount,
      inactive_count: inactiveCount,
      max_lag_seconds: maxLagSlot.lag,
      max_lag_minutes: maxLagSlot.lag !== null ? Number((maxLagSlot.lag / 60).toFixed(2)) : null,
      max_lag_slot: maxLagSlot.slot,
      slots,
      subscription,
      data_canary: dataCanary,
    }

    return c.json(response, overallStatus === 'ok' ? 200 : 503)
  }
  catch (error) {
    logPgError(c, 'replication_lag', error)
    cloudlogErr({ requestId: c.get('requestId'), message: 'replication_lag_error', error })
    return c.json({
      status: 'ko',
      error: 'replication_lag_error',
      message: 'Failed to fetch replication lag',
      threshold_seconds: thresholdSeconds,
      threshold_minutes: Number((thresholdSeconds / 60).toFixed(2)),
      threshold_bytes: thresholdBytes,
      checked_at: new Date().toISOString(),
      slot_count: 0,
      active_count: 0,
      inactive_count: 0,
      max_lag_seconds: null,
      max_lag_minutes: null,
      max_lag_slot: null,
      slots: [],
      subscription: skippedSubscription('replication_lag_error'),
      data_canary: skippedDataCanary('replication_lag_error'),
    }, 500)
  }
  finally {
    await closeClient(c, pgClient)
    if (replicaPgClient)
      await closeClient(c, replicaPgClient)
  }
})
