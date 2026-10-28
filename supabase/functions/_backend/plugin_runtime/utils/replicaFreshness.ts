import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'

/**
 * Replica lag known to this isolate / data center, per database source, and
 * the edge cache rule built on it.
 *
 * Plugin edge cache entries (worker Cache API and snippet answers) are filled
 * from the local read replica. A purge re-runs up to 180s after a write; a
 * refill after that from a replica still behind would keep the pre-change
 * answer for the whole TTL. Refills from a replica measured behind are
 * therefore cached briefly only.
 *
 * Load: the rule fails open. Without a lag figure (cold isolate, probe error,
 * unreadable stats) the TTL is unchanged, so the refill rate only rises while
 * a replica is measured lagging, and only in its region. It never queries
 * the database itself: figures come from the existing background probe.
 */

export type ReplicationStatus = 'ok' | 'lagging' | 'unknown'

export interface ReplicationLagStatus {
  status: ReplicationStatus
  max_lag_seconds: number | null
}

interface ReplicationLagCacheEntry extends ReplicationLagStatus {
  expiresAt: number
}

export const REPLICATION_LAG_CACHE_TTL_SECONDS = 60
const REPLICATION_LAG_CACHE_TTL_MS = REPLICATION_LAG_CACHE_TTL_SECONDS * 1000

/**
 * Largest replica lag at which a refill keeps its full TTL. The lag figure can
 * be REPLICATION_LAG_CACHE_TTL_SECONDS old, so the replica is at most 120s
 * behind at refill time: under the last re-purge (+180s), which then evicts
 * any refill that missed the write.
 */
export const EDGE_CACHE_MAX_REPLICA_LAG_SECONDS = 60
/** TTL of an edge cache refill from a replica measured lagging. */
export const EDGE_CACHE_UNVERIFIED_REPLICA_TTL_SECONDS = 30

export const REPLICATION_LAG_APPLY_THRESHOLD_SECONDS = 180

/**
 * Replica lag SQL. The EU replica is the logical subscriber of the primary
 * (pg_stat_subscription); the regional replicas are physical standbys of that
 * subscriber, where pg_stat_subscription is empty, so their lag is the age of
 * the last replayed transaction. A standby whose WAL receiver runs and that
 * replayed everything it received is current: no writes is not lag. This is
 * lag behind the subscriber, not the primary (the subscriber's own lag is
 * not visible from a standby). Roles
 * without pg_read_all_stats see the receiver pid but a NULL status, which
 * still counts as running.
 *
 * On the logical subscriber (not in recovery), lag is apply progress:
 * latest_end_time (last apply position acknowledged upstream; not proof the
 * worker finished applying) and received_lsn vs latest_end_lsn. When WAL was
 * received but not applied and latest_end_time is missing, treat as stalled
 * (do not use fresh last_msg_receipt_time alone).
 */
export const UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS = REPLICATION_LAG_APPLY_THRESHOLD_SECONDS + 1

/** CASE expression for one pg_stat_subscription row (optional column prefix). */
export function logicalSubscriberApplyLagCaseSql(columnPrefix = ''): string {
  const p = columnPrefix
  return `CASE
          WHEN ${p}latest_end_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (now() - ${p}latest_end_time))
          WHEN ${p}received_lsn IS NOT NULL
            AND ${p}latest_end_lsn IS NOT NULL
            AND ${p}received_lsn::pg_lsn > ${p}latest_end_lsn::pg_lsn THEN
            ${UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS}::double precision
          WHEN ${p}last_msg_receipt_time IS NOT NULL THEN
            EXTRACT(EPOCH FROM (now() - ${p}last_msg_receipt_time))
          ELSE NULL
        END`
}

