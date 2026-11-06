import type { PluginStateAppDoc, PluginStateChannelRow, PluginStateManifestDoc, PluginStatePlan, PluginStateStripe, PluginStateVersionDoc } from './pluginStateFormat.ts'

/**
 * The plugin Postgres queries of pg.ts, evaluated over the KV plugin state.
 * Each function mirrors one query: same filters (SQL NULL semantics: a
 * comparison with NULL never matches), same first-row order, same result
 * shape. plugin-state.unit.test.ts and the differential plugin tests keep
 * them in step with the SQL.
 */

export type PluginStatePlanAction = 'mau' | 'storage' | 'bandwidth'

const EXCEEDED_FLAGS: Record<PluginStatePlanAction, keyof PluginStateStripe> = {
  mau: 'mau_exceeded',
  storage: 'storage_exceeded',
  bandwidth: 'bandwidth_exceeded',
}

type ChannelValues = PluginStateChannelRow['channels'] & Record<string, unknown>

/** The database CURRENT_DATE (sessions run in UTC) at `nowMs`, as YYYY-MM-DD. */
export function pluginStateCurrentDate(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 10)
}

/**
 * buildPlanValidationExpression: usage credits, or a trial still running,
 * or a succeeded subscription without an exceeded limit for these actions,
 * or no Stripe customer at all.
 */
export function evalPlanValid(plan: PluginStatePlan, actions: PluginStatePlanAction[], nowMs: number): boolean {
  if (plan.has_credits)
    return true
  if (plan.customer_id === null)
    return true
  const stripe = plan.stripe
  if (!stripe)
    return false
  if (stripe.trial_date !== null && stripe.trial_date > pluginStateCurrentDate(nowMs))
    return true
  return stripe.status === 'succeeded' && actions.every(action => stripe[EXCEEDED_FLAGS[action]] === false)
}

/** queryAppOwnerPostgres row before its missing-org fallback, or null (missing app / no action). */
export function evalAppOwner(doc: PluginStateAppDoc, actions: PluginStatePlanAction[], includeTrialAt: boolean, nowMs: number) {
  if (actions.length === 0)
    return null
  if (!doc.exists || !doc.owner || !doc.plan)
    return null
  const { owner_org, ...rest } = doc.owner
  const trialAt = doc.plan.customer_id === null ? null : (doc.plan.stripe?.trial_at ?? null)
  return {
    owner_org,
    plan_valid: evalPlanValid(doc.plan, actions, nowMs),
    plan_trial_at: includeTrialAt ? trialAt : null,
    ...rest,
  }
}

/** getAppByIdPg: undefined (no row) for a missing app, null without actions. */
export function evalAppById(doc: PluginStateAppDoc, actions: PluginStatePlanAction[], nowMs: number) {
  if (actions.length === 0)
    return null
  if (!doc.exists || !doc.owner || !doc.plan)
    return undefined
  return { owner_org: doc.owner.owner_org, plan_valid: evalPlanValid(doc.plan, actions, nowMs) }
}

export function evalBlockProviderInfraRequests(doc: PluginStateAppDoc):
  | { status: 'found', blockProviderInfraRequests: boolean }
  | { status: 'missing' } {
  if (!doc.exists || !doc.owner)
    return { status: 'missing' }
  return { status: 'found', blockProviderInfraRequests: doc.owner.block_provider_infra_requests as boolean }
}

function channelRows(doc: PluginStateAppDoc) {
  return doc.exists ? (doc.channels ?? []) : []
}

function channelListRows(doc: PluginStateAppDoc) {
  const rows = channelRows(doc)
  if (!doc.channel_list_ids)
    return rows
  const byId = new Map(rows.map(row => [row.channels.id, row]))
  return doc.channel_list_ids.flatMap(id => {
    const row = byId.get(id)
    return row ? [row] : []
  })
}

/** requestInfosChannelPostgres: ios unless android / electron. */
function platformEnabled(channel: ChannelValues, platform: string) {
  const value = platform === 'android' ? channel.android : platform === 'electron' ? channel.electron : channel.ios
  return value === true
}

/** queryCompatibleChannelsPg: android unless ios / electron. */
function compatiblePlatformEnabled(channel: ChannelValues, platform: string) {
  const value = platform === 'ios' ? channel.ios : platform === 'electron' ? channel.electron : channel.android
  return value === true
}

