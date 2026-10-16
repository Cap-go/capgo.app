import type { ClientBase } from 'pg'
import type { ObservationSnapshot } from '../../supabase/functions/_backend/utils/r2_inventory.ts'
import type { CleanupMessage } from './cleanup.ts'
import { INVENTORY_CONFIG, inventoryTransaction, readObservationSnapshot, timestampUs } from '../../supabase/functions/_backend/utils/r2_inventory.ts'

export const CLEANUP_CONSUMER = Object.freeze({
  groupSize: 20,
  concurrency: 4,
  objectMs: 20_000,
  batchMs: 600_000,
  reserveMs: 15_000,
  replicationMaxAgeSeconds: 300,
})
export type CleanupDecision = 'remove' | 'retry' | 'obsolete' | 'completed' | 'referenced' | 'leased'
export interface CleanupInspection {
  snapshot: ObservationSnapshot
  decisions: Map<CleanupMessage, CleanupDecision>
  healthUntil: number
}

export function parseCleanupMessage(body: unknown, bucket: string): CleanupMessage {
  const data = body as Partial<CleanupMessage> | null
  if (!data || bucket !== 'capgo' || data.schemaVersion !== 1 || data.bucket !== bucket
    || typeof data.key !== 'string' || data.key.includes('\0') || new TextEncoder().encode(data.key).length > 1024
    || !/^orgs\/[^/]+\/apps\/[^/]+\/delta\/[^/]+(?:\/[^/]+)*$/.test(data.key)
    || /(?:^|\/)(?:\.|\.\.|trash)(?:\/|$)/.test(data.key) || /\.zip(?:$|\/)/i.test(data.key)
    || typeof data.cleanupRequestedAt !== 'string' || !/\.\d{6}Z$/.test(data.cleanupRequestedAt)) {
    throw new Error('Invalid cleanup identity or scope')
  }
  timestampUs(data.cleanupRequestedAt)
  return data as CleanupMessage
}

async function shortTransaction<T>(db: ClientBase, work: () => Promise<T>): Promise<T> {
  return inventoryTransaction(db, async () => {
    await db.query(`SET LOCAL statement_timeout = '2s'`)
    await db.query(`SET LOCAL lock_timeout = '500ms'`)
    await db.query(`SET LOCAL idle_in_transaction_session_timeout = '5s'`)
    await db.query(`SET LOCAL row_security = off`)
    return work()
  })
}

