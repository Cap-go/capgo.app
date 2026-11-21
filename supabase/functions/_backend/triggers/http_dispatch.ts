import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { HttpDispatchRow } from '../utils/http_dispatch.ts'
import { Hono } from 'hono/tiny'
import { middlewareAPISecret } from '../utils/hono.ts'
import { HTTP_DISPATCH_CLAIM_LIMIT, HTTP_DISPATCH_CLAIM_SQL, isCloudflareQueueWakeup } from '../utils/http_dispatch.ts'
import { cloudlog, cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'
import { relayPgmqWakeups } from './queue_relay.ts'

export const app = new Hono<MiddlewareKeyVariables>()

// Claims pending HTTP wakeups for the QueueDispatcher Durable Object. Claimed
// rows are deleted: a wakeup lost after this point is re-requested by the next
// cron tick, because the work itself stays in pgmq.
//
// Queue wakeups routed to Cloudflare are relayed here into Cloudflare Queues
// and not returned; the dispatcher sends every other row.
app.post('/claim', middlewareAPISecret, async (c) => {
  const db = await getPgClient(c)
  try {
    const result = await db.query<HttpDispatchRow>(HTTP_DISPATCH_CLAIM_SQL, [HTTP_DISPATCH_CLAIM_LIMIT])
    if (result.rows.length > 0)
      cloudlog({ requestId: c.get('requestId'), message: 'http_dispatch claimed', count: result.rows.length })

    const queueWakeups = result.rows.filter(isCloudflareQueueWakeup)
    if (queueWakeups.length === 0)
      return c.json({ rows: result.rows })

    const rows = result.rows.filter(row => !isCloudflareQueueWakeup(row))
    const relayQueue = c.env.PGMQ_RELAY_QUEUE
    if (!relayQueue) {
      // Misconfigured environment: keep the queues running through the stored
      // Supabase consumer URL rather than leaving the work unprocessed.
      cloudlogErr({ requestId: c.get('requestId'), message: 'pgmq_relay_unavailable', count: queueWakeups.length })
      return c.json({ rows: [...rows, ...queueWakeups.map(row => ({ ...row, runtime: 'supabase' }))] })
    }

    const relay = await relayPgmqWakeups(c, db, relayQueue, queueWakeups)
    cloudlog({ requestId: c.get('requestId'), message: 'pgmq_relay finished', ...relay })
    return c.json({ rows })
  }
  finally {
    await closeClient(c, db)
  }
})
