// POST /plugin_state/prewarm {app_ids}: warm this region's plugin state cache
// (utils/pluginStatePrewarm.ts). Called by the API worker with the shared API
// secret after a publication purge, and by `POST /app/:id/prewarm`.

import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PluginStatePrewarmResult } from '../utils/pluginStatePrewarm.ts'
import { Hono } from 'hono/tiny'
import { timingSafeEqual } from 'hono/utils/buffer'
import { BRES, quickError } from '../utils/hono.ts'
import { executionColo, mapWithConcurrency, prewarmOperations, prewarmPluginStateApp } from '../utils/pluginStatePrewarm.ts'
import { PREWARM_CALL_BUDGET_MS, PREWARM_CLEANUP_RESERVE_MS, PREWARM_MAX_APPS } from '../utils/pluginStatePrewarmLimits.ts'
import { getEnv, isValidAppId } from '../utils/utils.ts'

const PREWARM_CONCURRENCY = 4

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  const secret = getEnv(c, 'API_SECRET')
  const provided = c.req.header('apisecret')
  if (!secret || !provided || !await timingSafeEqual(provided, secret))
    throw quickError(401, 'invalid_api_secret', 'Invalid API secret')
  // A null or malformed body falls through to the validation below (400).
  const body: unknown = await c.req.raw.clone().json().catch(() => null)
  const raw = body && typeof body === 'object' ? (body as { app_ids?: unknown }).app_ids : undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PREWARM_MAX_APPS || !raw.every(id => typeof id === 'string' && isValidAppId(id)))
    throw quickError(400, 'invalid_app_ids', `app_ids must list 1 to ${PREWARM_MAX_APPS} valid app ids`)
  const appIds = [...new Set(raw as string[])]
  const budgetEndsAt = Date.now() + PREWARM_CALL_BUDGET_MS
  // Where this call runs, which is the cache it warms (read alongside the prewarm).
  const ranIn = executionColo()
  // One operation budget for the whole call: every app and retry draws from it.
  const ops = prewarmOperations()
  const results = await mapWithConcurrency(appIds, PREWARM_CONCURRENCY, async (appId): Promise<PluginStatePrewarmResult> => {
    // The last PREWARM_CLEANUP_RESERVE_MS only finish cleanups: no app starts then.
    if (Date.now() >= budgetEndsAt - PREWARM_CLEANUP_RESERVE_MS)
      return { app_id: appId, revision: null, cached: 0, skipped: 'budget' }
    return prewarmPluginStateApp(c, appId, budgetEndsAt, ops)
  })
  // colo: where the call entered Cloudflare. ran_in: where it ran. The caller
  // compares them when Cloudflare sends no cf-placement on the response.
  return c.json({ ...BRES, colo: c.req.raw.cf?.colo ?? null, ran_in: await ranIn, results })
})
