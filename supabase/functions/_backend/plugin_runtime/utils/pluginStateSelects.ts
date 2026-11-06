import type { PluginStateChannelRow } from './pluginStateFormat.ts'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import * as schema from './postgres_schema.ts'
import { versionManifestJsonSql } from './version_manifest_sql.ts'

/**
 * Select shapes of the plugin channel / bundle / owner queries. pg.ts builds
 * its request queries from them, and triggers/plugin_state_sync selects the
 * same shapes (without the per-request filters) to write the KV plugin state,
 * so both paths hand the endpoints the same row values.
 */

/** Any Drizzle Postgres database (the plugin's request client or the sync's primary client). */
type AnyPgDatabase = { select: (...args: any[]) => any }

export function getAlias() {
  const versionAlias = alias(schema.app_versions, 'version')
  const rolloutVersionAlias = alias(schema.app_versions, 'rollout_version')
  const channelDevicesAlias = alias(schema.channel_devices, 'channel_devices')
  const channelAlias = alias(schema.channels, 'channels')
  return { versionAlias, rolloutVersionAlias, channelDevicesAlias, channelAlias }
}

export function getVersionSelect(
  versionAlias: any,
  prefix: string,
  includeMetadata = false,
  channelVersionColumn?: any,
) {
  const versionSelect: any = {
    id: sql<number | null>`${versionAlias.id}`.as(`${prefix}id`),
    name: channelVersionColumn
      ? sql<string>`CASE WHEN ${channelVersionColumn} IS NULL THEN 'builtin' ELSE ${versionAlias.name} END`.as(`${prefix}name`)
      : sql<string>`${versionAlias.name}`.as(`${prefix}name`),
    checksum: sql<string | null>`${versionAlias.checksum}`.as(`${prefix}checksum`),
    session_key: sql<string | null>`${versionAlias.session_key}`.as(`${prefix}session_key`),
    key_id: sql<string | null>`${versionAlias.key_id}`.as(`${prefix}key_id`),
    storage_provider: sql<string>`COALESCE(${versionAlias.storage_provider}, 'r2')`.as(`${prefix}storage_provider`),
    external_url: sql<string | null>`${versionAlias.external_url}`.as(`${prefix}external_url`),
    min_update_version: sql<string | null>`${versionAlias.min_update_version}`.as(`${prefix}minUpdateVersion`),
    manifest_count: sql<number>`${versionAlias.manifest_count}`.as(`${prefix}manifest_count`),
    r2_path: sql`${versionAlias.r2_path}`.mapWith(versionAlias.r2_path).as(`${prefix}r2_path`),
    deleted: sql<boolean>`COALESCE(${versionAlias.deleted}, false)`.as(`${prefix}deleted`),
    deleted_at: sql<string | null>`${versionAlias.deleted_at}`.as(`${prefix}deleted_at`),
  }

  if (includeMetadata) {
    versionSelect.link = sql<string | null>`${versionAlias.link}`.as(`${prefix}link`)
    versionSelect.comment = sql<string | null>`${versionAlias.comment}`.as(`${prefix}comment`)
  }

  return versionSelect
}

export function getChannelSelect(channelAlias: ReturnType<typeof getAlias>['channelAlias']) {
  return {
    id: channelAlias.id,
    name: channelAlias.name,
    app_id: channelAlias.app_id,
    allow_dev: channelAlias.allow_dev,
    allow_prod: channelAlias.allow_prod,
    allow_emulator: channelAlias.allow_emulator,
    allow_device: channelAlias.allow_device,
    disable_auto_update_under_native: channelAlias.disable_auto_update_under_native,
    disable_auto_update: channelAlias.disable_auto_update,
    update_package: channelAlias.update_package,
    ios: channelAlias.ios,
    android: channelAlias.android,
    electron: channelAlias.electron,
    allow_device_self_set: channelAlias.allow_device_self_set,
    public: channelAlias.public,
    rollout_version: channelAlias.rollout_version,
    rollout_percentage_bps: channelAlias.rollout_percentage_bps,
    rollout_enabled: channelAlias.rollout_enabled,
    rollout_id: channelAlias.rollout_id,
    rollout_paused_at: channelAlias.rollout_paused_at,
    rollout_pause_reason: channelAlias.rollout_pause_reason,
    rollout_cache_ttl_seconds: channelAlias.rollout_cache_ttl_seconds,
    paused_at: channelAlias.paused_at,
  }
}

