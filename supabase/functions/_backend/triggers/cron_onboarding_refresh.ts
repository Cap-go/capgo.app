import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono/tiny'
import { onboardingRefreshBody, refreshAppOnboardingBatch } from '../utils/app_onboarding_refresh.ts'
import { BRES, middlewareAPISecret, parseBody, quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'

export const producer = new Hono<MiddlewareKeyVariables>()
producer.post('/', middlewareAPISecret, async (c) => {
  const pool = getPgClient(c)
  try {
    const enqueued = await getDrizzleClient(pool).transaction(async (tx) => {
      await tx.execute(sql`SELECT
        pg_catalog.set_config('statement_timeout', '20s', true),
        pg_catalog.set_config('lock_timeout', '2s', true)
      `)
      const { rows } = await tx.execute<{ enqueued: number }>(sql`SELECT public.enqueue_app_onboarding_refreshes() AS enqueued`)
      return rows[0]?.enqueued ?? 0
    })
    cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh producer finished', enqueued })
    return c.json(BRES)
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
    const refreshed = await refreshAppOnboardingBatch(c, getDrizzleClient(pool), parsed.data)
    cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh batch finished', requested: parsed.data.appIds.length, refreshed })
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pool)
  }
})
