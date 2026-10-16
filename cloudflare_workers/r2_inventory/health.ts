import type { Client } from 'pg'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'

export const CLEANUP_HEALTH = Object.freeze({ timeoutMs: 5000, producerAgeMs: 30_000, consumerAgeMs: 120_000, feedbackSeconds: 60, replaySeconds: 30, walBytes: 64 * 1024 * 1024 })
export const REPLICATION = Object.freeze({ subscription: 'capgo_planetscale_r2_sub', slot: 'capgo_planetscale_r2_slot', publication: 'capgo_planetscale_r2_pub' })

// NOW() makes this query uncacheable even on the existing cached source binding.
// Catalog/statistics reads are bounded by replication configuration, never manifest size.
export const SOURCE_HEALTH_SQL = `SELECT sl.active, sl.wal_status, sr.state,
  extract(epoch FROM greatest(now(), clock_timestamp()) - sr.reply_time)::float8 AS feedback_age,
  extract(epoch FROM sr.replay_lag)::float8 AS replay_seconds,
  pg_wal_lsn_diff(pg_current_wal_lsn(), sr.replay_lsn)::text AS wal_bytes,
  EXISTS (SELECT 1 FROM pg_catalog.pg_publication p JOIN pg_catalog.pg_publication_tables t
    ON t.pubname = p.pubname WHERE p.pubname = $2 AND p.pubinsert AND p.pubupdate AND p.pubdelete
    AND t.schemaname = 'public' AND t.tablename = 'manifest' AND t.rowfilter IS NULL
    AND 's3_path' = ANY(t.attnames)) AS publication_ok
  FROM pg_catalog.pg_replication_slots sl LEFT JOIN pg_catalog.pg_stat_replication sr ON sr.pid = sl.active_pid
  WHERE sl.slot_name = $1 AND sl.slot_type = 'logical'`

export const DESTINATION_HEALTH_SQL = `SELECT s.subenabled, s.subslotname, s.subpublications,
  st.pid, r.srsubstate, clock_timestamp()::text AS observed_at,
  extract(epoch FROM clock_timestamp() - st.last_msg_receipt_time)::float8 AS receipt_age,
  es.apply_error_count::text, es.sync_error_count::text
  FROM pg_catalog.pg_subscription s
  LEFT JOIN pg_catalog.pg_stat_subscription st ON st.subid = s.oid AND st.worker_type = 'apply'
  LEFT JOIN pg_catalog.pg_subscription_rel r ON r.srsubid = s.oid AND r.srrelid = 'public.manifest'::regclass
  LEFT JOIN pg_catalog.pg_stat_subscription_stats es ON es.subid = s.oid WHERE s.subname = $1`

