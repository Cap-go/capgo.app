import type { Context } from 'hono'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import { parse } from '@std/semver'
import { getRuntimeKey } from 'hono/adapter'
import { CacheHelper } from './cache.ts'
import { quickError } from './hono.ts'
import { cloudlogErr, serializeError } from './logging.ts'
import { isDeprecatedPluginVersion } from './utils.ts'

const CHANNEL_SELF_CACHE_PATH = '/.channel-self-override-v1'
const CHANNEL_SELF_CACHE_TTL_SECONDS = 60
const CHANNEL_SELF_KV_CACHE_TTL_SECONDS = 60
const CHANNEL_SELF_STORE_MIN_V5 = '5.34.0'
const CHANNEL_SELF_STORE_MIN_V6 = '6.34.0'
const CHANNEL_SELF_STORE_MIN_V7 = '7.34.0'
const CHANNEL_SELF_STORE_MIN_V8 = '8.0.0'
const CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION = '0.0.0'

// TODO: Delete this legacy channel_self KV/cache bridge once old plugin versions are no longer used. // NOSONAR
// The cache layer only exists for those old versions so channel_self writes do not hit the primary database.
export interface ChannelSelfOverride {
  app_id: string
  device_id: string
  channel_id: {
    id: number
  }
}

export interface ChannelSelfOverrideWrite {
  app_id: string
  device_id: string
  channel_id: number
  plugin_version?: string | null
}

interface ChannelSelfOverridePayload {
  app_id: string
  device_id: string
  channel_id: number
  updated_at: string
}

type ChannelSelfContext = Context<MiddlewareKeyVariables>
type ChannelSelfDeviceClient = SupabaseClient<Database>
type ChannelSelfOverrideSyncInput = Omit<ChannelSelfOverrideWrite, 'plugin_version'>

function getChannelSelfStore(c: ChannelSelfContext) {
  return c.env?.CHANNEL_SELF_STORE ?? null
}

function buildChannelSelfStoreKey(appId: string, deviceId: string) {
  return `channel_self:v1:${encodeURIComponent(appId)}:${encodeURIComponent(deviceId)}`
}

function buildChannelSelfCacheRequest(cache: CacheHelper, appId: string, deviceId: string) {
  return cache.buildRequest(CHANNEL_SELF_CACHE_PATH, {
    app_id: appId,
    device_id: deviceId,
  })
}

function toPayload(appId: string, deviceId: string, override: ChannelSelfOverride): ChannelSelfOverridePayload {
  return {
    app_id: appId,
    device_id: deviceId,
    channel_id: override.channel_id.id,
    updated_at: new Date().toISOString(),
  }
}

function fromPayload(appId: string, deviceId: string, payload: ChannelSelfOverridePayload | null): ChannelSelfOverride | null {
  if (
    payload?.app_id !== appId
    || payload.device_id !== deviceId
    || typeof payload.channel_id !== 'number'
  ) {
    return null
  }

  return {
    app_id: payload.app_id,
    device_id: payload.device_id,
    channel_id: {
      id: payload.channel_id,
    },
  }
}

export function isChannelSelfStoreEnabled(c: ChannelSelfContext) {
  return Boolean(getChannelSelfStore(c))
}

function shouldRequireChannelSelfStore() {
  // Supabase/Deno fallback cannot bind Cloudflare KV; Cloudflare API traffic must fail if the KV binding is missing.
  return getRuntimeKey() === 'workerd'
}

export function shouldSyncChannelSelfOverrideForPluginVersion(pluginVersion: string | null | undefined) {
  if (!pluginVersion)
    return false
  if (pluginVersion === CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION)
    return true

  try {
    return isDeprecatedPluginVersion(parse(pluginVersion), CHANNEL_SELF_STORE_MIN_V5, CHANNEL_SELF_STORE_MIN_V6, CHANNEL_SELF_STORE_MIN_V7, CHANNEL_SELF_STORE_MIN_V8)
  }
  catch {
    return false
  }
}

function shouldDeleteChannelSelfOverrideForPluginVersion(pluginVersion: string | null | undefined) {
  if (!pluginVersion)
    return true
  if (pluginVersion === CHANNEL_SELF_STORE_PLACEHOLDER_PLUGIN_VERSION)
    return true

  try {
    return isDeprecatedPluginVersion(parse(pluginVersion), CHANNEL_SELF_STORE_MIN_V5, CHANNEL_SELF_STORE_MIN_V6, CHANNEL_SELF_STORE_MIN_V7, CHANNEL_SELF_STORE_MIN_V8)
  }
  catch {
    return true
  }
}

