import type { PluginStateAppDoc, PluginStateChannelRow, PluginStateDeviceDoc, PluginStateManifestDoc, PluginStatePlan, PluginStateStripe, PluginStateVersionDoc } from './pluginStateFormat.ts'
import { PLUGIN_STATE_FORMAT } from './pluginStateFormat.ts'

// Match the dependency-free predicates used by plugin_schemas/*.is.ts. Pulling
// a schema interpreter into this hot-path worker exceeds its bundle-size budget.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isStripe(value: unknown): value is PluginStateStripe {
  return isRecord(value)
    && isNullableString(value.status)
    && isNullableString(value.trial_at)
    && isNullableString(value.trial_date)
    && isNullableBoolean(value.mau_exceeded)
    && isNullableBoolean(value.storage_exceeded)
    && isNullableBoolean(value.bandwidth_exceeded)
}

function isPlan(value: unknown): value is PluginStatePlan {
  return isRecord(value)
    && typeof value.has_credits === 'boolean'
    && isNullableString(value.customer_id)
    && (value.stripe === null || isStripe(value.stripe))
}

function isVersionValues(value: unknown): value is PluginStateChannelRow['version'] {
  return isRecord(value) && (value.id === null || typeof value.id === 'number' || typeof value.id === 'string')
}

const CHANNEL_BOOLEAN_FIELDS = ['allow_dev', 'allow_prod', 'allow_emulator', 'allow_device', 'ios', 'android', 'electron', 'public', 'allow_device_self_set']

function isChannelRow(value: unknown): value is PluginStateChannelRow {
  if (!isRecord(value) || !isRecord(value.channels))
    return false
  const channel = value.channels
  return typeof channel.id === 'number'
    && typeof channel.name === 'string'
    && CHANNEL_BOOLEAN_FIELDS.every(field => typeof channel[field] === 'boolean')
    && isVersionValues(value.version)
    && isVersionValues(value.rolloutVersion)
    && (value.version_ref === null || typeof value.version_ref === 'number')
    && typeof value.owner_org === 'string'
}

function isApp(value: unknown): value is PluginStateAppDoc {
  return isRecord(value)
    && value.f === PLUGIN_STATE_FORMAT
    && typeof value.app_id === 'string'
    && typeof value.built_at === 'number'
    && typeof value.exists === 'boolean'
    && (value.owner === undefined || (isRecord(value.owner) && typeof value.owner.owner_org === 'string'))
    && (value.plan === undefined || isPlan(value.plan))
    && (value.channels === undefined || (Array.isArray(value.channels) && value.channels.every(isChannelRow)))
    && (value.channel_list_ids === undefined || (Array.isArray(value.channel_list_ids) && value.channel_list_ids.every(id => typeof id === 'number')))
    && (value.overrides === undefined || value.overrides === null || (isRecord(value.overrides) && Object.values(value.overrides).every(id => typeof id === 'number')))
    && (value.manifest_ids === undefined || (Array.isArray(value.manifest_ids) && value.manifest_ids.every(id => typeof id === 'number')))
    && (!value.exists || (value.owner !== undefined && value.plan !== undefined && value.channels !== undefined))
}

export function parsePluginStateApp(value: unknown): PluginStateAppDoc {
  if (!isApp(value))
    throw new Error('Invalid plugin app state')
  return value
}

export function parsePluginStateVersion(value: unknown): PluginStateVersionDoc {
  if (!isRecord(value) || typeof value.id !== 'number' || typeof value.owner_org !== 'string' || !isNullableBoolean(value.deleted))
    throw new Error('Invalid plugin version state')
  return { id: value.id, owner_org: value.owner_org, deleted: value.deleted }
}

export function parsePluginStateDevice(value: unknown): PluginStateDeviceDoc {
  if (!isRecord(value) || typeof value.channel_id !== 'number')
    throw new Error('Invalid plugin device state')
  return { channel_id: value.channel_id }
}

function isManifest(value: unknown): value is PluginStateManifestDoc {
  return isRecord(value)
    && value.f === PLUGIN_STATE_FORMAT
    && typeof value.built_at === 'number'
    && typeof value.version_id === 'number'
    && typeof value.app_id === 'string'
    && isNullableBoolean(value.deleted)
    && Array.isArray(value.entries)
    && value.entries.every(entry => isRecord(entry) && typeof entry.file_name === 'string' && typeof entry.file_hash === 'string' && typeof entry.s3_path === 'string')
    && Array.isArray(value.sizes)
    && value.sizes.every(row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && (row[1] === null || typeof row[1] === 'number' || (typeof row[1] === 'string' && /^\d+$/.test(row[1]))))
}

export function parsePluginStateManifest(value: unknown): PluginStateManifestDoc {
  if (!isManifest(value))
    throw new Error('Invalid plugin manifest state')
  return value
}