function selfSetOrPublic(channel: ChannelValues) {
  return channel.public === true || channel.allow_device_self_set === true
}

/** `or(isNull(channel.version), isNotNull(version.id))` of the left-joined queries. */
function hasActiveVersion(row: PluginStateChannelRow) {
  return row.version_ref === null || row.version.id !== null
}

/** The inner join on the active bundle (requestInfosChannelByIdPostgres). */
function hasJoinedVersion(row: PluginStateChannelRow) {
  return row.version.id !== null
}

function versionValues(version: Record<string, unknown>, includeMetadata: boolean) {
  if (includeMetadata)
    return { ...version }
  const { link: _link, comment: _comment, ...rest } = version
  return rest
}

function matchesDefaultChannel(row: PluginStateChannelRow, platform: string, defaultChannel: string | null | undefined) {
  const channel = row.channels as ChannelValues
  if (defaultChannel)
    return channel.name === defaultChannel && platformEnabled(channel, platform) && selfSetOrPublic(channel)
  return channel.public === true && platformEnabled(channel, platform)
}

function findDefaultChannelRow(doc: PluginStateAppDoc, platform: string, defaultChannel: string | null | undefined) {
  return channelRows(doc).find(row => matchesDefaultChannel(row, platform, defaultChannel) && hasActiveVersion(row))
}

/** requestInfosChannelPostgres without the manifest column. */
export function evalDefaultChannel(doc: PluginStateAppDoc, platform: string, defaultChannel: string | null | undefined, includeMetadata: boolean) {
  const row = findDefaultChannelRow(doc, platform, defaultChannel)
  if (!row)
    return undefined
  return { version: versionValues(row.version, includeMetadata), channels: { ...row.channels } }
}

/** requestInfosChannelPostgresRollout. */
export function evalDefaultChannelRollout(doc: PluginStateAppDoc, platform: string, defaultChannel: string | null | undefined, includeMetadata: boolean) {
  const row = findDefaultChannelRow(doc, platform, defaultChannel)
  if (!row)
    return undefined
  return { version: versionValues(row.version, includeMetadata), rolloutVersion: versionValues(row.rolloutVersion, includeMetadata), channels: { ...row.channels } }
}

/** requestInfosChannelByIdPostgres without the manifest column (inner join on the bundle). */
export function evalChannelById(doc: PluginStateAppDoc, channelId: number, includeMetadata: boolean) {
  const row = channelRows(doc).find(candidate => candidate.channels.id === channelId && hasJoinedVersion(candidate))
  if (!row)
    return undefined
  return { version: versionValues(row.version, includeMetadata), channels: { ...row.channels } }
}

/** requestInfosChannelByIdPostgresRollout. */
export function evalChannelByIdRollout(doc: PluginStateAppDoc, channelId: number, includeMetadata: boolean) {
  const row = channelRows(doc).find(candidate => candidate.channels.id === channelId && hasActiveVersion(candidate))
  if (!row)
    return undefined
  return { version: versionValues(row.version, includeMetadata), rolloutVersion: versionValues(row.rolloutVersion, includeMetadata), channels: { ...row.channels } }
}

/** requestInfosChannelDevicePostgres without the manifest column. */
export function evalChannelDevice(doc: PluginStateAppDoc, appId: string, deviceId: string, channelId: number | null, includeMetadata: boolean) {
  if (channelId === null)
    return undefined
  const row = channelRows(doc).find(candidate => candidate.channels.id === channelId && hasActiveVersion(candidate))
  if (!row)
    return undefined
  return {
    channel_devices: { device_id: deviceId, app_id: appId },
    version: versionValues(row.version, includeMetadata),
    channels: { ...row.channels },
  }
}

/** requestInfosChannelDevicePostgresRollout. */
export function evalChannelDeviceRollout(doc: PluginStateAppDoc, channelId: number | null, includeMetadata: boolean) {
  if (channelId === null)
    return undefined
  const row = channelRows(doc).find(candidate => candidate.channels.id === channelId && hasActiveVersion(candidate))
  if (!row)
    return undefined
  return { version: versionValues(row.version, includeMetadata), rolloutVersion: versionValues(row.rolloutVersion, includeMetadata), channels: { ...row.channels } }
}

