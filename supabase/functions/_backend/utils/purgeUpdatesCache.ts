import type { Context } from 'hono'
import { nudgeUpdatesCachePurgeDrain } from '../triggers/updates_cache_purge.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

const purgedAppIdsByContext = new WeakMap<Context, Set<string>>()

/** Test hook. */
export function resetPurgeUpdatesCacheDedupe() {
  // WeakMap entries drop with their contexts; tests use fresh mock contexts.
}

function shouldPurgeAppForRequest(c: Context, appId: string) {
  let seen = purgedAppIdsByContext.get(c)
  if (!seen) {
    seen = new Set()
    purgedAppIdsByContext.set(c, seen)
  }
  if (seen.has(appId))
    return false
  seen.add(appId)
  return true
}

/**
 * Best-effort nudge of the shared updates cache purge drain for one app.
 * Statement triggers already enqueue purges; this runs the throttled drain path
 * (claim_updates_cache_purge -> purgeUpdatesCacheTags -> ack) so Cloudflare
 * rate limits stay bounded. Never throws.
 */
export async function purgeUpdatesCache(c: Context, appId: string) {
  if (!appId?.trim() || !shouldPurgeAppForRequest(c, appId))
    return
  try {
    const { purgedApps } = await nudgeUpdatesCachePurgeDrain(c)
    cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache drain nudged', appId, purgedApps })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeUpdatesCache error', appId, error: serializeError(error) })
  }
}