export const REPLICA_LAG_QUERY = `
  SELECT CASE
    WHEN pg_is_in_recovery() THEN
      CASE
        WHEN pg_last_wal_receive_lsn() IS NOT NULL
          AND pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn()
          AND EXISTS (SELECT 1 FROM pg_stat_wal_receiver WHERE pid IS NOT NULL AND (status IS NULL OR status = 'streaming'))
          THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp()))
      END
    ELSE (
      SELECT MAX(
        ${logicalSubscriberApplyLagCaseSql('')}
      )
      FROM pg_stat_subscription
    )
  END AS lag_seconds
`

/** Evaluate the shared CASE against synthetic subscription stats (tests). */
export const LOGICAL_SUBSCRIBER_APPLY_LAG_PROBE_SQL = `
  SELECT ${logicalSubscriberApplyLagCaseSql('ss.')} AS lag_seconds
  FROM (
    SELECT
      $1::timestamptz AS latest_end_time,
      $2::timestamptz AS last_msg_receipt_time,
      $3::pg_lsn AS received_lsn,
      $4::pg_lsn AS latest_end_lsn
  ) ss
`

export interface LogicalSubscriberLagRow {
  last_msg_receipt_time?: Date | string | null
  latest_end_time?: Date | string | null
  received_lsn?: string | null
  latest_end_lsn?: string | null
}

function toLagTimestamp(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined)
    return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

export function parsePgLsnParts(lsn: string): { high: number, low: number } | null {
  const trimmed = lsn.trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0)
    return null
  const highHex = trimmed.slice(0, slash)
  const lowHex = trimmed.slice(slash + 1)
  if (!/^[0-9a-fA-F]+$/.test(highHex) || !/^[0-9a-fA-F]+$/.test(lowHex))
    return null
  return {
    high: Number.parseInt(highHex, 16),
    low: Number.parseInt(lowHex, 16),
  }
}

export function pgLsnGreaterThan(received: string, latestEndLsn: string): boolean {
  const a = parsePgLsnParts(received)
  const b = parsePgLsnParts(latestEndLsn)
  if (!a || !b)
    return false
  if (a.high !== b.high)
    return a.high > b.high
  return a.low > b.low
}

/** Mirrors logicalSubscriberApplyLagCaseSql for offline checks (keep in sync). */
export function computeLogicalSubscriberApplyLagSeconds(
  row: LogicalSubscriberLagRow,
  nowMs = Date.now(),
): number | null {
  const latestEndMs = toLagTimestamp(row.latest_end_time)
  if (latestEndMs !== null)
    return (nowMs - latestEndMs) / 1000

  const receiptMs = toLagTimestamp(row.last_msg_receipt_time)
  const received = row.received_lsn?.trim()
  const latestEndLsn = row.latest_end_lsn?.trim()
  if (received && latestEndLsn && pgLsnGreaterThan(received, latestEndLsn))
    return UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS

  if (receiptMs !== null)
    return (nowMs - receiptMs) / 1000

  return null
}

export function maxLogicalSubscriberApplyLagSeconds(
  rows: LogicalSubscriberLagRow[],
  nowMs = Date.now(),
): number | null {
  let max: number | null = null
  for (const row of rows) {
    const lag = computeLogicalSubscriberApplyLagSeconds(row, nowMs)
    if (lag === null)
      continue
    max = max === null ? lag : Math.max(max, lag)
  }
  return max
}

export function replicationLagStatusFromSeconds(
  lagSeconds: number | null,
  thresholdSeconds = REPLICATION_LAG_APPLY_THRESHOLD_SECONDS,
): ReplicationStatus {
  if (lagSeconds === null)
    return 'unknown'
  return lagSeconds > thresholdSeconds ? 'lagging' : 'ok'
}

const REPLICATION_LAG_CACHE_PATH = '/cache/replication-lag'

const replicationLagMemoryCache = new Map<string, ReplicationLagCacheEntry>()

/** Data center (Cache API) copy of a source's lag figure, shared by its isolates. */
export function replicationLagCacheRequest(helper: CacheHelper, cacheKey: string) {
  return helper.buildRequest(REPLICATION_LAG_CACHE_PATH, { source: cacheKey })
}

