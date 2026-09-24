import type { Context } from 'hono'
import type { AppInfos } from './types.ts'
import { parse, tryParse } from '@std/semver'
import { CacheHelper } from './cache.ts'
import { backgroundTask, fixSemver, isDeprecatedPluginVersion } from './utils.ts'

const UPDATE_READ_CACHE_PATH = '/.update-read-v1'
const UPDATE_READ_CACHE_TTL_SECONDS = 60
const CHANNEL_SELF_STORE_MIN_V5 = '5.34.0'
const CHANNEL_SELF_STORE_MIN_V6 = '6.34.0'
const CHANNEL_SELF_STORE_MIN_V7 = '7.34.0'
const CHANNEL_SELF_STORE_MIN_V8 = '8.0.0'

export interface UpdateReadCachePayload {
  ownerOrg: string
  allowDeviceCustomId: boolean
  versionName: string
}

export interface UpdateReadCacheKey {
  appId: string
  platform: string
  defaultChannel: string
}

function buildUpdateReadRequest(c: Context, key: UpdateReadCacheKey) {
  const helper = new CacheHelper(c)
  return {
    helper,
    request: helper.buildRequest(UPDATE_READ_CACHE_PATH, {
      app_id: key.appId,
      platform: key.platform,
      channel: key.defaultChannel,
    }),
  }
}

export async function getUpdateReadCache(c: Context, key: UpdateReadCacheKey): Promise<UpdateReadCachePayload | null> {
  const cacheEntry = buildUpdateReadRequest(c, key)
  const payload = await cacheEntry.helper.matchJson<UpdateReadCachePayload>(cacheEntry.request)
  if (!payload?.ownerOrg || !payload.versionName)
    return null
  return payload
}

export function setUpdateReadCache(c: Context, key: UpdateReadCacheKey, payload: UpdateReadCachePayload) {
  return backgroundTask(c, (async () => {
    const cacheEntry = buildUpdateReadRequest(c, key)
    await cacheEntry.helper.putJson(cacheEntry.request, payload, UPDATE_READ_CACHE_TTL_SECONDS, { timeoutMs: 20 })
  })())
}

function usesLegacyChannelSelfStore(pluginVersion: string) {
  try {
    return isDeprecatedPluginVersion(parse(pluginVersion), CHANNEL_SELF_STORE_MIN_V5, CHANNEL_SELF_STORE_MIN_V6, CHANNEL_SELF_STORE_MIN_V7, CHANNEL_SELF_STORE_MIN_V8)
  }
  catch {
    return true
  }
}

/**
 * True only for the up-to-date /updates response.
 * Device overrides, rollouts, and a newer channel version still open Postgres.
 * Cache TTL is not refreshed on hit, so a channel change shows up within 60s.
 */
export function canServeUpToDateFromCache(
  body: Pick<AppInfos, 'app_id' | 'device_id' | 'platform' | 'version_name' | 'version_build' | 'plugin_version'>,
  payload: UpdateReadCachePayload,
  hasChannelSelfStore: boolean,
): boolean {
  if (!body.app_id || !body.device_id || !body.platform || !body.version_name || !body.version_build)
    return false
  if (body.version_build === 'unknown')
    return false
  if (!tryParse(fixSemver(body.version_build)))
    return false
  if (hasChannelSelfStore && usesLegacyChannelSelfStore(body.plugin_version || '0.0.0'))
    return false
  try {
    if (parse(body.plugin_version || '0.0.0').major === 4)
      return false
  }
  catch {
    return false
  }
  return payload.versionName === body.version_name
}
