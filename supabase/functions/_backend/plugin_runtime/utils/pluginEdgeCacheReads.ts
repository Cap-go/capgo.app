import type { Context } from 'hono'
import type { ChannelLookupResult, CompatibleChannelRow, getDrizzleClient, PlanAction } from './pg.ts'
import { isLazyPgConnectError, logPgError, queryAppOwnerPostgres, queryAppVersionPostgres, queryChannelByNamePg, queryCompatibleChannelsPg } from './pg.ts'
import { isReadOnlyPgConnectionRetryError } from './pg_errors.ts'
import { getCachedAppOwner, getCachedAppVersion, getCachedChannelLookup } from './updatesEdgeCache.ts'

/**
 * Edge-cached versions of the app-level reads shared by /updates, /stats and
 * /channel_self. Each one is only called once `shouldUseUpdatesEdgeCache`
 * sampled the request in, and mirrors the uncached helper it replaces:
 * - a database error is logged and answered like the uncached helper (null /
 *   empty list) but never cached;
 * - a lazy client connect failure is rethrown: without the edge cache the
 *   request fails at connect time, and it must not be classified as a missing
 *   app (on-prem) or a missing bundle/channel.
 */

type DrizzleClient = ReturnType<typeof getDrizzleClient>

function rethrowConnectError(error: unknown) {
  if (isLazyPgConnectError(error))
    throw error
}

function rethrowReadOnlyPgConnectionError(error: unknown) {
  if (isReadOnlyPgConnectionRetryError(error))
    throw error
}

/** App owner + plan for these plan actions (cache key: the actions list). */
export async function getAppOwnerWithEdgeCache(
  c: Context,
  appId: string,
  drizzleClient: DrizzleClient,
  actions: PlanAction[],
) {
  try {
    return await getCachedAppOwner(c, appId, actions.join(','), () => queryAppOwnerPostgres(c, appId, drizzleClient, actions, { includeTrialAt: true }))
  }
  catch (error: unknown) {
    rethrowConnectError(error)
    rethrowReadOnlyPgConnectionError(error)
    logPgError(c, 'getAppOwnerPostgres', error, { appId, planActions: actions })
    return { value: null, hit: false }
  }
}

/** Bundle by name, deleted bundles included (getAppVersionPostgres with allowedDeleted undefined). */
export async function getAppVersionWithEdgeCache(
  c: Context,
  appId: string,
  versionName: string,
  drizzleClient: DrizzleClient,
) {
  try {
    const result = await getCachedAppVersion(c, appId, versionName, () => queryAppVersionPostgres(appId, versionName, undefined, drizzleClient))
    return result.value
  }
  catch (error: unknown) {
    rethrowConnectError(error)
    logPgError(c, 'getAppVersionPostgres', error)
    return null
  }
}

/** getChannelByNamePg through the edge cache. */
export async function getChannelByNameWithEdgeCache(
  c: Context,
  appId: string,
  channelName: string,
  drizzleClient: DrizzleClient,
): Promise<ChannelLookupResult | null> {
  try {
    const result = await getCachedChannelLookup(c, appId, 'by_name', { name: channelName }, () => queryChannelByNamePg(appId, channelName, drizzleClient))
    return result.value
  }
  catch (error: unknown) {
    rethrowConnectError(error)
    logPgError(c, 'getChannelByNamePg', error)
    return null
  }
}

/** getCompatibleChannelsPg through the edge cache. */
export async function getCompatibleChannelsWithEdgeCache(
  c: Context,
  appId: string,
  platform: 'ios' | 'android' | 'electron',
  isEmulator: boolean,
  isProd: boolean,
  drizzleClient: DrizzleClient,
): Promise<CompatibleChannelRow[]> {
  try {
    const result = await getCachedChannelLookup(c, appId, 'compatible', {
      platform,
      emulator: isEmulator ? '1' : '0',
      prod: isProd ? '1' : '0',
    }, () => queryCompatibleChannelsPg(appId, platform, isEmulator, isProd, drizzleClient))
    return result.value ?? []
  }
  catch (error: unknown) {
    rethrowConnectError(error)
    logPgError(c, 'getCompatibleChannelsPg', error)
    return []
  }
}
