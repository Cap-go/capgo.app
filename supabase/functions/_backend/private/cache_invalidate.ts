// Colo cache invalidation endpoint, mounted on every regional plugin worker.
//
// The plugin workers are placement-pinned, so a request to each regional
// domain lands in the colo whose cache serves that region's devices. The
// cache_invalidate trigger handler fans a token bump out to all regions;
// each bump makes every cached /updates payload of the app unreachable
// (see updates_colo_cache.ts). Auth is a dedicated shared secret so this
// stays independent from the API-secret used by Supabase triggers.

import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, parseBody, quickError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { bumpAppCacheToken, isUpdatesCacheEnabled } from '../utils/updates_colo_cache.ts'
import { existInEnv, getEnv } from '../utils/utils.ts'

export const MAX_INVALIDATE_APPS = 100

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  if (!existInEnv(c, 'CACHE_INVALIDATE_SECRET'))
    throw quickError(503, 'cache_invalidate_disabled', 'CACHE_INVALIDATE_SECRET is not configured')
  if (c.req.header('x-cache-invalidate-secret') !== getEnv(c, 'CACHE_INVALIDATE_SECRET'))
    throw quickError(401, 'unauthorized', 'Invalid cache invalidation secret')

  const body = await parseBody<{ app_ids?: unknown }>(c)
  const appIds = Array.isArray(body.app_ids)
    ? body.app_ids.filter((appId): appId is string => typeof appId === 'string' && appId.length > 0)
    : []
  if (appIds.length === 0)
    throw quickError(400, 'missing_app_ids', 'app_ids must be a non-empty array of strings')
  // Loud rejection instead of silent truncation: the fan-out chunks to this
  // size, so anything larger is a caller bug that would leave caches stale.
  if (appIds.length > MAX_INVALIDATE_APPS)
    throw quickError(400, 'too_many_app_ids', `app_ids is limited to ${MAX_INVALIDATE_APPS} per request`)

  // Bump even when the cache mode is off so entries from a prior "on"
  // window can never be served stale after a toggle.
  const results = await Promise.all(appIds.map(appId => bumpAppCacheToken(c, appId)))
  const bumped = results.filter(Boolean).length
  cloudlog({ requestId: c.get('requestId'), message: 'updates cache invalidated', appIds, bumped, enabled: isUpdatesCacheEnabled(c) })
  return c.json({ ...BRES, bumped })
})
