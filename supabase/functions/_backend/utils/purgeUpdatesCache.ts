import type { Context } from 'hono'
import { hasPurgeTarget, nudgeUpdatesCachePurgeDrain } from '../triggers/updates_cache_purge.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

const purgedAppIdsByContext = new WeakMap<Context, Set<string>>()

export type PurgeUpdatesCacheOptions = {
  /**
   * When true (default), allow at most one nudge per app_id on this Hono context.
   * Manual callers should pass false so repeated button clicks always run.
   */
  dedupe?: boolean
}

export type PurgeUpdatesCacheResult = {
  purged: boolean
  reason?: 'invalid_app_id' | 'deduped' | 'not_configured' | 'nothing_claimed' | 'drain_failed'
}

/** Test hook (WeakMap drops entries with the context). */
export function resetPurgeUpdatesCacheDedupe() {
}

function shouldPurgeAppForContext(c: Context, appId: string) {
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
 * Shared entry point to refresh the plugin /updates edge cache for one app
 * (Cloudflare Cache-Tag capgo-updates-<app_id>). Used from change triggers and
 * from manual console actions. Enqueues are handled by invalidate_updates_edge_cache;
 * this nudges the throttled shared drain (claim, purgeUpdatesCacheTags, ack).
 * Never throws.
 */
export async function purgeUpdatesCache(
  c: Context,
  appId: string,
  options: PurgeUpdatesCacheOptions = {},
): Promise<PurgeUpdatesCacheResult> {
  const trimmed = appId?.trim()
  if (!trimmed)
    return { purged: false, reason: 'invalid_app_id' }

  if (options.dedupe !== false && !shouldPurgeAppForContext(c, trimmed))
    return { purged: false, reason: 'deduped' }

  if (!hasPurgeTarget(c)) {
    cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache skipped (not configured)', appId: trimmed })
    return { purged: false, reason: 'not_configured' }
  }

  try {
    const { purgedApps } = await nudgeUpdatesCachePurgeDrain(c)
    cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache drain nudged', appId: trimmed, purgedApps })
    if (purgedApps > 0)
      return { purged: true }
    return { purged: false, reason: 'nothing_claimed' }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeUpdatesCache error', appId: trimmed, error: serializeError(error) })
    return { purged: false, reason: 'drain_failed' }
  }
}