interface SourceHealth { active: boolean, wal_status: string, state: string, feedback_age: number | null, replay_seconds: number | null, wal_bytes: string | null, publication_ok: boolean }
interface DestinationHealth { subenabled: boolean, subslotname: string, subpublications: string[], pid: number | null, srsubstate: string, receipt_age: number | null, observed_at: string, apply_error_count: string, sync_error_count: string }
export interface CleanupHealth {
  schemaVersion: 3
  healthy: boolean
  checkedAt: number
  observedAt: string
  maxAgeSeconds: number
  manifestReplicationHealthy: boolean
  reasons: string[]
  replication?: { source: SourceHealth | null, destination: DestinationHealth | null }
}
const within = (value: unknown, maximum: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum

export function replicationHealthy(source: SourceHealth | undefined, destination: DestinationHealth | undefined): boolean {
  return !!source && !!destination && source.active === true && ['reserved', 'extended'].includes(source.wal_status)
    && source.state === 'streaming' && source.publication_ok === true
    && within(source.feedback_age, CLEANUP_HEALTH.feedbackSeconds)
    && typeof source.wal_bytes === 'string' && /^\d+$/.test(source.wal_bytes)
    && BigInt(source.wal_bytes) <= BigInt(CLEANUP_HEALTH.walBytes)
    && (source.replay_seconds === null || within(source.replay_seconds, CLEANUP_HEALTH.replaySeconds))
    && destination.subenabled === true && destination.subslotname === REPLICATION.slot
    && destination.subpublications?.length === 1 && destination.subpublications[0] === REPLICATION.publication
    && Number.isSafeInteger(destination.pid) && Number(destination.pid) > 0 && destination.srsubstate === 'r'
    && within(destination.receipt_age, CLEANUP_HEALTH.feedbackSeconds)
}

export function requireCleanupHealth(health: CleanupHealth): void {
  if (health.healthy !== true || !within(Date.now() - health.checkedAt, CLEANUP_HEALTH.producerAgeMs))
    throw new Error('Cleanup health check failed or expired')
}

// Owns connection establishment: both database reads start together.
// The caller reuses inventory for production work only after this function succeeds.
export async function checkCleanupHealth(source: Client, inventory: Client, bucket: string): Promise<CleanupHealth> {
  const started = Date.now()
  const deadline = started + CLEANUP_HEALTH.timeoutMs
  const health: CleanupHealth = { schemaVersion: 3, healthy: false, checkedAt: started, observedAt: new Date(started).toISOString(), maxAgeSeconds: CLEANUP_HEALTH.consumerAgeMs / 1000, manifestReplicationHealthy: false, reasons: [] }
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    void source.end().catch(() => {})
    void inventory.end().catch(() => {})
  }
  const remaining = () => {
    if (expired || Date.now() >= deadline)
      throw new Error('Cleanup health timeout')
  }
  const read = async (client: Client, text: string, values: string[]) => {
    await client.connect()
    remaining()
    const row = await drizzle({ client }).transaction(async (tx) => {
      remaining()
      // Arm on the checked-out connection before the parameterized SELECT.
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`)
      remaining()
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '4s'`)
      remaining()
      const result = await client.query(text, values)
      remaining()
      return result.rows.length === 1 ? result.rows[0] : undefined
    }, { accessMode: 'read only' })
    remaining()
    return row
  }
  try {
    await Promise.race([
      (async () => {
        const results = await Promise.allSettled([
          read(source, SOURCE_HEALTH_SQL, [REPLICATION.slot, REPLICATION.publication]),
          read(inventory, DESTINATION_HEALTH_SQL, [REPLICATION.subscription]),
        ])
        remaining()
        const value = (i: number) => results[i]?.status === 'fulfilled' ? (results[i] as PromiseFulfilledResult<any>).value : undefined
        health.manifestReplicationHealthy = replicationHealthy(value(0), value(1))
        health.replication = { source: value(0) ?? null, destination: value(1) ?? null }
        health.observedAt = value(1)?.observed_at ? new Date(value(1).observed_at).toISOString() : health.observedAt
        if (!health.manifestReplicationHealthy)
          health.reasons.push('replication_unhealthy_or_unknown')
        health.healthy = health.manifestReplicationHealthy
        // Publication is part of the five-second operation. Never read this row
        // in the producer; the future consumer checks schema, flags and freshness.
        remaining()
        await drizzle({ client: inventory }).transaction(async (tx) => {
          remaining()
          const writeMs = Math.max(1, deadline - Date.now() - 100)
          await tx.execute(sql`SELECT set_config('statement_timeout', ${`${writeMs}ms`}, true),
            set_config('lock_timeout', '500ms', true), set_config('idle_in_transaction_session_timeout', ${`${writeMs}ms`}, true)`)
          remaining()
          const publication = await inventory.query(`INSERT INTO public.r2_inventory_checkpoints AS c (bucket_name, job_name, checkpoint)
            VALUES ($1, 'cleanup_health', $2::jsonb) ON CONFLICT (bucket_name, job_name, partition_key)
            DO UPDATE SET checkpoint = EXCLUDED.checkpoint
            WHERE (c.checkpoint->>'observedAt')::timestamptz <= ($2::jsonb->>'observedAt')::timestamptz
            RETURNING 1`, [bucket, JSON.stringify(health)])
          if (publication.rows.length !== 1)
            throw new Error('Newer cleanup health already published')
          remaining()
        })
        remaining()
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          close()
          reject(new Error('Cleanup health timeout'))
        }, CLEANUP_HEALTH.timeoutMs)
      }),
    ])
  }
  catch {
    health.healthy = false
    health.reasons.push(expired || Date.now() >= deadline ? 'health_timeout' : 'health_query_or_write_failed')
    close()
  }
  finally {
    clearTimeout(timer)
  }
  return health
}
