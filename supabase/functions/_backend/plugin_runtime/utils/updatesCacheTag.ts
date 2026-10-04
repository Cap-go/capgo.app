/** Dependency-free so the purge trigger can build tags without the plugin runtime. */
export const UPDATES_EDGE_CACHE_TAG_PREFIX = 'capgo-updates-'
/**
 * ':' is outside the sanitized app id alphabet, so no app's main tag can
 * equal another app's versions tag (a '-versions' suffix could: an app id may
 * end with it).
 */
const VERSIONS_TAG_SUFFIX = ':versions'

/**
 * Purge scope of a queued purge (`updates_cache_purge_pending.scope`):
 * - `app`: the app's main tag (/updates answers, owner, channel lookups)
 * - `versions`: bundle-name lookups, purged on any app_versions identity
 *   change so uploads never evict the main tag
 */
export type UpdatesCachePurgeScope = 'app' | 'versions'

function sanitizeAppId(appId: string) {
  return appId.toLowerCase().replace(/[^a-z0-9._-]/g, '_')
}

/**
 * Cloudflare tags are case-insensitive, comma separated and cannot contain
 * spaces. Anything outside the app id alphabet collapses to `_` (a collision
 * only over-purges).
 */
export function updatesAppCacheTag(appId: string) {
  return `${UPDATES_EDGE_CACHE_TAG_PREFIX}${sanitizeAppId(appId)}`
}

/** Second tag per app for bundle-name lookups (see UpdatesCachePurgeScope). */
export function updatesVersionsCacheTag(appId: string) {
  return `${UPDATES_EDGE_CACHE_TAG_PREFIX}${sanitizeAppId(appId)}${VERSIONS_TAG_SUFFIX}`
}

/** Tag to purge for a queued (app, scope) pair; unknown or missing scopes purge the main tag. */
export function updatesCacheTagForScope(appId: string, scope: string | null | undefined) {
  return scope === 'versions' ? updatesVersionsCacheTag(appId) : updatesAppCacheTag(appId)
}
