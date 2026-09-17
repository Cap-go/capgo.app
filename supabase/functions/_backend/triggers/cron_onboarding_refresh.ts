import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { onboardingRefreshBody, refreshAppOnboardingBatch } from '../utils/app_onboarding_refresh.ts'
import { BRES, middlewareAPISecret, parseBody, quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getPgClient } from '../utils/pg.ts'

export const producer = new Hono<MiddlewareKeyVariables>()
producer.post('/', middlewareAPISecret, async (c) => {
  const pool = getPgClient(c)
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL statement_timeout = \'20s\'')
      await client.query('SET LOCAL lock_timeout = \'2s\'')
      const { rows } = await client.query<{ enqueued: number }>('SELECT public.enqueue_app_onboarding_refreshes() AS enqueued')
      await client.query('COMMIT')
      cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh producer finished', enqueued: rows[0]?.enqueued ?? 0 })
      return c.json(BRES)
    }
    catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    finally {
      client.release()
    }
  }
  finally {
    await closeClient(c, pool)
  }
})

export const consumer = new Hono<MiddlewareKeyVariables>()
consumer.post('/', middlewareAPISecret, async (c) => {
  const parsed = onboardingRefreshBody.safeParse(await parseBody(c))
  if (!parsed.success || new Set(parsed.data.appIds).size !== parsed.data.appIds.length)
    throw quickError(400, 'invalid_body', 'Invalid onboarding refresh batch')
  const pool = getPgClient(c)
  try {
    const refreshed = await refreshAppOnboardingBatch(c, pool, parsed.data)
    cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh batch finished', requested: parsed.data.appIds.length, refreshed })
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pool)
  }
})
