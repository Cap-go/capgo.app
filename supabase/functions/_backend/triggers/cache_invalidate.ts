// Fan-out of /updates colo-cache invalidations to every regional plugin
// worker.
//
// Called by the invalidate_updates_cache() database trigger (via pg_net)
// whenever a row that feeds the update hot path changes (channels,
// channel_devices, apps, app_versions, orgs, stripe_info). The plugin
// workers are placement-pinned, so one POST per regional domain reaches
// every colo that caches this app — end-to-end reaction is ~1s from the
// database commit, with the cache TTL as backstop when a call is lost.

import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Hono } from 'hono/tiny'
import { BRES, middlewareAPISecret, parseBody } from '../utils/hono.ts'
import { cloudlog, cloudlogErr, serializeError } from '../utils/logging.ts'
import { existInEnv, getEnv } from '../utils/utils.ts'

const FANOUT_TIMEOUT_MS = 5000

export function parsePluginInvalidateUrls(raw: string): string[] {
  return raw
    .split(',')
    .map(url => url.trim().replace(/\/$/, ''))
    .filter(Boolean)
}

export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', middlewareAPISecret, async (c) => {
  const body = await parseBody<{ app_ids?: unknown }>(c)
  const appIds = Array.isArray(body.app_ids)
    ? body.app_ids.filter((appId): appId is string => typeof appId === 'string' && appId.length > 0)
    : []
  if (appIds.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'cache invalidate fanout skipped (no app_ids)' })
    return c.json(BRES)
  }

  if (!existInEnv(c, 'PLUGIN_INVALIDATE_URLS') || !existInEnv(c, 'CACHE_INVALIDATE_SECRET')) {
    // Soft-skip: invalidation is an accelerator, the cache TTL is the backstop.
    cloudlog({ requestId: c.get('requestId'), message: 'cache invalidate fanout skipped (missing env)', appIds })
    return c.json(BRES)
  }

  const urls = parsePluginInvalidateUrls(getEnv(c, 'PLUGIN_INVALIDATE_URLS'))
  const secret = getEnv(c, 'CACHE_INVALIDATE_SECRET')
  const results = await Promise.all(urls.map(async (url) => {
    try {
      const response = await fetch(`${url}/cache_invalidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-cache-invalidate-secret': secret,
        },
        body: JSON.stringify({ app_ids: appIds }),
        signal: AbortSignal.timeout(FANOUT_TIMEOUT_MS),
      })
      if (!response.ok) {
        cloudlogErr({ requestId: c.get('requestId'), message: 'cache invalidate fanout failed', url, status: response.status })
        return false
      }
      return true
    }
    catch (e) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'cache invalidate fanout error', url, error: serializeError(e) })
      return false
    }
  }))
  const succeeded = results.filter(Boolean).length
  cloudlog({ requestId: c.get('requestId'), message: 'cache invalidate fanout done', appIds, regions: urls.length, succeeded })
  return c.json({ ...BRES, regions: urls.length, succeeded })
})
