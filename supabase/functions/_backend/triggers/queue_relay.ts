import type { Context } from 'hono'
import type { HttpDispatchRow } from '../utils/http_dispatch.ts'
import type { getPgClient } from '../utils/pg.ts'
import type { RelayedQueueMessage } from './queue_consumer.ts'
import { coalesceHttpDispatchRows, HTTP_DISPATCH_MAX_CALLS_PER_ROW } from '../utils/http_dispatch.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { DEFAULT_BATCH_SIZE, getQueueBatchSize, getQueueVisibilityTimeout, PGMQ_QUEUE_NAME_PATTERN } from './queue_consumer.ts'

/**
 * Moves pgmq work into Cloudflare Queues for queues whose wakeups are routed
 * to Cloudflare (public.http_dispatch_targets.runtime = 'cloudflare').
 *
 * The database still enqueues in pgmq inside the writing transaction and
 * pg_cron still wakes a queue only when it has readable messages. Instead of
 * calling the Supabase queue_consumer, the claim reads those messages here and
 * sends their ids to Cloudflare Queues. Each delivered batch is its own Worker
 * invocation (cloudflare_workers/api/pgmq_relay.ts), so the work spreads over
 * as many invocations as the backlog needs, each with its own connection
 * limit, which one Worker or Durable Object calling itself could not do.
 *
 * pgmq stays the source of truth and the retry counter. The relay only hides
 * the messages it sends; the consumer's claim counts the read (read_ct + 1)
 * and only succeeds for the read_ct the message was relayed with, so every
 * processing attempt costs one of the five reads, however often Cloudflare
 * Queues delivers or retries a copy.
 */

interface RelayQueue {
  sendBatch: (messages: Iterable<{ body: RelayedQueueMessage, contentType?: 'json' }>) => Promise<unknown>
}

type PgClient = Awaited<ReturnType<typeof getPgClient>>

// Cloudflare Queues accepts at most 100 messages per sendBatch call.
export const PGMQ_RELAY_SEND_BATCH_SIZE = 100
// A wakeup asks for what the Supabase consumers it replaces would read (up to
// 10 consumers of up to 950 messages), so the relay keeps their throughput.
// One claim relays at most this many across its wakeups. The dispatcher claims
// at most once a second, so this is also the Cloudflare Queues limit of 5,000
// messages per second per queue. The rest stays readable in pgmq for the next
// wakeup.
export const PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM = 5000
// The dispatcher waits 10 seconds for the claim; stop relaying well before.
export const PGMQ_RELAY_BUDGET_MS = 4000
// The relay hides messages for the queue's usual visibility timeout plus this
// delivery allowance; the consumer restarts the timeout when it claims a
// message, so the allowance only covers time spent waiting in Cloudflare Queues.
export const PGMQ_RELAY_DELIVERY_GRACE_SECONDS = 300

function pgmqTable(queueName: string): string {
  if (!PGMQ_QUEUE_NAME_PATTERN.test(queueName))
    throw new Error(`Invalid pgmq queue name: ${queueName}`)
  return `pgmq."q_${queueName}"`
}

/**
 * pgmq.read without the read_ct increment ($1 = visibility timeout in seconds,
 * $2 = limit): the read is counted when the consumer claims the message. Only
 * ids and read counts leave the database. A top-level UPDATE is never served
 * from the Hyperdrive query cache.
 *
 * Queues often hold many hidden messages (relayed, retrying or delayed), so
 * the read must not scan past them: the cutoff is now() (the statement start,
 * as each query runs in its own transaction) rather than the volatile
 * clock_timestamp(), so it bounds a range scan of pgmq's vt index, and the
 * rows are taken in vt order (oldest visible first) so that scan returns them
 * directly instead of filtering the queue in msg_id order. ANY(ARRAY(...))
 * keeps the update itself on the primary key. Same reason as
 * process_function_queue's bound cutoff.
 */
export function pgmqRelayReadSql(queueName: string): string {
  const table = pgmqTable(queueName)
  return `UPDATE ${table} AS m
SET vt = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => $1::double precision)
WHERE m.msg_id = ANY (ARRAY(
  SELECT readable.msg_id
  FROM ${table} AS readable
  WHERE readable.vt <= pg_catalog.now()
  ORDER BY readable.vt
  LIMIT $2
  FOR UPDATE SKIP LOCKED
))
RETURNING m.msg_id, m.read_ct`
}

/**
 * Makes messages that could not be sent readable again at once, so a
 * Cloudflare Queues outage does not hide them for the visibility timeout.
 * Only rows still at the relayed read_ct (never claimed) are touched.
 */
export function pgmqRelayReleaseSql(queueName: string): string {
  return `UPDATE ${pgmqTable(queueName)} AS m
SET vt = pg_catalog.clock_timestamp()
FROM ROWS FROM (pg_catalog.unnest($1::bigint[]), pg_catalog.unnest($2::integer[])) AS relayed(msg_id, read_ct)
WHERE m.msg_id = relayed.msg_id AND m.read_ct = relayed.read_ct`
}

export interface PgmqRelayWakeup {
  queueName: string
  maxMessages: number
  visibilityTimeoutSeconds: number
  waitForCompletion: boolean
}

