// Colo-local cache for the /updates hot path, with targeted invalidation.
//
// Most apps have one public channel and no per-device overrides: their
// channel resolution is identical for every device on the same
// (platform, defaultChannel) and can be served from the colo cache with
// zero database queries. Per-device work (semver compares, rollout
// decisions, override lookups for apps that have them) stays per-request.
//
// Freshness has two layers:
// - a short TTL backstop (UPDATES_CACHE_TTL_SECONDS, default 60s — the same
//   class as the Hyperdrive query cache serving this traffic today), and
// - targeted invalidation: every cached entry is keyed under a per-app
//   version token; bumping the token (bumpAppCacheToken) makes every entry
//   for that app unreachable at once. Database triggers fan the bump out to
//   each regional plugin worker (placement-pinned, so each call lands in
//   the colo whose cache needs clearing) within ~1s of the commit.
//
// The apps.channel_device_count counter (already denormalized and cached in
// the payload) is the switch: apps with overrides keep their per-device
// lookup on every request, so adding a FIRST override reacts within one
// token bump (~1s) or one TTL at worst.

import type { Context } from 'hono'
import type { AppOwnerPostgresResult, getDrizzleClient, PlanAction } from './pg.ts'
import { CacheHelper } from './cache.ts'
import { cloudlog } from './logging.ts'
import {
  getAppOwnerPostgres,
  requestChannelOverrideLookup,
  requestInfosChannelPostgres,
  requestInfosChannelPostgresRollout,
  requestManifestEntriesPostgres,
  resolveRolloutChannelDataPostgres,
} from './pg.ts'
import { existInEnv, getEnv } from './utils.ts'

const TOKEN_CACHE_PATH = '/cache/updates-token'
const OWNER_CACHE_PATH = '/cache/updates-owner'
const CHANNEL_CACHE_PATH = '/cache/updates-channel'
const MANIFEST_CACHE_PATH = '/cache/updates-manifest'

const TOKEN_TTL_SECONDS = 7 * 24 * 3600
const DEFAULT_PAYLOAD_TTL_SECONDS = 60
const MANIFEST_TTL_SECONDS = 300

interface TokenPayload { t: string }
interface OwnerPayload { owner: AppOwnerPostgresResult | null }
interface ChannelPayload { channel: unknown }

export function isUpdatesCacheEnabled(c: Context): boolean {
  return existInEnv(c, 'UPDATES_CACHE_MODE') && getEnv(c, 'UPDATES_CACHE_MODE') === 'on'
}

function payloadTtlSeconds(c: Context): number {
  const raw = Number(getEnv(c, 'UPDATES_CACHE_TTL_SECONDS'))
  return Number.isFinite(raw) && raw >= 5 ? raw : DEFAULT_PAYLOAD_TTL_SECONDS
}

// Per-app version token: every cached payload embeds it in its key, so one
// token bump atomically invalidates all payload variants of the app in this
// colo. The old entries become unreachable and expire by TTL.
async function getAppCacheToken(_c: Context, helper: CacheHelper, appId: string): Promise<string | null> {
  const request = helper.buildRequest(TOKEN_CACHE_PATH, { app_id: appId })
  const cached = await helper.matchJson<TokenPayload>(request)
  if (cached?.t)
    return cached.t
  const token = crypto.randomUUID()
  await helper.putJson(request, { t: token }, TOKEN_TTL_SECONDS)
  return token
}

// Invalidation entry point, called by the /cache_invalidate route on each
// regional plugin worker (fan-out from the cache_invalidate trigger).
export async function bumpAppCacheToken(c: Context, appId: string): Promise<boolean> {
  const helper = new CacheHelper(c)
  const request = helper.buildRequest(TOKEN_CACHE_PATH, { app_id: appId })
  await helper.putJson(request, { t: crypto.randomUUID() }, TOKEN_TTL_SECONDS)
  return true
}

// Drop-in replacement for getAppOwnerPostgres, cached per app. Negative
// results (unknown app) are cached too: unknown-app traffic is the
// enumeration hot path and the apps INSERT trigger bumps the token the
// moment the app is created.
export async function cachedGetAppOwner(
  c: Context,
  appId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  actions: PlanAction[],
): Promise<AppOwnerPostgresResult | null> {
  const helper = new CacheHelper(c)
  const token = await getAppCacheToken(c, helper, appId)
  if (!token)
    return getAppOwnerPostgres(c, appId, drizzleClient, actions)
  const request = helper.buildRequest(OWNER_CACHE_PATH, { app_id: appId, v: token, a: actions.join('-') })
  const cached = await helper.matchJson<OwnerPayload>(request)
  if (cached) {
    cloudlog({ requestId: c.get('requestId'), message: 'updates cache hit (owner)', appId })
    return cached.owner
  }
  const owner = await getAppOwnerPostgres(c, appId, drizzleClient, actions)
  await helper.putJson(request, { owner }, payloadTtlSeconds(c))
  return owner
}

export interface CachedRequestInfosOptions {
  c: Context
  platform: string
  app_id: string
  device_id: string
  defaultChannel: string
  drizzleClient: ReturnType<typeof getDrizzleClient>
  channelDeviceCount?: number | null
  manifestBundleCount?: number | null
  rolloutChannelCount?: number | null
  rolloutPausedVersionNames?: string[] | null
  currentVersionName: string
  includeMetadata?: boolean
  channelSelfOverrideChannelId?: number | null
}

