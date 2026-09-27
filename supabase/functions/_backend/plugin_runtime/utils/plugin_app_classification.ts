import type { Context } from 'hono'
import type { AppStatusResult } from './appStatus.ts'
import type { AppOwnerPostgresResult, PlanAction } from './pg.ts'
import type { DeviceWithoutCreatedAt, StatsMetadata } from './types.ts'
import { getAppStatus, setAppStatus } from './appStatus.ts'
import { lookupAppOwnerPostgres } from './pg.ts'
import { onPremStats } from './plugin_stats.ts'
import { getOnPremiseRetryAfterSeconds } from './rateLimitInfo.ts'

export function pluginAppLookupUnavailableResponse(c: Context) {
  return c.json({
    error: 'upstream_unavailable',
    message: 'App lookup temporarily unavailable',
  }, 503)
}

export async function markPluginAppOnprem(
  c: Context,
  appId: string,
  blockProviderInfraRequests: boolean,
  cachedAppStatus?: AppStatusResult,
) {
  const existing = cachedAppStatus ?? await getAppStatus(c, appId)
  const retryAfterSeconds = getOnPremiseRetryAfterSeconds(c)
  const preservedReset = typeof existing.onprem_retry_reset_at === 'number'
    && existing.onprem_retry_reset_at > Date.now()
    ? existing.onprem_retry_reset_at
    : Date.now() + retryAfterSeconds * 1000
  await setAppStatus(c, appId, 'onprem', true, blockProviderInfraRequests, preservedReset)
  return preservedReset
}

export async function respondPluginExternalAppOnprem(
  c: Context,
  appId: string,
  action: string,
  device: DeviceWithoutCreatedAt,
  metadata: StatsMetadata | undefined,
  cachedAppStatus: AppStatusResult,
) {
  const resetAt = await markPluginAppOnprem(
    c,
    appId,
    cachedAppStatus.block_provider_infra_requests,
    cachedAppStatus,
  )
  return onPremStats(c, appId, action, device, metadata, resetAt)
}

export async function tryHealCachedOnpremAppOwner(
  c: Context,
  appId: string,
  drizzleClient: Parameters<typeof lookupAppOwnerPostgres>[2],
  planActions: PlanAction[],
  cachedAppStatus: AppStatusResult,
): Promise<
  | { kind: 'healed', owner: AppOwnerPostgresResult }
  | { kind: 'upstream' }
  | { kind: 'external_onprem', resetAt: number }
  | { kind: 'cancelled', owner: AppOwnerPostgresResult }
  | { kind: 'unchanged' }
> {
  if (cachedAppStatus.status !== 'onprem')
    return { kind: 'unchanged' }

  const lookup = await lookupAppOwnerPostgres(c, appId, drizzleClient, planActions)
  if (lookup.status === 'error')
    return { kind: 'upstream' }
  if (lookup.status === 'found' && lookup.owner.plan_valid) {
    await setAppStatus(
      c,
      appId,
      'cloud',
      lookup.owner.allow_device_custom_id,
      lookup.owner.block_provider_infra_requests,
    )
    return { kind: 'healed', owner: lookup.owner }
  }
  if (lookup.status === 'found' && !lookup.owner.plan_valid) {
    await setAppStatus(
      c,
      appId,
      'cancelled',
      lookup.owner.allow_device_custom_id,
      lookup.owner.block_provider_infra_requests,
    )
    return { kind: 'cancelled', owner: lookup.owner }
  }

  const resetAt = typeof cachedAppStatus.onprem_retry_reset_at === 'number'
    && cachedAppStatus.onprem_retry_reset_at > Date.now()
    ? cachedAppStatus.onprem_retry_reset_at
    : await markPluginAppOnprem(c, appId, cachedAppStatus.block_provider_infra_requests, cachedAppStatus)
  return { kind: 'external_onprem', resetAt }
}
