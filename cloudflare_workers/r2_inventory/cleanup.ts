import type { Client, ClientBase } from 'pg'
import type { CleanupHealth } from './health.ts'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { requireCleanupHealth } from './health.ts'

export const CLEANUP_ACTIVATED = true
export const CLEANUP_CONFIG = Object.freeze({
  pageRows: 10_000,
  transactionRows: 100,
  runMs: 20_000,
  reserveMs: 5_000,
  publicationMs: 2_000,
  leaseSeconds: 45,
  batchBytes: 256_000,
  messageBytes: 128_000,
  deliveryDelaySeconds: 30,
})

export interface CleanupMessage {
  schemaVersion: 1
  bucket: string
  key: string
  cleanupRequestedAt: string
}
export interface CleanupQueue {
  sendBatch: (messages: MessageSendRequest<CleanupMessage>[], options?: QueueSendBatchOptions) => Promise<unknown>
}
export interface CleanupLease { owner: string, fence: string, cursor: string }
export interface CleanupRow { r2_key: string, eligible: boolean }
const encoder = new TextEncoder()
const job = 'cleanup_producer'

// Page first, then filter/probe: even an entirely ineligible page is bounded.
// Both discovery and the locked recheck use precisely the same predicate.
const eligibility = `r2_state = 'present' AND cleanup_requested_at IS NULL
  AND r2_key ~ '^orgs/[^/]+/apps/[^/]+/delta/[^/]+(/[^/]+)*$'
  AND r2_key !~ '(^|/)([.]|[.][.]|trash)(/|$)' AND r2_key !~* '[.]zip($|/)'
  AND first_seen_at <= statement_timestamp() - interval '1 hour'
  AND greatest(r2_last_modified_at, last_event_at) <= statement_timestamp() - interval '1 hour'
  AND (manifest_lease_expires_at IS NULL OR manifest_lease_expires_at <= statement_timestamp())
  AND NOT EXISTS (SELECT 1 FROM public.manifest AS m WHERE m.s3_path = r2_key)`

export async function acquireCleanupLease(db: ClientBase, bucket: string, owner: string): Promise<CleanupLease | null> {
  // The conflict update is serialized by the checkpoint PK. No admission data changes.
  const result = await db.query<CleanupLease>(`INSERT INTO public.r2_inventory_checkpoints AS c
    (bucket_name, job_name, checkpoint) VALUES ($1, $2,
      jsonb_build_object('owner', $3::text, 'fence', '1', 'cursor', '',
        'leaseUntil', clock_timestamp() + $4::int * interval '1 second'))
    ON CONFLICT (bucket_name, job_name, partition_key) DO UPDATE SET checkpoint =
      c.checkpoint || jsonb_build_object('owner', $3::text,
        'fence', ((c.checkpoint->>'fence')::bigint + 1)::text,
        'leaseUntil', clock_timestamp() + $4::int * interval '1 second')
    WHERE (c.checkpoint->>'leaseUntil')::timestamptz <= clock_timestamp()
    RETURNING checkpoint->>'owner' AS owner, checkpoint->>'fence' AS fence,
      coalesce(checkpoint->>'cursor', '') AS cursor`, [bucket, job, owner, CLEANUP_CONFIG.leaseSeconds])
  return result.rows[0] ?? null
}

