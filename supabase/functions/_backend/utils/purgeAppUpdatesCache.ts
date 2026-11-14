import type { Context } from 'hono'
import { hasPurgeTarget, nudgeUpdatesCachePurgeDrain } from '../triggers/updates_cache_purge.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { closeClient, getPgClient } from './pg.ts'

export type PurgeAppUpdatesCacheResult = {
  nudged: boolean
  purgedApps: number
  /** True only when this app_id was in a successfully claimed and acked purge batch. */
  purged: boolean
}

/**
 * Enqueue this app's capgo-updates edge tags and nudge the shared drain.
 *
 * Depends on #4118 (`purgeUpdatesCache` trigger hooks). After that PR merges to
 * main, rebase and drop this file if the same export lives in `purgeUpdatesCache.ts`.
 */
export async function purgeAppUpdatesCache(c: Context, appId: string): Promise<PurgeAppUpdatesCacheResult> {
  const trimmed = appId?.trim()
  if (!trimmed)
    return { nudged: false, purgedApps: 0, purged: false }

  if (!hasPurgeTarget(c))
    return { nudged: false, purgedApps: 0, purged: false }

  let pg: Awaited<ReturnType<typeof getPgClient>> | null = null
  try {
    pg = await getPgClient(c)
    await pg.query(
      'SELECT public.notify_updates_edge_cache_purge($1::text[], $2::text)',
      [[trimmed], 'app'],
    )
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeAppUpdatesCache enqueue failed', appId: trimmed, error: serializeError(error) })
    return { nudged: false, purgedApps: 0, purged: false }
  }
  finally {
    if (pg)
      closeClient(c, pg)
  }

  try {
    const { purgedApps, purgedAppIds } = await nudgeUpdatesCachePurgeDrain(c)
    return {
      nudged: true,
      purgedApps,
      purged: purgedAppIds.includes(trimmed),
    }
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeAppUpdatesCache drain failed', appId: trimmed, error: serializeError(error) })
    return { nudged: true, purgedApps: 0, purged: false }
  }
}