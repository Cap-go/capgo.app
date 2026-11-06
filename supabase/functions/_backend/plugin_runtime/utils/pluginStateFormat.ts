/**
 * Plugin state in Workers KV: everything the plugin endpoints (/updates,
 * /stats, /channel_self, /updates/manifest_size) read from Postgres, written
 * ahead of time by triggers/plugin_state_sync from the primary database.
 *
 * One document per app holds the app-level reads (owner + plan inputs, every
 * channel with its served and rollout bundle, small override sets); per-device
 * overrides, bundle-name lookups and manifests have their own keys. The rows
 * are the exact select shapes of the plugin queries (pluginStateSelects.ts)
 * after a JSON round trip, so answers built from them match the Postgres path.
 *
 * Dependency-free: shared by the sync trigger (API worker) and the plugin
 * runtime.
 */

export const PLUGIN_STATE_FORMAT = 1
const KEY_PREFIX = 'ps1'
/** Workers KV rejects keys longer than 512 bytes. */
const MAX_KEY_BYTES = 512
/**
 * Apps with at most this many device overrides carry them in the app
 * document (no per-device read). Larger sets use one key per device.
 */
export const PLUGIN_STATE_INLINE_OVERRIDES_LIMIT = 500

/** Plan inputs of buildPlanValidationExpression for the app owner. */
export interface PluginStatePlan {
  /** orgs.has_usage_credits (false when missing or null). */
  has_credits: boolean
  /** orgs.customer_id; null also when the owner org row is missing. */
  customer_id: string | null
  /** The stripe_info row of customer_id (customer_id is unique), if any. */
  stripe: PluginStateStripe | null
}

export interface PluginStateStripe {
  status: string | null
  /** stripe_info.trial_at as the driver returns it (plan_trial_at). */
  trial_at: string | null
  /** (trial_at::date)::text, in the database session time zone. */
  trial_date: string | null
  mau_exceeded: boolean | null
  storage_exceeded: boolean | null
  bandwidth_exceeded: boolean | null
}

/** One channel of the app with its bundles, as the plugin channel queries select them. */
export interface PluginStateChannelRow {
  /** channelSelect of pg.ts. */
  channels: Record<string, unknown> & { id: number, name: string }
  /** versionSelect (prefix v, with link/comment, 'builtin' when the channel has no bundle). */
  version: Record<string, unknown> & { id: string | number | null }
  /** rolloutVersionSelect (prefix rv, with link/comment). */
  rolloutVersion: Record<string, unknown> & { id: string | number | null }
  /** Raw channels.version (null: no bundle). */
  version_ref: number | null
  /** channels.owner_org. */
  owner_org: string
}

export interface PluginStateAppDoc {
  f: typeof PLUGIN_STATE_FORMAT
  app_id: string
  /** Build time (ms): the sync wrote it from the primary at that moment. */
  built_at: number
  /** false: the app does not exist (tombstone). */
  exists: boolean
  /** queryAppOwnerPostgres row without plan_valid / plan_trial_at. */
  owner?: Record<string, unknown> & { owner_org: string }
  plan?: PluginStatePlan
  /** Channels ORDER BY name, id (the order of the plugin channel queries). */
  channels?: PluginStateChannelRow[]
  /** Source scan order for legacy list queries, which have no ORDER BY. */
  channel_list_ids?: number[]
  /** device_id -> channel_id when the app has few overrides, null when per-device keys hold them. */
  overrides?: Record<string, number> | null
  /** Bundles whose manifest document this app's syncs already wrote (served bundles). */
  manifest_ids?: number[]
}

/** queryAppVersionPostgres row plus the deleted flag it filters on. */
export interface PluginStateVersionDoc {
  id: number
  owner_org: string
  deleted: boolean | null
}

export interface PluginStateDeviceDoc {
  channel_id: number | null
}

export interface PluginStateManifestFallbackDoc {
  f: typeof PLUGIN_STATE_FORMAT
  built_at: number
  version_id: number
  app_id: string
  fallback: 'replica'
  reason: 'kv_value_limit' | 'worker_memory_limit'
}

export interface PluginStatePointer {
  f: typeof PLUGIN_STATE_FORMAT
  generation: string
  kvKey: string | null
}

export function isPluginStateGeneration(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
}

export async function pluginStateImmutableKey(logicalKey: string, generation: string) {
  if (!isPluginStateGeneration(generation))
    throw new Error('Invalid plugin state generation')
  return `${KEY_PREFIX}:i:${generation.padStart(20, '0')}:${await sha256Hex(logicalKey)}`
}

export interface PluginStateManifestEntry {
  file_name: string
  file_hash: string
  s3_path: string
}

/** One bundle's manifest, only when every row of it is visible (complete). */
export interface PluginStateManifestDoc {
  f: typeof PLUGIN_STATE_FORMAT
  /** Build time (ms), the revision of the document. */
  built_at: number
  version_id: number
  app_id: string
  /** app_versions.deleted (manifest size lookups need deleted = false). */
  deleted: boolean | null
  /** completeVersionManifest rows, in upload order ([] when incomplete). */
  entries: PluginStateManifestEntry[]
  /** [file_hash, file_size] rows of versionManifestSizeRowsSql ([] when incomplete). */
  sizes: Array<[string, number | string | null]>
}

function encodePart(value: string) {
  return encodeURIComponent(value)
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Keys too long for KV keep their prefix and hash the rest. */
async function boundKey(prefix: string, rest: string) {
  const key = `${prefix}${rest}`
  if (new TextEncoder().encode(key).length <= MAX_KEY_BYTES)
    return key
  return `${prefix}#${await sha256Hex(rest)}`
}

export function pluginStateAppKey(appId: string) {
  return boundKey(`${KEY_PREFIX}:a:`, encodePart(appId))
}

/** Prefix of every bundle-name key of an app (for listing). */
async function appKeyPart(appId: string) {
  const encoded = encodePart(appId)
  return encoded.length <= 160 ? encoded : `#${await sha256Hex(appId)}`
}

export async function pluginStateVersionKeyPrefix(appId: string) {
  return `${KEY_PREFIX}:v:${await appKeyPart(appId)}:`
}

export async function pluginStateVersionKey(appId: string, versionName: string) {
  return boundKey(await pluginStateVersionKeyPrefix(appId), encodePart(versionName))
}

/** Prefix of every device override key of an app (for listing). */
export async function pluginStateDeviceKeyPrefix(appId: string) {
  return `${KEY_PREFIX}:d:${await appKeyPart(appId)}:`
}

export async function pluginStateDeviceKey(appId: string, deviceId: string) {
  return boundKey(await pluginStateDeviceKeyPrefix(appId), encodePart(deviceId))
}

export function pluginStateManifestKey(versionId: number | string) {
  return `${KEY_PREFIX}:m:${String(versionId)}`
}
