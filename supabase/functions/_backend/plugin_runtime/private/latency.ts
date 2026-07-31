import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient, selectOne } from '../utils/pg.ts'

export const app = new Hono<MiddlewareKeyVariables>()

app.get('/', async (c) => {
  cloudlog({ requestId: c.get('requestId'), message: 'Latency check' })
  const pgClient = await getPgClient(c, true)
  try {
    const res = await selectOne(pgClient)
    if (!res)
      throw simpleError('cannot_get_apps', 'Cannot get apps')
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pgClient)
  }
})