/** getChannelDeviceOverridePg (null for an orphaned override). */
export function evalChannelDeviceOverride(doc: PluginStateAppDoc, appId: string, deviceId: string, channelId: number | null) {
  if (channelId === null)
    return null
  const row = channelRows(doc).find(candidate => candidate.channels.id === channelId)
  if (!row || typeof row.channels.allow_device_self_set !== 'boolean' || !row.channels.name)
    return null
  return {
    app_id: appId,
    device_id: deviceId,
    channel_id: {
      id: row.channels.id,
      allow_device_self_set: row.channels.allow_device_self_set,
      name: row.channels.name,
    },
  }
}

/** queryChannelByPg (channel names are unique per app). */
export function evalChannelLookup(doc: PluginStateAppDoc, filter: { name: string } | { id: number }) {
  const row = channelRows(doc).find(candidate => 'name' in filter ? candidate.channels.name === filter.name : candidate.channels.id === filter.id)
  if (!row)
    return null
  const channel = row.channels as ChannelValues
  return {
    id: channel.id,
    name: channel.name,
    allow_device_self_set: channel.allow_device_self_set as boolean,
    public: channel.public as boolean,
    owner_org: row.owner_org,
  }
}

/** getMainChannelsPg. */
export function evalMainChannels(doc: PluginStateAppDoc) {
  return channelListRows(doc)
    .filter(row => row.channels.public === true)
    .map((row) => {
      const channel = row.channels as ChannelValues
      return { name: channel.name, ios: channel.ios as boolean, android: channel.android as boolean, electron: channel.electron as boolean }
    })
}

/** getChannelsPg. */
export function evalChannels(doc: PluginStateAppDoc, condition: { defaultChannel?: string } | { public: boolean }) {
  return channelListRows(doc)
    .filter((row) => {
      if ('defaultChannel' in condition && condition.defaultChannel)
        return row.channels.name === condition.defaultChannel
      if ('public' in condition)
        return row.channels.public === condition.public
      return true
    })
    .map((row) => {
      const channel = row.channels as ChannelValues
      return { id: channel.id, name: channel.name, ios: channel.ios as boolean, android: channel.android as boolean, electron: channel.electron as boolean, public: channel.public as boolean }
    })
}

/** queryCompatibleChannelsPg. */
export function evalCompatibleChannels(doc: PluginStateAppDoc, platform: string, isEmulator: boolean, isProd: boolean) {
  return channelListRows(doc)
    .filter((row) => {
      const channel = row.channels as ChannelValues
      return selfSetOrPublic(channel)
        && (isEmulator ? channel.allow_emulator === true : channel.allow_device === true)
        && (isProd ? channel.allow_prod === true : channel.allow_dev === true)
        && compatiblePlatformEnabled(channel, platform)
    })
    .map((row) => {
      const channel = row.channels as ChannelValues
      return {
        id: channel.id,
        name: channel.name,
        allow_device_self_set: channel.allow_device_self_set as boolean,
        allow_emulator: channel.allow_emulator as boolean,
        allow_device: channel.allow_device as boolean,
        allow_dev: channel.allow_dev as boolean,
        allow_prod: channel.allow_prod as boolean,
        ios: channel.ios as boolean,
        android: channel.android as boolean,
        electron: channel.electron as boolean,
        public: channel.public as boolean,
      }
    })
}

/**
 * Channel lookups of getEffectiveDeviceChannelNamePostgres: by id or name
 * (enabled for the platform, public or self-set), the device override
 * channel (same app), or the public channel of the platform.
 */
export function evalEffectiveChannel(
  doc: PluginStateAppDoc,
  lookup: { by: 'id', id: number, platform: string } | { by: 'override', id: number } | { by: 'name', name: string, platform: string } | { by: 'public', platform: string },
) {
  const row = channelRows(doc).find((candidate) => {
    const channel = candidate.channels as ChannelValues
    switch (lookup.by) {
      case 'id':
        return channel.id === lookup.id && platformEnabled(channel, lookup.platform) && selfSetOrPublic(channel)
      case 'override':
        return channel.id === lookup.id
      case 'name':
        return channel.name === lookup.name && platformEnabled(channel, lookup.platform) && selfSetOrPublic(channel)
      case 'public':
        return channel.public === true && platformEnabled(channel, lookup.platform)
    }
    return false
  })
  return row ? { id: row.channels.id, name: row.channels.name } : undefined
}

