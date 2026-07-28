import type { Context } from 'hono'
import { CacheHelper } from './cache.ts'
import { backgroundTask, isStripeConfigured } from './utils.ts'

// v4 adds owner routing fields so warm /updates can skip getAppOwnerPostgres (1 RTT).
const APP_STATUS_CACHE_PATH = '/.app-status-v4'
const APP_STATUS_CACHE_TTL_SECONDS = 60

export type AppStatus = 'cloud' | 'onprem' | 'cancelled'

export interface AppOwnerRoutingCache {
  owner_org: string
  plan_valid: boolean
  channel_device_count: number
  manifest_bundle_count: number
  rollout_channel_count: number
  rollout_paused_version_names: string[]
  expose_metadata: boolean
  management_email: string
  org_created_by: string
}

interface AppStatusCachePayload {
  status: AppStatus
  allow_device_custom_id: boolean
  block_provider_infra_requests: boolean
  owner?: AppOwnerRoutingCache
}

export interface AppStatusResult {
  status: AppStatus | null
  allow_device_custom_id: boolean
  block_provider_infra_requests: boolean
  cacheHit: boolean
  owner: AppOwnerRoutingCache | null
}

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
  if (!payload) {
    return {
      status: null,
      allow_device_custom_id: true,
      block_provider_infra_requests: false,
      cacheHit: false,
      owner: null,
    }
  }
  const blockProviderInfraRequests = payload.block_provider_infra_requests ?? false
  if (payload.status === 'cancelled' && !isStripeConfigured(c)) {
    return {
      status: 'cloud',
      allow_device_custom_id: payload.allow_device_custom_id,
      block_provider_infra_requests: blockProviderInfraRequests,
      cacheHit: true,
      owner: payload.owner ?? null,
    }
  }
  return {
    status: payload.status,
    allow_device_custom_id: payload.allow_device_custom_id,
    block_provider_infra_requests: blockProviderInfraRequests,
    cacheHit: true,
    owner: payload.owner ?? null,
  }
}

export function setAppStatus(
  c: Context,
  appId: string,
  status: AppStatus,
  allowDeviceCustomId: boolean,
  blockProviderInfraRequests = false,
  owner?: AppOwnerRoutingCache | null,
) {
  return backgroundTask(c, (async () => {
    const cacheEntry = buildAppStatusRequest(c, appId)
    const payload: AppStatusCachePayload = {
      status,
      allow_device_custom_id: allowDeviceCustomId,
      block_provider_infra_requests: blockProviderInfraRequests,
    }
    if (owner)
      payload.owner = owner
    await cacheEntry.helper.putJson(cacheEntry.request, payload, APP_STATUS_CACHE_TTL_SECONDS)
  })())
}

export async function deleteAppStatus(c: Context, appId: string) {
  const cacheEntry = buildAppStatusRequest(c, appId)
  await cacheEntry.helper.delete(cacheEntry.request)
}

export function toOwnerRoutingCache(appOwner: {
  owner_org: string
  plan_valid: boolean
  channel_device_count: number | null
  manifest_bundle_count: number | null
  rollout_channel_count: number | null
  rollout_paused_version_names: string[] | null
  expose_metadata: boolean
  orgs: { id: string, created_by: string, management_email: string }
}): AppOwnerRoutingCache {
  return {
    owner_org: appOwner.owner_org,
    plan_valid: appOwner.plan_valid,
    channel_device_count: appOwner.channel_device_count ?? 0,
    manifest_bundle_count: appOwner.manifest_bundle_count ?? 0,
    rollout_channel_count: appOwner.rollout_channel_count ?? 0,
    rollout_paused_version_names: appOwner.rollout_paused_version_names ?? [],
    expose_metadata: appOwner.expose_metadata,
    management_email: appOwner.orgs.management_email,
    org_created_by: appOwner.orgs.created_by,
  }
}
