import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { updatesAppCacheTag, updatesVersionsCacheTag } from './updatesCacheTag.ts'
import { backgroundTask, getEnv } from './utils.ts'

export { updatesAppCacheTag, updatesVersionsCacheTag } from './updatesCacheTag.ts'

/**
 * Edge cache for the app-level reads of the plugin endpoints (/updates,
 * /stats, /channel_self): app owner + plan, channel rows and channel-by-name
 * lookups, bundle-name lookups, manifest rows.
 *
 * Entries live in the Cloudflare Cache API (free, per data center) and carry
 * a per-app `Cache-Tag` (bundle-name lookups use a second per-app tag, see
 * updatesCacheTag.ts). Any database write that changes a cached read fires a
 * statement-level trigger -> pg_net -> triggers/updates_cache_purge, which
 * purges the tag in every data center through the zone purge API, then
 * purges again once read replicas caught up. The TTL is only the backstop for
 * a lost purge.
 *
 * One switch for every endpoint: `UPDATES_EDGE_CACHE` (off | on | N%), and
 * one per-device decision (shouldUseUpdatesEdgeCache), so a device sampled in
 * for /updates is also sampled in for /stats and /channel_self.
 *
 * Per-device data (channel_devices overrides, legacy channel_self store,
 * rollout decisions) is never cached here.
 */

const OWNER_CACHE_PATH = '/.updates-edge-owner-v1'
const CHANNEL_CACHE_PATH = '/.updates-edge-channel-v1'
const CHANNEL_LOOKUP_CACHE_PATH = '/.updates-edge-channel-lookup-v1'
const VERSION_CACHE_PATH = '/.updates-edge-version-v1'
/** Purges are proven in production, so the TTL only covers a lost purge. */
export const UPDATES_EDGE_CACHE_DEFAULT_TTL_SECONDS = 3600
const UPDATES_EDGE_CACHE_MIN_TTL_SECONDS = 10
const UPDATES_EDGE_CACHE_MAX_TTL_SECONDS = 86400
/** Unknown apps are cached shorter: an apps INSERT purges them anyway. */
const UPDATES_EDGE_CACHE_NEGATIVE_TTL_SECONDS = 60
/** Puts run under waitUntil; bound them so they cannot pin the isolate. */
const UPDATES_EDGE_CACHE_PUT_TIMEOUT_MS = 200

export type UpdatesChannelCacheMode = 'standard' | 'rollout'

interface CachedValue<T> {
  v: T | null
}

/**
 * Share of plugin requests (/updates, /stats, /channel_self) served through
 * the edge cache, in basis points
 * (0-10000). `UPDATES_EDGE_CACHE` accepts `off`, `on`, or a percentage such
 * as `1%`, `0.5` or `25` for a progressive rollout.
 *
 * Safety interlock: without any Cloudflare token in this worker's env the
 * purge path cannot work, so the cache stays off (entries would otherwise only
 * expire with the TTL). It cannot tell whether the token has the Cache Purge
 * permission: check `updates cache purged` logs before raising the share.
 */
export function hasUpdatesPurgeTarget(c: Context) {
  // Zone ids alone cannot purge (no credentials), so they do not count.
  return ['CF_CACHE_PURGE_TOKEN', 'CF_ANALYTICS_TOKEN', 'UPDATES_CACHE_LOCAL_PURGE_URL'].some(key => getEnv(c, key).trim() !== '')
}

export function getUpdatesEdgeCacheBps(c: Context) {
  if (!hasUpdatesPurgeTarget(c))
    return 0
  const raw = getEnv(c, 'UPDATES_EDGE_CACHE').replace(/\s+/g, '').toLowerCase()
  if (raw === 'on')
    return 10_000
  // Whole value only: a malformed setting (e.g. "1abc") stays off.
  if (!/^\d+(?:\.\d+)?%?$/.test(raw))
    return 0
  const percent = Number(raw.replace(/%$/, ''))
  if (!Number.isFinite(percent) || percent <= 0)
    return 0
  return Math.min(Math.round(percent * 100), 10_000)
}

/**
 * True as soon as any share of traffic uses the edge cache. Tagging (and so
 * purging) then applies to every plugin cache entry, whichever path wrote it.
 */
export function isUpdatesEdgeCacheEnabled(c: Context) {
  return getUpdatesEdgeCacheBps(c) > 0
}

/** Stable bucket 0-9999 (FNV-1a) so a device always takes the same path. */
export function updatesEdgeCacheBucket(appId: string, deviceId: string) {
  let hash = 0x811C9DC5
  const input = `${appId}:${deviceId}`
  for (const char of input) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % 10_000
}

const sampledRequests = new WeakMap<object, boolean>()