export function getSchemaUpdatesAlias(includeMetadata = false) {
  const { versionAlias, rolloutVersionAlias, channelDevicesAlias, channelAlias } = getAlias()
  const versionSelect = getVersionSelect(versionAlias, 'v', includeMetadata, channelAlias.version)
  const rolloutVersionSelect = getVersionSelect(rolloutVersionAlias, 'rv', includeMetadata)
  const channelSelect = getChannelSelect(channelAlias)
  const manifestSelect = versionManifestJsonSql(versionAlias.id)
  return { versionSelect, rolloutVersionSelect, channelDevicesAlias, channelAlias, channelSelect, manifestSelect, versionAlias, rolloutVersionAlias }
}

export function activeChannelVersionJoin(
  channelVersionColumn: any,
  versionAlias: any,
  channelAppIdColumn?: any,
) {
  const conditions = [
    eq(channelVersionColumn, versionAlias.id),
    or(
      and(eq(versionAlias.deleted, false), isNull(versionAlias.deleted_at)),
      eq(versionAlias.name, 'builtin'),
    ),
  ]

  if (channelAppIdColumn)
    conditions.push(eq(versionAlias.app_id, channelAppIdColumn))

  return and(...conditions)
}

/** Owner fields of queryAppOwnerPostgres (plan_valid / plan_trial_at are added by the caller). */
export function getAppOwnerSelect(orgAlias: ReturnType<typeof getOwnerOrgAlias>) {
  return {
    owner_org: schema.apps.owner_org,
    channel_device_count: schema.apps.channel_device_count,
    manifest_bundle_count: schema.apps.manifest_bundle_count,
    rollout_channel_count: schema.apps.rollout_channel_count,
    rollout_paused_version_names: schema.apps.rollout_paused_version_names,
    expose_metadata: schema.apps.expose_metadata,
    allow_device_custom_id: schema.apps.allow_device_custom_id,
    block_provider_infra_requests: schema.apps.block_provider_infra_requests,
    device_data_collection: schema.apps.device_data_collection,
    orgs: {
      created_by: orgAlias.created_by,
      id: orgAlias.id,
      management_email: orgAlias.management_email,
    },
  }
}

export function getOwnerOrgAlias() {
  return alias(schema.orgs, 'orgs')
}

/** JSON round trip: the plugin state stores, and the edge caches serve, this form. */
export function toPluginStateJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Keep legacy list order separate from the sorted channel-selection rows. */
export async function selectPluginStateChannelListIds(db: AnyPgDatabase, appId: string): Promise<number[]> {
  // Read the row columns, as the legacy list queries do. Selecting only id
  // can choose an index-only scan with a different order after row updates.
  const rows: { id: number }[] = await db.select()
    .from(schema.channels)
    .where(eq(schema.channels.app_id, appId))
  return rows.map(row => row.id)
}

/**
 * Every channel of an app with its served and rollout bundles, in the order
 * of the plugin channel queries (name, id). The per-request filters
 * (platform, name, public / self-set, active bundle) are applied to these
 * rows by pluginStateEval.ts.
 */
export async function selectPluginStateChannels(db: AnyPgDatabase, appId: string): Promise<PluginStateChannelRow[]> {
  const { versionSelect, rolloutVersionSelect, channelAlias, channelSelect, versionAlias, rolloutVersionAlias } = getSchemaUpdatesAlias(true)
  const rows = await db
    .select({
      version: versionSelect,
      rolloutVersion: rolloutVersionSelect,
      channels: channelSelect,
      version_ref: channelAlias.version,
      owner_org: channelAlias.owner_org,
    })
    .from(channelAlias)
    .leftJoin(versionAlias, activeChannelVersionJoin(channelAlias.version, versionAlias))
    .leftJoin(rolloutVersionAlias, activeChannelVersionJoin(channelAlias.rollout_version, rolloutVersionAlias, channelAlias.app_id))
    .where(eq(channelAlias.app_id, appId))
    .orderBy(asc(channelAlias.name), asc(channelAlias.id))
  return toPluginStateJson(rows) as PluginStateChannelRow[]
}

/** queryAppOwnerPostgres row of an app without its plan fields, or null when the app does not exist. */
export async function selectPluginStateOwner(db: AnyPgDatabase, appId: string) {
  const orgAlias = getOwnerOrgAlias()
  const rows = await db
    .select(getAppOwnerSelect(orgAlias))
    .from(schema.apps)
    .where(eq(schema.apps.app_id, appId))
    .leftJoin(orgAlias, eq(schema.apps.owner_org, orgAlias.id))
    .limit(1)
  return rows[0] ? toPluginStateJson(rows[0]) : null
}
