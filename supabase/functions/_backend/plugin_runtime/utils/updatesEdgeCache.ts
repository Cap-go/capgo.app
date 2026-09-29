import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { updatesAppCacheTag } from './updatesCacheTag.ts'
import { backgroundTask, getEnv } from './utils.ts'

export { updatesAppCacheTag } from './updatesCacheTag.ts'

/**
 * Edge cache for the app-level part of /updates (app owner + plan, default
 * channel row, manifest rows).
 *
 * Entries live in the Cloudflare Cache API (free, per data center) and carry
 * a per-app `Cache-Tag`. Any database write that changes what /updates would
 * answer fires a statement-level trigger -> pg_net -> triggers/updates_cache_purge,
 * which purges the tag in every data center through the zone purge API, then
 * purges again once read replicas caught up. The TTL is only the backstop for
 * a lost purge.
 *
 * Per-device data (channel_devices overrides, legacy channel_self store,
 * rollout decisions) is never cached here.
 */

const OWNER_CACHE_PATH = '/.updates-edge-owner-v1'
const CHANNEL_CACHE_PATH = '/.updates-edge-channel-v1'
export const UPDATES_EDGE_CACHE_DEFAULT_TTL_SECONDS = 300
const UPDATES_EDGE_CACHE_MIN_TTL_SECONDS = 10
const UPDATES_EDGE_CACHE_MAX_TTL_SECONDS = 3600
/** Unknown apps are cached shorter: an apps INSERT purges them anyway. */
const UPDATES_EDGE_CACHE_NEGATIVE_TTL_SECONDS = 60
/** Puts run under waitUntil; bound them so they cannot pin the isolate. */
const UPDATES_EDGE_CACHE_PUT_TIMEOUT_MS = 200

export type UpdatesChannelCacheMode = 'standard' | 'rollout'

interface CachedValue<T> {
  v: T | null
}

export function isUpdatesEdgeCacheEnabled(c: Context) {
  return getEnv(c, 'UPDATES_EDGE_CACHE') === 'on'
}

export function getUpdatesEdgeCacheTtlSeconds(c: Context) {
  const raw = Number.parseInt(getEnv(c, 'UPDATES_EDGE_CACHE_TTL_SECONDS'), 10)
  if (!Number.isFinite(raw))
    return UPDATES_EDGE_CACHE_DEFAULT_TTL_SECONDS
  return Math.min(Math.max(raw, UPDATES_EDGE_CACHE_MIN_TTL_SECONDS), UPDATES_EDGE_CACHE_MAX_TTL_SECONDS)
}

/** Tags to attach to any /updates Cache API entry of this app, or none when the edge cache is off. */
export function updatesCacheTags(c: Context, appId: string) {
  return isUpdatesEdgeCacheEnabled(c) ? [updatesAppCacheTag(appId)] : undefined
}

export interface EdgeCacheLookup<T> {
  value: T | null
  hit: boolean
}

async function cachedLookup<T>(
  c: Context,
  appId: string,
  path: string,
  params: Record<string, string>,
  load: () => Promise<T | null | undefined>,
): Promise<EdgeCacheLookup<T>> {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(path, params)
  const cached = await helper.matchJson<CachedValue<T>>(request)
  if (cached && 'v' in cached)
    return { value: cached.v, hit: true }

  // Loader errors propagate: a failed read must never be cached as "missing".
  const value = (await load()) ?? null
  const ttl = getUpdatesEdgeCacheTtlSeconds(c)
  await backgroundTask(c, helper.putJson(request, { v: value } satisfies CachedValue<T>, value === null ? Math.min(ttl, UPDATES_EDGE_CACHE_NEGATIVE_TTL_SECONDS) : ttl, {
    tags: [updatesAppCacheTag(appId)],
    timeoutMs: UPDATES_EDGE_CACHE_PUT_TIMEOUT_MS,
  }))
  return { value, hit: false }
}

export function getCachedAppOwner<T>(c: Context, appId: string, planKey: string, load: () => Promise<T | null>) {
  return cachedLookup(c, appId, OWNER_CACHE_PATH, { app_id: appId, plan: planKey }, load)
}

export interface UpdatesChannelCacheKey {
  appId: string
  platform: string
  defaultChannel: string
  mode: UpdatesChannelCacheMode
  includeMetadata: boolean
}

export function getCachedDefaultChannel<T>(c: Context, key: UpdatesChannelCacheKey, load: () => Promise<T | null | undefined>) {
  return cachedLookup(c, key.appId, CHANNEL_CACHE_PATH, {
    app_id: key.appId,
    platform: key.platform,
    channel: key.defaultChannel,
    mode: key.mode,
    meta: key.includeMetadata ? '1' : '0',
  }, load)
}
