import type { Context } from 'hono'
import { updatesAppCacheTag } from '../plugin_runtime/utils/updatesCacheTag.ts'
import { purgeUpdatesCacheTags } from '../triggers/updates_cache_purge.ts'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'

const purgedAppIdsByRequest = new Map<string, Set<string>>()

/** Test hook. */
export function resetPurgeUpdatesCacheDedupe() {
  purgedThisRequestClear()
}

function purgedThisRequestClear() {
  purgedAppIdsByRequest.clear()
}

function shouldPurgeAppForRequest(c: Context, appId: string) {
  const requestId = c.get('requestId') as string | undefined
  const key = requestId ?? '__anonymous__'
  let seen = purgedAppIdsByRequest.get(key)
  if (!seen) {
    seen = new Set()
    purgedAppIdsByRequest.set(key, seen)
  }
  if (seen.has(appId))
    return false
  seen.add(appId)
  return true
}

/**
 * Best-effort purge of the plugin /updates edge cache tag for one app
 * (capgo-updates-<app_id>). Uses CF_CACHE_PURGE_TOKEN, CF_ANALYTICS_TOKEN,
 * or UPDATES_CACHE_LOCAL_PURGE_URL via purgeUpdatesCacheTags. Never throws.
 */
export async function purgeUpdatesCache(c: Context, appId: string) {
  if (!appId?.trim() || !shouldPurgeAppForRequest(c, appId))
    return
  const tag = updatesAppCacheTag(appId)
  try {
    const result = await purgeUpdatesCacheTags(c, [tag])
    if (!result.configured) {
      cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache skipped (not configured)', appId, tag })
      return
    }
    if (result.failed > 0) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'purgeUpdatesCache failed',
        appId,
        tag,
        calls: result.calls,
        failed: result.failed,
        retryAfterSeconds: result.retryAfterSeconds,
      })
      return
    }
    cloudlog({ requestId: c.get('requestId'), message: 'purgeUpdatesCache ok', appId, tag, calls: result.calls })
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'purgeUpdatesCache error', appId, tag, error: serializeError(error) })
  }
}