/** The pgmq read a process_function_queue wakeup asks for, or null when the row is not one. */
export function parsePgmqRelayWakeup(row: HttpDispatchRow): PgmqRelayWakeup | null {
  const body = row.body && typeof row.body === 'object' ? row.body as Record<string, unknown> : {}
  const queueName = body.queue_name
  if (typeof queueName !== 'string' || queueName !== row.target || !PGMQ_QUEUE_NAME_PATTERN.test(queueName))
    return null
  const requestedBatchSize = typeof body.batch_size === 'number' && body.batch_size > 0
    ? Math.min(Math.trunc(body.batch_size), DEFAULT_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE
  const calls = Math.min(Math.max(Math.trunc(row.calls), 1), HTTP_DISPATCH_MAX_CALLS_PER_ROW)
  return {
    queueName,
    maxMessages: calls * getQueueBatchSize(queueName, requestedBatchSize),
    visibilityTimeoutSeconds: getQueueVisibilityTimeout(queueName) + PGMQ_RELAY_DELIVERY_GRACE_SECONDS,
    waitForCompletion: body.wait_for_completion === true,
  }
}

export interface PgmqRelayResult {
  relayed: number
  released: number
  rejected: number
  deferred: number
}

async function releaseUnsent(c: Context, db: PgClient, queueName: string, unsent: RelayedQueueMessage[]): Promise<number> {
  try {
    await db.query(pgmqRelayReleaseSql(queueName), [unsent.map(message => message.msg_id), unsent.map(message => message.read_ct)])
    return unsent.length
  }
  catch (error) {
    // They become readable again when the relay visibility timeout ends.
    cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_release_failed', queueName, count: unsent.length, error: serializeError(error) })
    return 0
  }
}

/**
 * Relays the claimed queue wakeups. Work it does not get to (budget reached,
 * or a read failed) is not lost: it is still readable in pgmq, so the next
 * pg_cron tick wakes the queue again.
 *
 * pg_cron writes the same wakeups in the same order every tick, and a wakeup
 * the claim does not get to is dropped until the next tick, so relaying them
 * in turn until the cap or the time budget ran out would let a busy queue
 * starve the ones after it indefinitely. Instead the smallest requests go
 * first and each wakeup takes at most an equal share of the messages and of
 * the time still left: small requests are served in full, the busy queues
 * split the rest, and a queue that needs less leaves its share to the next.
 */
export async function relayPgmqWakeups(
  c: Context,
  db: PgClient,
  queue: RelayQueue,
  rows: readonly HttpDispatchRow[],
  now: () => number = Date.now,
): Promise<PgmqRelayResult> {
  const result: PgmqRelayResult = { relayed: 0, released: 0, rejected: 0, deferred: 0 }
  const startedAt = now()
  let remaining = PGMQ_RELAY_MAX_MESSAGES_PER_CLAIM

  const wakeups: PgmqRelayWakeup[] = []
  for (const row of coalesceHttpDispatchRows(rows)) {
    const wakeup = parsePgmqRelayWakeup(row)
    if (wakeup) {
      wakeups.push(wakeup)
      continue
    }
    result.rejected++
    cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_invalid_wakeup', target: row.target })
  }
  wakeups.sort((a, b) => a.maxMessages - b.maxMessages)

  for (const [index, wakeup] of wakeups.entries()) {
    const wakeupsLeft = wakeups.length - index
    const timeLeft = PGMQ_RELAY_BUDGET_MS - (now() - startedAt)
    if (remaining <= 0 || timeLeft <= 0) {
      result.deferred += wakeupsLeft
      break
    }
    const deadline = now() + timeLeft / wakeupsLeft

    let messages: RelayedQueueMessage[]
    try {
      const read = await db.query<{ msg_id: string | number, read_ct: number }>(pgmqRelayReadSql(wakeup.queueName), [
        wakeup.visibilityTimeoutSeconds,
        Math.min(wakeup.maxMessages, Math.ceil(remaining / wakeupsLeft)),
      ])
      messages = read.rows
        .map(message => ({
          queue_name: wakeup.queueName,
          msg_id: Number(message.msg_id),
          read_ct: Number(message.read_ct),
          ...(wakeup.waitForCompletion ? { wait_for_completion: true } : {}),
        }))
        .sort((a, b) => a.msg_id - b.msg_id)
    }
    catch (error) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_read_failed', queueName: wakeup.queueName, error: serializeError(error) })
      continue
    }
    remaining -= messages.length

    const relayedBefore = result.relayed
    for (let start = 0; start < messages.length; start += PGMQ_RELAY_SEND_BATCH_SIZE) {
      if (now() >= deadline) {
        // A slow read or slow sends: give the rest back now instead of hiding
        // it until the relay visibility timeout, and leave the time left to
        // the other wakeups.
        cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_budget_exhausted', queueName: wakeup.queueName, unsent: messages.length - start })
        result.released += await releaseUnsent(c, db, wakeup.queueName, messages.slice(start))
        break
      }
      const chunk = messages.slice(start, start + PGMQ_RELAY_SEND_BATCH_SIZE)
      try {
        await queue.sendBatch(chunk.map(body => ({ body, contentType: 'json' as const })))
        result.relayed += chunk.length
      }
      catch (error) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_send_failed', queueName: wakeup.queueName, unsent: messages.length - start, error: serializeError(error) })
        result.released += await releaseUnsent(c, db, wakeup.queueName, messages.slice(start))
        // Cloudflare Queues is failing: leave the other wakeups unread too.
        result.deferred += wakeupsLeft - 1
        return result
      }
    }
    if (result.relayed > relayedBefore)
      cloudlog({ requestId: c.get('requestId'), message: 'pgmq_relay_sent', queueName: wakeup.queueName, count: result.relayed - relayedBefore })
  }
  return result
}
