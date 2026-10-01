/** Dependency-free so the purge trigger can build tags without the plugin runtime. */
export const UPDATES_EDGE_CACHE_TAG_PREFIX = 'capgo-updates-'

/**
 * Cloudflare tags are case-insensitive, comma separated and cannot contain
 * spaces. Anything outside the app id alphabet collapses to `_` (a collision
 * only over-purges).
 */
export function updatesAppCacheTag(appId: string) {
  return `${UPDATES_EDGE_CACHE_TAG_PREFIX}${appId.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`
}