export async function releaseCleanupLease(db: ClientBase, bucket: string, lease: CleanupLease) {
  await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint =
    checkpoint || jsonb_build_object('leaseUntil', clock_timestamp())
    WHERE bucket_name = $1 AND job_name = $2 AND partition_key = ''
      AND checkpoint->>'owner' = $3 AND checkpoint->>'fence' = $4`, [bucket, job, lease.owner, lease.fence])
}

export async function discoverCleanupPage(db: ClientBase, bucket: string, cursor: string): Promise<CleanupRow[]> {
  const result = await db.query<CleanupRow>(`WITH page AS MATERIALIZED (
    SELECT * FROM public.r2_objects WHERE bucket_name = $1
      AND r2_key >= 'orgs/' COLLATE "C" AND r2_key < 'orgs0' COLLATE "C"
      AND r2_key > $2::text COLLATE "C" ORDER BY r2_key COLLATE "C" LIMIT $3
    ) SELECT r2_key, coalesce((${eligibility}), false) AS eligible
      FROM page ORDER BY r2_key COLLATE "C"`, [bucket, cursor, CLEANUP_CONFIG.pageRows])
  return result.rows
}

export function cleanupMessageBatches(messages: CleanupMessage[]): MessageSendRequest<CleanupMessage>[][] {
  const batches: MessageSendRequest<CleanupMessage>[][] = []
  let current: MessageSendRequest<CleanupMessage>[] = []
  let bytes = 2
  for (const body of messages) {
    // Include the wrapper and JSON escaping; this conservatively exceeds body bytes.
    const request: MessageSendRequest<CleanupMessage> = { body, contentType: 'json' }
    const size = encoder.encode(JSON.stringify(request)).length + 1
    if (size > CLEANUP_CONFIG.messageBytes)
      throw new Error('Cleanup message exceeds byte limit')
    if (current.length && (current.length === 100 || bytes + size > CLEANUP_CONFIG.batchBytes)) {
      batches.push(current)
      current = []
      bytes = 2
    }
    current.push(request)
    bytes += size
  }
  if (current.length)
    batches.push(current)
  return batches
}

export async function publicationDeadline(operation: () => Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cleanup publication deadline exceeded; acceptance is ambiguous')), milliseconds)
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

export async function retireCleanupRange(db: ClientBase, bucket: string, lease: CleanupLease, keys: string[], cursor: string, queue: CleanupQueue, deadline: number, health: CleanupHealth): Promise<number> {
  if (keys.length > CLEANUP_CONFIG.transactionRows || new Set(keys).size !== keys.length)
    throw new Error('Cleanup retirement exceeds bound or contains duplicate keys')
  return drizzle({ client: db as Client }).transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '2s'`)
    await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`)
    await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout = '5s'`)
    // Do not confuse a policy-hidden replicated reference with authoritative absence.
    // This setting throws for RLS-filtered reads; it does not bypass RLS.
    await tx.execute(sql`SET LOCAL row_security = off`)
    const fenced = await db.query(`SELECT 1 FROM public.r2_inventory_checkpoints
      WHERE bucket_name = $1 AND job_name = $2 AND partition_key = ''
        AND checkpoint->>'owner' = $3 AND checkpoint->>'fence' = $4
        AND (checkpoint->>'leaseUntil')::timestamptz > clock_timestamp() FOR UPDATE`, [bucket, job, lease.owner, lease.fence])
    if (!fenced.rows.length)
      throw new Error('Cleanup lease lost')
    requireCleanupHealth(health)
    // Lock first, then use a fresh READ COMMITTED statement snapshot for the recheck.
    // Reservations serialize on the very same rows; a reservation that won is preserved.
    await db.query(`SELECT r2_key FROM public.r2_objects WHERE bucket_name = $1
      AND r2_key = ANY($2::text[]) ORDER BY r2_key COLLATE "C" FOR UPDATE`, [bucket, keys])
    const retired = await db.query<{ r2_key: string, cleanup_requested_at: string }>(`UPDATE public.r2_objects
      SET r2_state = 'to_be_deleted' WHERE bucket_name = $1 AND r2_key = ANY($2::text[])
        AND ${eligibility} RETURNING r2_key,
        to_char(cleanup_requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cleanup_requested_at`, [bucket, keys])
    const messages = retired.rows.map(row => ({ schemaVersion: 1 as const, bucket, key: row.r2_key, cleanupRequestedAt: row.cleanup_requested_at }))
    if (Date.now() + CLEANUP_CONFIG.reserveMs >= deadline)
      throw new Error('Cleanup work budget exhausted')
    // A resolving sendBatch confirms durable publication, not consumption. The timer
    // cannot cancel late acceptance; the consumer MUST check committed retirement.
    let publishing = true
    const publicationUntil = Date.now() + CLEANUP_CONFIG.publicationMs
    try {
      await publicationDeadline(async () => {
        for (const batch of cleanupMessageBatches(messages)) {
          if (!publishing || Date.now() >= publicationUntil)
            throw new Error('Cleanup publication stopped')
          await queue.sendBatch(batch, { delaySeconds: CLEANUP_CONFIG.deliveryDelaySeconds })
        }
      }, CLEANUP_CONFIG.publicationMs)
    }
    finally {
      // A late resolution may not start another send after this transaction ends.
      publishing = false
    }
    if (Date.now() >= deadline)
      throw new Error('Cleanup work budget exhausted after publication')
    const progress = await db.query(`UPDATE public.r2_inventory_checkpoints SET checkpoint =
      checkpoint || jsonb_build_object('cursor', $5::text)
      WHERE bucket_name = $1 AND job_name = $2 AND partition_key = ''
        AND checkpoint->>'owner' = $3 AND checkpoint->>'fence' = $4
        AND (checkpoint->>'leaseUntil')::timestamptz > clock_timestamp() RETURNING 1`, [bucket, job, lease.owner, lease.fence, cursor])
    if (!progress.rows.length)
      throw new Error('Cleanup lease expired before commit')
    return messages.length
  })
}

export function cleanupRanges(page: CleanupRow[]) {
  const ranges: { keys: string[], cursor: string }[] = []
  let keys: string[] = []
  let cursor = ''
  for (const row of page) {
    if (row.eligible && keys.length === CLEANUP_CONFIG.transactionRows) {
      ranges.push({ keys, cursor })
      keys = []
    }
    if (row.eligible)
      keys.push(row.r2_key)
    cursor = row.r2_key
  }
  if (page.length)
    ranges.push({ keys, cursor })
  return ranges
}

export async function runCleanupProducer(db: ClientBase, bucket: string, queue: CleanupQueue, health: CleanupHealth): Promise<number> {
  const deadline = Date.now() + CLEANUP_CONFIG.runMs
  await db.query(`SET statement_timeout = '5s'`)
  await db.query(`SET lock_timeout = '500ms'`)
  await db.query(`SET row_security = off`)
  requireCleanupHealth(health)
  const lease = await acquireCleanupLease(db, bucket, crypto.randomUUID())
  if (!lease)
    return 0
  let retired = 0
  try {
    while (Date.now() + CLEANUP_CONFIG.reserveMs < deadline) {
      const page = await discoverCleanupPage(db, bucket, lease.cursor)
      if (!page.length) {
        await retireCleanupRange(db, bucket, lease, [], '', queue, deadline, health)
        break // Persist wrap and revisit behind-cursor inserts on the next run.
      }
      for (const range of cleanupRanges(page)) {
        if (Date.now() + CLEANUP_CONFIG.reserveMs >= deadline)
          return retired
        retired += await retireCleanupRange(db, bucket, lease, range.keys, range.cursor, queue, deadline, health)
        // Advance only after an unambiguously successful DB commit. On any error,
        // terminate this invocation; the next run reloads the durable checkpoint.
        lease.cursor = range.cursor
      }
    }
    return retired
  }
  finally {
    try {
      await releaseCleanupLease(db, bucket, lease)
    }
    catch {
      // Preserve the original failure, including an ambiguous commit. Crash expiry
      // safely recovers a lease if the connection no longer permits release.
      console.error(JSON.stringify({ event: 'r2_cleanup_lease_release_failed' }))
    }
  }
}