/**
 * The single edge cache gate of every plugin endpoint (/updates, /stats,
 * /channel_self). Decides once per request whether this device uses the edge
 * cache, and remembers it for the rest of the request. The bucket depends on
 * app id + device id only, so a device gets the same answer on every endpoint.
 */
export function shouldUseUpdatesEdgeCache(c: Context, appId: string, deviceId: string) {
  const known = sampledRequests.get(c.req.raw)
  if (known !== undefined)
    return known
  const bps = getUpdatesEdgeCacheBps(c)
  const sampled = bps >= 10_000 || (bps > 0 && updatesEdgeCacheBucket(appId, deviceId) < bps)
  sampledRequests.set(c.req.raw, sampled)
  return sampled
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
  tags: string[],
  path: string,
  params: Record<string, string>,
  load: () => Promise<T | null | undefined>,
  ttlCapSeconds?: (value: T | null) => number | undefined,
): Promise<EdgeCacheLookup<T>> {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(path, params)
  const cached = await helper.matchJson<CachedValue<T>>(request)
  if (cached && 'v' in cached)
    return { value: cached.v, hit: true }

  // Loader errors propagate: a failed read must never be cached as "missing".
  const value = (await load()) ?? null
  let ttl = getUpdatesEdgeCacheTtlSeconds(c)
  if (value === null)
    ttl = Math.min(ttl, UPDATES_EDGE_CACHE_NEGATIVE_TTL_SECONDS)
  const cap = ttlCapSeconds?.(value)
  if (cap !== undefined)
    ttl = Math.max(1, Math.min(ttl, cap))
  await backgroundTask(c, helper.putJson(request, { v: value } satisfies CachedValue<T>, ttl, {
    tags,
    timeoutMs: UPDATES_EDGE_CACHE_PUT_TIMEOUT_MS,
  }))
  return { value, hit: false }
}

/**
 * Seconds until a trial-based `plan_valid` flips on its own: the plan check is
 * `trial_at::date > CURRENT_DATE` (UTC), so it ends at 00:00 UTC of the trial
 * date. No write happens then, so the owner entry must not outlive it.
 */
export function planValidityTtlCapSeconds(owner: { plan_valid?: boolean, plan_trial_at?: string | null } | null, nowMs = Date.now()) {
  if (!owner?.plan_valid || !owner.plan_trial_at)
    return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(owner.plan_trial_at)
  if (!match)
    return undefined
  const trialEnd = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (trialEnd <= nowMs)
    return undefined
  return Math.ceil((trialEnd - nowMs) / 1000)
}

export function getCachedAppOwner<T extends { plan_valid?: boolean, plan_trial_at?: string | null }>(c: Context, appId: string, planKey: string, load: () => Promise<T | null>) {
  return cachedLookup(c, [updatesAppCacheTag(appId)], OWNER_CACHE_PATH, { app_id: appId, plan: planKey }, load, planValidityTtlCapSeconds)
}

export interface UpdatesChannelCacheKey {
  appId: string
  platform: string
  defaultChannel: string
  mode: UpdatesChannelCacheMode
  includeMetadata: boolean
}

export function getCachedDefaultChannel<T>(c: Context, key: UpdatesChannelCacheKey, load: () => Promise<T | null | undefined>) {
  return cachedLookup(c, [updatesAppCacheTag(key.appId)], CHANNEL_CACHE_PATH, {
    app_id: key.appId,
    platform: key.platform,
    channel: key.defaultChannel,
    mode: key.mode,
    meta: key.includeMetadata ? '1' : '0',
  }, load)
}

/**
 * App-level channel lookups of /stats and /channel_self (channel by id or
 * name, public default channel, compatible channel list). `lookup` names the
 * query shape and `params` its inputs; the channels trigger purges the app tag
 * on any change of the compared channel columns.
 */
export function getCachedChannelLookup<T>(c: Context, appId: string, lookup: string, params: Record<string, string>, load: () => Promise<T | null | undefined>) {
  return cachedLookup(c, [updatesAppCacheTag(appId)], CHANNEL_LOOKUP_CACHE_PATH, { ...params, app_id: appId, lookup }, load)
}

/**
 * Bundle by name (id + owner_org, deleted rows included). Carries the app's
 * versions tag: app_versions INSERT / DELETE / rename / move purge it whether
 * or not a channel serves the bundle, without evicting the app's main tag.
 * It also carries the main tag, so any app purge (including one from a purge
 * worker that predates the versions scope) evicts it too: an over-purge of a
 * cheap entry, never a missed one.
 */
export function getCachedAppVersion<T>(c: Context, appId: string, versionName: string, load: () => Promise<T | null | undefined>) {
  return cachedLookup(c, [updatesVersionsCacheTag(appId), updatesAppCacheTag(appId)], VERSION_CACHE_PATH, { app_id: appId, name: versionName }, load)
}