export async function inspectCleanupGroup(db: ClientBase, bucket: string, messages: CleanupMessage[]): Promise<CleanupInspection> {
  if (!messages.length || messages.length > CLEANUP_CONSUMER.groupSize)
    throw new Error('Cleanup inspection group exceeds bound')
  return shortTransaction(db, async () => {
    const health = await db.query<{ checkpoint: Record<string, unknown>, age: number }>(`SELECT checkpoint,
      extract(epoch FROM clock_timestamp()-(checkpoint->>'observedAt')::timestamptz)::float8 AS age FROM public.r2_inventory_checkpoints
      WHERE bucket_name=$1 AND job_name='cleanup_health' AND partition_key=''`, [bucket])
    const row = health.rows[0]
    const observedAt = row?.checkpoint?.observedAt
    const age = row?.age
    // Consumer evidence deliberately excludes producer backlog/notification gates.
    if ((row?.checkpoint.schemaVersion !== 1 && row?.checkpoint.schemaVersion !== 2 && row?.checkpoint.schemaVersion !== 3) || row.checkpoint.manifestReplicationHealthy !== true
      || typeof observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(observedAt)
      || !Number.isFinite(age) || age < 0 || age > CLEANUP_CONSUMER.replicationMaxAgeSeconds) {
      throw new Error('Manifest replication evidence unavailable')
    }
    // Validate the calendar separately too: Date.parse can normalize invalid days.
    timestampUs(observedAt.replace(/(?:Z|[+-]\d\d:\d\d)$/, 'Z'))
    const healthUntil = Date.now() + (CLEANUP_CONSUMER.replicationMaxAgeSeconds - age) * 1000
    const keys = [...new Set(messages.map(message => message.key))]
    const snapshot = await readObservationSnapshot(db, bucket, keys)
    // All reference probes start from the delivered PKs. row_security=off makes
    // a policy-filtered probe fail instead of authorizing deletion on hidden rows.
    // Accepted limitation while inventory and manifest writes use separate databases:
    // set_manifest renews the inventory lease before committing manifest rows in
    // Supabase. A save that outlives that lease could commit a reference after this
    // check and deletion. Visible references and active leases remain protected.
    // Defer shared transactional coordination of finalization and retirement to
    // the planned inventory move into Supabase.
    const safety = await db.query<{ r2_key: string, retired_at: string | null, revision: string, r2_state: string, referenced: boolean, leased: boolean }>(`SELECT r2_key, revision::text, r2_state,
      to_char(cleanup_requested_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS retired_at,
      EXISTS (SELECT 1 FROM public.manifest m WHERE m.s3_path=o.r2_key) AS referenced,
      coalesce(manifest_lease_expires_at > clock_timestamp(),false) AS leased
      FROM public.r2_objects o WHERE bucket_name=$1 AND r2_key=ANY($2::text[])`, [bucket, keys])
    const facts = new Map(safety.rows.map(fact => [fact.r2_key, fact]))
    const previous = new Map(snapshot.rows.map(item => [item.r2_key, item]))
    const decisions = new Map<CleanupMessage, CleanupDecision>()
    for (const message of messages) {
      const fact = facts.get(message.key)
      const before = previous.get(message.key)
      const decision: CleanupDecision = !fact?.retired_at
        ? 'retry'
        : fact.retired_at !== message.cleanupRequestedAt
          ? 'obsolete'
          : fact.r2_state === 'deleted'
            ? 'completed'
            : fact.r2_state !== 'to_be_deleted' || before?.revision !== fact.revision
              ? 'retry'
              : fact.referenced ? 'referenced' : fact.leased ? 'leased' : 'remove'
      decisions.set(message, decision)
    }
    return { snapshot, decisions, healthUntil }
  })
}

export async function completeCleanupGroup(db: ClientBase, bucket: string, snapshot: ObservationSnapshot, keys: string[]) {
  if (keys.length > CLEANUP_CONSUMER.groupSize || Date.now() - Date.parse(snapshot.startedAt) > 120_000)
    throw new Error('Cleanup completion observation expired or exceeded bound')
  const previous = new Map(snapshot.rows.map(row => [row.r2_key, row]))
  const input = keys.map(key => ({ key, revision: previous.get(key)?.revision, firstSeenUs: previous.get(key)?.first_seen_us }))
  return shortTransaction(db, async () => {
    // Preserve retirement/metadata and event history; compare both the captured
    // row revision/identity and observation watermarks. Never manufacture eventTime.
    const result = await db.query<{ r2_key: string }>(`UPDATE public.r2_objects AS target SET
      r2_state='deleted'::public.r2_object_state, last_reconciled_at=$3::timestamptz,
      tombstone_expires_at=coalesce(target.tombstone_expires_at,now()+$4::int*interval '1 day')
      FROM jsonb_to_recordset($2::jsonb) AS x(key text, revision bigint, "firstSeenUs" bigint)
      WHERE target.bucket_name=$1 AND target.r2_key=x.key AND target.revision=x.revision
        AND (extract(epoch FROM target.first_seen_at)*1000000)::bigint=x."firstSeenUs"
        AND target.cleanup_requested_at IS NOT NULL AND target.r2_state='to_be_deleted'
        AND (target.last_event_at IS NULL OR target.last_event_at <= $3::timestamptz)
        AND (target.last_reconciled_at IS NULL OR target.last_reconciled_at <= $3::timestamptz)
      RETURNING target.r2_key`, [bucket, JSON.stringify(input), snapshot.startedAt, INVENTORY_CONFIG.tombstoneDays])
    const applied = new Set(result.rows.map(row => row.r2_key))
    return keys.filter(key => !applied.has(key))
  })
}
