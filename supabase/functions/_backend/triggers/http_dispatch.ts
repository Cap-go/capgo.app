import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { HttpDispatchRow } from '../utils/http_dispatch.ts'
import { Hono } from 'hono/tiny'
import { middlewareAPISecret } from '../utils/hono.ts'
import { HTTP_DISPATCH_CLAIM_LIMIT, HTTP_DISPATCH_CLAIM_SQL } from '../utils/http_dispatch.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'

export const app = new Hono<MiddlewareKeyVariables>()

// Claims pending HTTP wakeups for the QueueDispatcher Durable Object. Claimed
// rows are deleted: a wakeup lost after this point is re-requested by the next
// cron tick, because the work itself stays in pgmq.
app.post('/claim', middlewareAPISecret, async (c) => {
  const db = await getPgClient(c)
  try {
    const result = await db.query<HttpDispatchRow>(HTTP_DISPATCH_CLAIM_SQL, [HTTP_DISPATCH_CLAIM_LIMIT])
    if (result.rows.length > 0)
      cloudlog({ requestId: c.get('requestId'), message: 'http_dispatch claimed', count: result.rows.length })
    return c.json({ rows: result.rows })
  }
  finally {
    await closeClient(c, db)
  }
})