// Cached mirror of requestInfosPostgres (pg.ts): the app-level channel
// lookup is cached per (app, platform, defaultChannel, flags); the
// device-level parts (override lookup, rollout decision, rollout manifest)
// run per request exactly like the uncached path.
export async function cachedRequestInfos(options: CachedRequestInfosOptions): Promise<{ channelData: any, channelOverride: any }> {
  const {
    c,
    platform,
    app_id,
    device_id,
    defaultChannel,
    drizzleClient,
    channelDeviceCount,
    manifestBundleCount,
    rolloutChannelCount,
    rolloutPausedVersionNames,
    currentVersionName,
    includeMetadata = false,
    channelSelfOverrideChannelId,
  } = options
  const shouldQueryChannelOverride = channelDeviceCount === undefined || channelDeviceCount === null ? true : channelDeviceCount > 0
  const shouldFetchManifest = manifestBundleCount === undefined || manifestBundleCount === null ? true : manifestBundleCount > 0
  const isPausedRolloutVersion = Array.isArray(rolloutPausedVersionNames) && rolloutPausedVersionNames.includes(currentVersionName)
  const rollout = (rolloutChannelCount ?? 0) > 0 || isPausedRolloutVersion

  // Device-level override lookup: never cached (per-device result).
  const channelOverridePromise = requestChannelOverrideLookup(c, {
    app_id,
    device_id,
    drizzleClient,
    includeManifest: shouldFetchManifest,
    includeMetadata,
    rollout,
    shouldQueryChannelOverride,
    channelSelfOverrideChannelId,
  })

  // App-level channel resolution: cached.
  const channelPromise = cachedChannelLookup(c, {
    platform,
    app_id,
    defaultChannel,
    drizzleClient,
    includeMetadata,
    includeManifest: shouldFetchManifest,
    rollout,
  })

  const [channelOverrideRaw, channelDataRaw] = await Promise.all([channelOverridePromise, channelPromise])

  if (!rollout)
    return { channelData: channelDataRaw, channelOverride: channelOverrideRaw }

  // Rollout: per-device decision + manifest for the selected version, via
  // the shared resolver with the version-keyed manifest cache as loader.
  const manifestLoader = (versionId: number) => cachedManifestEntries(c, app_id, versionId, drizzleClient)
  const channelOverride = await resolveRolloutChannelDataPostgres(c, channelOverrideRaw, app_id, device_id, currentVersionName, drizzleClient, shouldFetchManifest, manifestLoader)
  const channelData = channelOverride
    ? channelDataRaw
    : await resolveRolloutChannelDataPostgres(c, channelDataRaw, app_id, device_id, currentVersionName, drizzleClient, shouldFetchManifest, manifestLoader)
  return { channelOverride, channelData }
}

interface CachedChannelLookupOptions {
  platform: string
  app_id: string
  defaultChannel: string
  drizzleClient: ReturnType<typeof getDrizzleClient>
  includeMetadata: boolean
  includeManifest: boolean
  rollout: boolean
}

async function cachedChannelLookup(c: Context, options: CachedChannelLookupOptions): Promise<any> {
  const { platform, app_id, defaultChannel, drizzleClient, includeMetadata, includeManifest, rollout } = options
  const load = () => rollout
    ? requestInfosChannelPostgresRollout(c, platform, app_id, defaultChannel, drizzleClient, includeMetadata)
    : requestInfosChannelPostgres(c, platform, app_id, defaultChannel, drizzleClient, includeManifest, includeMetadata)

  const helper = new CacheHelper(c)
  const token = await getAppCacheToken(c, helper, app_id)
  if (!token)
    return load()
  const request = helper.buildRequest(CHANNEL_CACHE_PATH, {
    app_id,
    v: token,
    platform,
    channel: defaultChannel || '-',
    meta: includeMetadata ? '1' : '0',
    manifest: includeManifest ? '1' : '0',
    rollout: rollout ? '1' : '0',
  })
  const cached = await helper.matchJson<ChannelPayload>(request)
  if (cached) {
    cloudlog({ requestId: c.get('requestId'), message: 'updates cache hit (channel)', appId: app_id, platform })
    return cached.channel ?? undefined
  }
  const channel = await load()
  // `undefined` is not JSON-representable; store null and map back on read.
  await helper.putJson(request, { channel: channel ?? null }, payloadTtlSeconds(c))
  return channel
}

// Manifest entries for a rollout-selected version, keyed under the app's
// version token so a token bump (e.g. the manifest trigger) invalidates them
// together with the channel payloads. Empty results are never cached (the
// bundle may still be uploading).
async function cachedManifestEntries(
  c: Context,
  appId: string,
  versionId: number,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ file_name: string | null, file_hash: string | null, s3_path: string | null }[]> {
  const helper = new CacheHelper(c)
  const token = await getAppCacheToken(c, helper, appId)
  if (!token)
    return requestManifestEntriesPostgres(c, versionId, drizzleClient)
  const request = helper.buildRequest(MANIFEST_CACHE_PATH, { app_id: appId, v: token, version_id: String(versionId) })
  const cached = await helper.matchJson<{ entries: { file_name: string | null, file_hash: string | null, s3_path: string | null }[] }>(request)
  if (cached)
    return cached.entries
  const entries = await requestManifestEntriesPostgres(c, versionId, drizzleClient)
  if (entries.length > 0)
    await helper.putJson(request, { entries }, MANIFEST_TTL_SECONDS)
  return entries
}
