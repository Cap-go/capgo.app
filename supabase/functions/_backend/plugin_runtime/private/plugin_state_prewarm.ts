// POST /plugin_state/prewarm {app_ids}: warm this region's plugin state cache
// (utils/pluginStatePrewarm.ts). Called by the API worker with the shared API
// secret after a publication purge, and by `POST /app/:id/prewarm`.

import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { PluginStatePrewarmResult } from '../utils/pluginStatePrewarm.ts'
import { Hono } from 'hono/tiny'
import { timingSafeEqual } from 'hono/utils/buffer'
import { BRES, parseBody, quickError } from '../utils/hono.ts'
import { prewarmPluginStateApp } from '../utils/pluginStatePrewarm.ts'
import { getEnv, isValidAppId } from '../utils/utils.ts'

/** Matches the purge batch size, so one purge batch is one call per region. */
export const PREWARM_MAX_APPS = 100
const PREWARM_CONCURRENCY = 4

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  const secret = getEnv(c, 'API_SECRET')
  const provided = c.req.header('apisecret')
  if (!secret || !provided || !await timingSafeEqual(provided, secret))
    throw quickError(401, 'invalid_api_secret', 'Invalid API secret')
  const body = await parseBody<{ app_ids?: unknown } | null>(c)
  const raw = body && typeof body === 'object' ? body.app_ids : undefined
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PREWARM_MAX_APPS || !raw.every(id => typeof id === 'string' && isValidAppId(id)))
    throw quickError(400, 'invalid_app_ids', `app_ids must list 1 to ${PREWARM_MAX_APPS} valid app ids`)
  const appIds = [...new Set(raw as string[])]
  const results: PluginStatePrewarmResult[] = []
  for (let i = 0; i < appIds.length; i += PREWARM_CONCURRENCY)
    results.push(...await Promise.all(appIds.slice(i, i + PREWARM_CONCURRENCY).map(appId => prewarmPluginStateApp(c, appId))))
  // cf-placement names the data center a placed worker ran in (its cache).
  return c.json({ ...BRES, placement: c.req.header('cf-placement') ?? null, colo: c.req.raw.cf?.colo ?? null, results })
})
