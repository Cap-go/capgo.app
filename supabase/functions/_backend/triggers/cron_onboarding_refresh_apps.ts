import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { onboardingRefreshBody, refreshAppOnboardingBatch } from '../utils/app_onboarding_refresh.ts'
import { refreshAppOnboardingTodoBatch } from '../utils/app_onboarding_todo_refresh.ts'
import { BRES, middlewareAPISecret, parseBody, quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient } from '../utils/pg.ts'

export const app = new Hono<MiddlewareKeyVariables>()
app.post('/', middlewareAPISecret, async (c) => {
  const parsed = onboardingRefreshBody.safeParse(await parseBody(c))
  if (!parsed.success || new Set(parsed.data.appIds).size !== parsed.data.appIds.length)
    throw quickError(400, 'invalid_body', 'Invalid onboarding refresh batch')
  const pool = await getPgClient(c)
  try {
    const database = getDrizzleClient(pool)
    const refreshed = await refreshAppOnboardingBatch(database, parsed.data)
    // Todo evidence is independent of the feature refresh checkpoint, including
    // replayed messages whose feature rows were already refreshed.
    const todo = await refreshAppOnboardingTodoBatch(c, database, parsed.data)
    cloudlog({ requestId: c.get('requestId'), message: 'onboarding refresh batch finished', requested: parsed.data.appIds.length, refreshed, todo })
    return c.json(BRES)
  }
  finally {
    await closeClient(c, pool)
  }
})