async function getChannelSelfOverridePluginVersion(c: ChannelSelfContext, supabase: ChannelSelfDeviceClient, appId: string, deviceId: string) {
  const { data, error } = await supabase
    .from('devices')
    .select('plugin_version')
    .eq('app_id', appId)
    .eq('device_id', deviceId.toLowerCase())
    .maybeSingle()

  if (error) {
    quickError(500, 'device_error', 'Error reading device plugin version', { error, app_id: appId, device_id: deviceId })
  }

  return data?.plugin_version ?? null
}

export async function syncLegacyChannelSelfOverrideForDevice(c: ChannelSelfContext, supabase: ChannelSelfDeviceClient, override: ChannelSelfOverrideSyncInput) {
  const pluginVersion = await getChannelSelfOverridePluginVersion(c, supabase, override.app_id, override.device_id)
  return syncChannelSelfOverride(c, {
    ...override,
    plugin_version: pluginVersion,
  })
}

export async function syncLegacyChannelSelfOverrideDeleteForDevice(c: ChannelSelfContext, supabase: ChannelSelfDeviceClient, appId: string, deviceId: string) {
  const pluginVersion = await getChannelSelfOverridePluginVersion(c, supabase, appId, deviceId)
  return syncChannelSelfOverrideDelete(c, appId, deviceId, pluginVersion)
}

export async function syncChannelSelfOverride(c: ChannelSelfContext, override: ChannelSelfOverrideWrite) {
  if (!shouldSyncChannelSelfOverrideForPluginVersion(override.plugin_version))
    return true

  if (!isChannelSelfStoreEnabled(c)) {
    if (shouldRequireChannelSelfStore()) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Missing channel_self override store binding', app_id: override.app_id, device_id: override.device_id })
      return false
    }
    return true
  }

  const normalizedDeviceId = override.device_id.toLowerCase()
  return setChannelSelfOverride(c, override.app_id, normalizedDeviceId, {
    app_id: override.app_id,
    device_id: normalizedDeviceId,
    channel_id: {
      id: override.channel_id,
    },
  })
}

export async function syncChannelSelfOverrideDelete(c: ChannelSelfContext, appId: string, deviceId: string, pluginVersion?: string | null) {
  if (!shouldDeleteChannelSelfOverrideForPluginVersion(pluginVersion))
    return true

  if (!isChannelSelfStoreEnabled(c)) {
    if (shouldRequireChannelSelfStore()) {
      cloudlogErr({ requestId: c.get('requestId'), message: 'Missing channel_self override store binding', app_id: appId, device_id: deviceId })
      return false
    }
    return true
  }

  return deleteChannelSelfOverride(c, appId, deviceId.toLowerCase())
}

export async function getChannelSelfOverride(c: ChannelSelfContext, appId: string, deviceId: string): Promise<ChannelSelfOverride | null> {
  const store = getChannelSelfStore(c)
  if (!store)
    return null

  const cache = new CacheHelper(c)
  const cacheRequest = buildChannelSelfCacheRequest(cache, appId, deviceId)
  const cachedPayload = await cache.matchJson<ChannelSelfOverridePayload>(cacheRequest)
  const cachedOverride = fromPayload(appId, deviceId, cachedPayload)
  if (cachedOverride)
    return cachedOverride

  const key = buildChannelSelfStoreKey(appId, deviceId)
  try {
    const payload = await store.get<ChannelSelfOverridePayload>(key, {
      type: 'json',
      cacheTtl: CHANNEL_SELF_KV_CACHE_TTL_SECONDS,
    })
    const override = fromPayload(appId, deviceId, payload)
    if (override)
      await cache.putJson(cacheRequest, payload, CHANNEL_SELF_CACHE_TTL_SECONDS)
    return override
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error reading channel_self override store', app_id: appId, device_id: deviceId, error: serializeError(error) })
    return null
  }
}

export async function setChannelSelfOverride(c: ChannelSelfContext, appId: string, deviceId: string, override: ChannelSelfOverride) {
  const store = getChannelSelfStore(c)
  if (!store)
    return false

  const key = buildChannelSelfStoreKey(appId, deviceId)
  const payload = toPayload(appId, deviceId, override)
  try {
    await store.put(key, JSON.stringify(payload))
    const cache = new CacheHelper(c)
    await cache.putJson(buildChannelSelfCacheRequest(cache, appId, deviceId), payload, CHANNEL_SELF_CACHE_TTL_SECONDS)
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error writing channel_self override store', app_id: appId, device_id: deviceId, error: serializeError(error) })
    return false
  }
}

export async function deleteChannelSelfOverride(c: ChannelSelfContext, appId: string, deviceId: string) {
  const store = getChannelSelfStore(c)
  if (!store)
    return false

  const key = buildChannelSelfStoreKey(appId, deviceId)
  try {
    await store.delete(key)
    const cache = new CacheHelper(c)
    await cache.delete(buildChannelSelfCacheRequest(cache, appId, deviceId))
    return true
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'Error deleting channel_self override store', app_id: appId, device_id: deviceId, error: serializeError(error) })
    return false
  }
}
