import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { backgroundTask, isStripeConfigured } from './utils.ts'

const APP_STATUS_CACHE_PATH = '/.app-status-v3'
const APP_STATUS_CACHE_TTL_SECONDS = 60

export type AppStatus = 'cloud' | 'onprem' | 'cancelled'
interface AppStatusCachePayload { status: AppStatus, allow_device_custom_id: boolean, block_provider_infra_requests: boolean }
export interface AppStatusResult { status: AppStatus | null, allow_device_custom_id: boolean, block_provider_infra_requests: boolean, cacheHit: boolean }

function buildAppStatusRequest(c: Context, appId: string) {
  const helper = new CacheHelper(c)
  // Do not check helper.available synchronously — CacheHelper resolves the
  // Cache API asynchronously. matchJson/putJson/delete await ensureCache().
  return {
    helper,
    request: helper.buildRequest(APP_STATUS_CACHE_PATH, { app_id: appId }),
  }
}

export async function getAppStatus(c: Context, appId: string): Promise<AppStatusResult> {
  const cacheEntry = buildAppStatusRequest(c, appId)
  const payload = await cacheEntry.helper.matchJson<AppStatusCachePayload>(cacheEntry.request)
  if (!payload)
    return { status: null, allow_device_custom_id: true, block_provider_infra_requests: false, cacheHit: false }
  const blockProviderInfraRequests = payload.block_provider_infra_requests ?? false
  if (payload.status === 'cancelled' && !isStripeConfigured(c))
    return { status: 'cloud', allow_device_custom_id: payload.allow_device_custom_id, block_provider_infra_requests: blockProviderInfraRequests, cacheHit: true }
  return { status: payload.status, allow_device_custom_id: payload.allow_device_custom_id, block_provider_infra_requests: blockProviderInfraRequests, cacheHit: true }
}

export function setAppStatus(c: Context, appId: string, status: AppStatus, allowDeviceCustomId: boolean, blockProviderInfraRequests = false) {
  return backgroundTask(c, (async () => {
    const cacheEntry = buildAppStatusRequest(c, appId)
    const payload: AppStatusCachePayload = {
      status,
      allow_device_custom_id: allowDeviceCustomId,
      block_provider_infra_requests: blockProviderInfraRequests,
    }
    await cacheEntry.helper.putJson(cacheEntry.request, payload, APP_STATUS_CACHE_TTL_SECONDS)
  })())
}

export async function deleteAppStatus(c: Context, appId: string) {
  const cacheEntry = buildAppStatusRequest(c, appId)
  await cacheEntry.helper.delete(cacheEntry.request)
}
