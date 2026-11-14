import type { Context } from 'hono'
import { enqueueUpdatesEdgeCachePurge, hasPurgeTarget, nudgeUpdatesCachePurgeDrain } from '../triggers/updates_cache_purge.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

const DEDUPE_KEY = Symbol('purgeUpdatesCache.dedupe')

export type PurgeUpdatesCacheOptions = {
  /**
   * When true (default), allow at most one nudge per app_id on this Hono context.
   * Manual callers should pass false so repeated button clicks always run.
   */
  dedupe?: boolean
}

export type PurgeUpdatesCacheResult = {
  /** A drain attempt ran in this runtime (may have claimed zero apps). */
  nudged: boolean
  /** Apps successfully purged in this drain call (any app_id). */
  purgedApps: number
  /** True only when this app_id was in a successfully purged claim batch in this call. */
  purged: boolean
  /** This app_id was inserted into updates_cache_purge_pending before the nudge. */
  enqueued: boolean
  reason?: 'invalid_app_id' | 'deduped' | 'not_configured' | 'enqueue_failed' | 'drain_failed' | 'queued'
}

export function resetPurgeUpdatesCacheDedupe(c?: Context) {
  if (c)
    delete (c as Context & { [DEDUPE_KEY]?: Set<string> })[DEDUPE_KEY]
}

function shouldPurgeAppForContext(c: Context, appId: string) {
  const ctx = c as Context & { [DEDUPE_KEY]?: Set<string> }
  let seen = ctx[DEDUPE_KEY]
  if (!seen) {
    seen = new Set()
    ctx[DEDUPE_KEY] = seen
  }
  if (seen.has(appId))
    return false
  seen.add(appId)
  return true
}

/**
 * Shared entry point to refresh the plugin /updates edge cache for one app
 * (Cloudflare Cache-Tag capgo-updates-<app_id>). Used from change triggers and
 * from manual console actions. Enqueues the app tag on updates_cache_purge_pending,
 * then nudges the throttled shared drain (claim, purgeUpdatesCacheTags, ack).
 * Never throws.
 */
export async function purgeUpdatesCache(
  c: Context,
  appId: string,
  options: PurgeUpdatesCacheOptions = {},
): Promise<PurgeUpdatesCacheResult> {
  const trimmed = appId?.trim()
  if (!trimmed) {
    return { nudged: false, purgedApps: 0, purged: false, enqueued: false, reason: 'invalid_app_id' }
  }

  if (options.dedupe !== false && !shouldPurgeAppForContext(c, trimmed)) {
    return { nudged: false, purgedApps: 0, purged: false, enqueued: false, reason: 'deduped' }
  }

  const enqueued = await enqueueUpdatesEdgeCachePurge(c, trimmed, 'app')
  if (!enqueued) {
    return { nudged: false, purgedApps: 0, purged: false, enqueued: false, reason: 'enqueue_failed' }
  }

  if (!hasPurgeTarget(c)) {
    cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache skipped drain (not configured)', appId: trimmed })
    return { nudged: false, purgedApps: 0, purged: false, enqueued: true, reason: 'not_configured' }
  }

  try {
    const { purgedApps, purgedAppIds } = await nudgeUpdatesCachePurgeDrain(c)
    const purged = purgedAppIds.includes(trimmed)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'purgeUpdatesCache drain nudged',
      appId: trimmed,
      purgedApps,
      purged,
      purgedAppIds,
    })
    if (purged)
      return { nudged: true, purgedApps, purged, enqueued: true }
    return { nudged: true, purgedApps, purged: false, enqueued: true, reason: 'queued' }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeUpdatesCache error', appId: trimmed, error: serializeError(error) })
    return { nudged: false, purgedApps: 0, purged: false, enqueued: true, reason: 'drain_failed' }
  }
}