/** queryAppVersionPostgres over a bundle-name document (null: no such bundle). */
export function evalAppVersion(version: PluginStateVersionDoc | null, allowedDeleted: boolean | undefined) {
  if (!version)
    return null
  if (allowedDeleted !== undefined && version.deleted !== allowedDeleted)
    return null
  return { id: version.id, owner_org: version.owner_org }
}

/** requestManifestEntriesPostgres rows (complete manifests only). */
export function evalManifestEntries(manifest: PluginStateManifestDoc | null) {
  return manifest ? manifest.entries.map(entry => ({ file_name: entry.file_name, file_hash: entry.file_hash, s3_path: entry.s3_path })) : []
}

/** A manifest the size lookups may read: same app and deleted = false. */
function sizeRowsOf(manifest: PluginStateManifestDoc | null, appId: string) {
  if (!manifest || manifest.app_id !== appId || manifest.deleted !== false)
    return null
  return manifest.sizes
}

/** MAX(file_size) of bigint values as the pg driver returns them (strings). */
function maxSize(values: Array<number | string | null>) {
  let best: bigint | null = null
  for (const value of values) {
    if (value === null)
      continue
    const size = BigInt(value)
    if (best === null || size > best)
      best = size
  }
  return best === null ? null : best.toString()
}

export interface ManifestSizeStateRow {
  file_hash: string
  version_id: string
  file_size: string | null
}

/** Grouped (file_hash, version_id) -> MAX(file_size), restricted to the requested hashes. */
function groupSizes(versionId: number, rows: Array<[string, number | string | null]>, hashes: Set<string> | null): ManifestSizeStateRow[] {
  const byHash = new Map<string, Array<number | string | null>>()
  for (const [hash, size] of rows) {
    if (hashes && !hashes.has(hash))
      continue
    const sizes = byHash.get(hash)
    if (sizes)
      sizes.push(size)
    else
      byHash.set(hash, [size])
  }
  return [...byHash].map(([hash, sizes]) => ({ file_hash: hash, version_id: String(versionId), file_size: maxSize(sizes) }))
}

/**
 * buildManifestSizeLookupQuery over the state: requested files scoped to a
 * bundle id use that bundle; unscoped ones use the fallback bundle (by id,
 * else by name). `manifests` holds the docs of every bundle id involved.
 */
export function evalManifestSizeLookup(
  appId: string,
  files: Array<{ file_hash: string, version_id: number | null }>,
  fallback: { versionId: number } | { versionName: string, version: PluginStateVersionDoc | null } | null,
  manifests: Map<number, PluginStateManifestDoc | null>,
): ManifestSizeStateRow[] {
  const rows: ManifestSizeStateRow[] = []
  const scopedHashes = new Map<number, Set<string>>()
  const unscopedHashes = new Set<string>()
  for (const file of files) {
    if (file.version_id == null) {
      unscopedHashes.add(file.file_hash)
      continue
    }
    const hashes = scopedHashes.get(file.version_id) ?? new Set<string>()
    hashes.add(file.file_hash)
    scopedHashes.set(file.version_id, hashes)
  }
  for (const [versionId, hashes] of scopedHashes) {
    const sizes = sizeRowsOf(manifests.get(versionId) ?? null, appId)
    if (sizes)
      rows.push(...groupSizes(versionId, sizes, hashes))
  }
  if (unscopedHashes.size > 0 && fallback) {
    if ('versionId' in fallback) {
      const sizes = sizeRowsOf(manifests.get(fallback.versionId) ?? null, appId)
      if (sizes)
        rows.push(...groupSizes(fallback.versionId, sizes, unscopedHashes))
    }
    else if (fallback.version && fallback.version.deleted === false) {
      const manifest = manifests.get(fallback.version.id) ?? null
      // The name branch reads the bundle row itself (app and deleted checked above).
      if (manifest && manifest.app_id === appId)
        rows.push(...groupSizes(fallback.version.id, manifest.sizes, unscopedHashes))
    }
  }
  return rows
}

/** buildManifestVersionSizesQuery over the state. */
export function evalManifestVersionSizes(appId: string, versionIds: number[], manifests: Map<number, PluginStateManifestDoc | null>): ManifestSizeStateRow[] {
  const rows: ManifestSizeStateRow[] = []
  for (const versionId of versionIds) {
    const sizes = sizeRowsOf(manifests.get(versionId) ?? null, appId)
    if (sizes)
      rows.push(...groupSizes(versionId, sizes, null))
  }
  return rows
}
