import type { Context } from 'hono'
import { enqueueUpdatesEdgeCachePurge, hasPurgeTarget, nudgeUpdatesCachePurgeDrain } from '../triggers/updates_cache_purge.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

const DEDUPE_KEY = Symbol('purgeUpdatesCache.dedupe')

/** Stable console and API contract (bc-e3173a70). */
export type PurgeAppUpdatesCacheResult = {
  nudged: boolean
  purgedApps: string[]
  purged: boolean
}

export type PurgeUpdatesCacheOptions = {
  /**
   * When true (default), allow at most one nudge per app_id on this Hono context.
   * Manual callers should pass false so repeated button clicks always run.
   */
  dedupe?: boolean
}

export type PurgeUpdatesCacheResult = PurgeAppUpdatesCacheResult & {
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
 * Shared entry point for one app's capgo-updates-<app_id> edge cache purge.
 * Enqueues on updates_cache_purge_pending, then nudges the throttled drain.
 * Never throws.
 */
export async function purgeAppUpdatesCache(c: Context, appId: string): Promise<PurgeAppUpdatesCacheResult> {
  const trimmed = appId?.trim()
  if (!trimmed)
    return { nudged: false, purgedApps: [], purged: false }

  const enqueued = await enqueueUpdatesEdgeCachePurge(c, trimmed, 'app')
  if (!enqueued)
    return { nudged: false, purgedApps: [], purged: false }

  if (!hasPurgeTarget(c)) {
    cloudlog({ requestId: c.get('requestId'), message: 'purgeAppUpdatesCache skipped drain (not configured)', appId: trimmed })
    return { nudged: false, purgedApps: [], purged: false }
  }

  try {
    const { purgedAppIds } = await nudgeUpdatesCachePurgeDrain(c)
    const purged = purgedAppIds.includes(trimmed)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'purgeAppUpdatesCache drain nudged',
      appId: trimmed,
      purged,
      purgedAppIds,
    })
    return { nudged: true, purgedApps: purgedAppIds, purged }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeAppUpdatesCache error', appId: trimmed, error: serializeError(error) })
    return { nudged: false, purgedApps: [], purged: false }
  }
}

/** Trigger helper: per-request dedupe on top of purgeAppUpdatesCache. */
export async function purgeUpdatesCache(
  c: Context,
  appId: string,
  options: PurgeUpdatesCacheOptions = {},
): Promise<PurgeUpdatesCacheResult> {
  const trimmed = appId?.trim()
  if (!trimmed)
    return { nudged: false, purgedApps: [], purged: false, enqueued: false, reason: 'invalid_app_id' }

  if (options.dedupe !== false && !shouldPurgeAppForContext(c, trimmed))
    return { nudged: false, purgedApps: [], purged: false, enqueued: false, reason: 'deduped' }

  const core = await purgeAppUpdatesCache(c, trimmed)
  if (!core.nudged && !core.purged && core.purgedApps.length === 0 && !hasPurgeTarget(c))
    return { ...core, enqueued: true, reason: 'not_configured' }
  if (!core.nudged && !core.purged && core.purgedApps.length === 0)
    return { ...core, enqueued: false, reason: 'enqueue_failed' }
  if (core.nudged && !core.purged)
    return { ...core, enqueued: true, reason: 'queued' }
  return { ...core, enqueued: true }
}