export function getReplicationLagCacheKey(c: Context): string {
  return String(c.get('databaseSource') ?? c.res.headers.get('X-Database-Source') ?? 'unknown')
}

export function getFreshReplicationLagMemoryEntry(cacheKey: string, now = Date.now()): ReplicationLagStatus | null {
  const cached = replicationLagMemoryCache.get(cacheKey)
  if (!cached)
    return null
  if (cached.expiresAt <= now) {
    replicationLagMemoryCache.delete(cacheKey)
    return null
  }
  return {
    status: cached.status,
    max_lag_seconds: cached.max_lag_seconds,
  }
}

export function setReplicationLagMemoryEntry(cacheKey: string, status: ReplicationLagStatus, expiresAt = Date.now() + REPLICATION_LAG_CACHE_TTL_MS) {
  replicationLagMemoryCache.set(cacheKey, {
    ...status,
    expiresAt,
  })
}

/** Test helper: forget every known lag figure. */
export function resetReplicationLagMemory() {
  replicationLagMemoryCache.clear()
  replicationLagColoMisses.clear()
}

/** True for a database source that is a read replica (it can be behind the primary). */
export function isReadReplicaSource(source: string) {
  return source.startsWith('HYPERDRIVE_CAPGO_READ_') || source === 'local_read_replica'
}

function isMeasuredBehind(lag: ReplicationLagStatus | null) {
  if (!lag || lag.status === 'unknown' || lag.max_lag_seconds === null)
    return false
  return lag.status === 'lagging' || lag.max_lag_seconds > EDGE_CACHE_MAX_REPLICA_LAG_SECONDS
}

/** Data center lookups that found no lag figure: skip the Cache API read for a while. */
const REPLICATION_LAG_COLO_MISS_MEMO_MS = 10_000
const replicationLagColoMisses = new Map<string, number>()

/**
 * Lag figure for a source: this isolate's, else the data center's (one Cache
 * API read, copied into this isolate, no database query), else null.
 */
async function loadReplicationLag(c: Context, source: string): Promise<ReplicationLagStatus | null> {
  const memory = getFreshReplicationLagMemoryEntry(source)
  if (memory)
    return memory
  const now = Date.now()
  if ((replicationLagColoMisses.get(source) ?? 0) > now)
    return null
  try {
    const helper = new CacheHelper(c)
    const cached = await helper.matchJson<ReplicationLagCacheEntry>(replicationLagCacheRequest(helper, source))
    // A probe may have stored a newer figure while this read awaited.
    const current = getFreshReplicationLagMemoryEntry(source)
    if (current)
      return current
    if (cached && cached.expiresAt > Date.now()) {
      const status = { status: cached.status, max_lag_seconds: cached.max_lag_seconds }
      setReplicationLagMemoryEntry(source, status, cached.expiresAt)
      return status
    }
  }
  catch {
    // Best effort: no figure means fail open.
  }
  replicationLagColoMisses.set(source, now + REPLICATION_LAG_COLO_MISS_MEMO_MS)
  return null
}

/**
 * TTL for an edge cache entry built from replica reads: capped to
 * EDGE_CACHE_UNVERIFIED_REPLICA_TTL_SECONDS when the replica is measured more
 * than EDGE_CACHE_MAX_REPLICA_LAG_SECONDS behind, unchanged otherwise
 * (primary reads, no figure, unknown).
 *
 * `source` defaults to this request's database source; pass the replica an
 * answer came from when the request itself read no database (read cache hit).
 *
 * Measures the replica against its upstream only: regional standbys cannot
 * see the EU subscriber's own lag behind the primary.
 */
export async function edgeCacheTtlForReplicaLag(c: Context, ttlSeconds: number, source = getReplicationLagCacheKey(c)) {
  if (!isReadReplicaSource(source))
    return ttlSeconds
  const lag = await loadReplicationLag(c, source)
  return isMeasuredBehind(lag) ? Math.min(ttlSeconds, EDGE_CACHE_UNVERIFIED_REPLICA_TTL_SECONDS) : ttlSeconds
}
