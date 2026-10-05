import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { Database } from '../utils/supabase.types.ts'
import type { AppStats, StatsActions } from '../utils/types.ts'
import { greaterOrEqual, parse, tryParse } from '@std/semver'
import { Hono } from 'hono/tiny'
import { getAppStatus, setAppStatus } from '../utils/appStatus.ts'
import { BRES, simpleError, simpleError200, simpleRateLimit } from '../utils/hono.ts'
import { invalidIpInfo } from '../utils/invalids_ip.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendNotifOrgCached } from '../utils/notifications.ts'
import { closeClient, createLazyPgClient, getAppOwnerPostgres, getAppVersionPostgres, getDrizzleClient, getEffectiveDeviceChannelNamePostgres, getLazyPgQueryCount, getPgClient } from '../utils/pg.ts'
import { makeDevice, parsePluginBody } from '../utils/plugin_parser.ts'
import { createStatsMau, createStatsVersion, onPremStats, sendStatsAndDevice } from '../utils/plugin_stats.ts'
import { statsRequestSchema } from '../utils/plugin_validation.ts'
import { getAppOwnerWithEdgeCache, getAppVersionWithEdgeCache } from '../utils/pluginEdgeCacheReads.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { onPremiseAppResponse } from '../utils/rateLimitInfo.ts'
import { shouldUseUpdatesEdgeCache } from '../utils/updatesEdgeCache.ts'
import { backgroundTask, INVALID_STRING_APP_ID, isInternalVersionName, isLimited, MISSING_STRING_APP_ID, reverseDomainRegex } from '../utils/utils.ts'
import { isRunningVersionAction } from './stats_actions.ts'

const PLAN_ERROR = 'Cannot send stats, upgrade plan to continue to update'
const DOWNLOAD_FAIL_FIXED_PLUGIN_VERSION = parse('7.17.0')
const DOWNLOAD_FAIL_FIXED_PLUGIN_VERSION_V6 = parse('6.14.25')

type AppStatusResult = Awaited<ReturnType<typeof getAppStatus>>

async function blockProviderInfrastructure(c: Context, shouldBlockProviderInfrastructure = true) {
  if (!shouldBlockProviderInfrastructure)
    return null

  const requestIp = getClientIP(c)
  if (requestIp === 'unknown')
    return null

  const providerInfo = await invalidIpInfo(requestIp, c)
  if (!providerInfo.blocked)
    return null

  cloudlog({
    requestId: c.get('requestId'),
    message: 'Blocking /stats request from provider infrastructure IP',
    ip: requestIp,
    provider: providerInfo.provider,
  })
  return c.json({ error: 'provider_infrastructure_request_blocked', message: 'Provider infrastructure requests are blocked' }, 429)
}

export interface BatchStatsResult {
  status: 'ok' | 'error'
  error?: string
  message?: string
  index?: number
  moreInfo?: Record<string, unknown>
}

interface PostResult {
  success: boolean
  response?: Response
  error?: string
  message?: string
  isOnprem?: boolean
  moreInfo?: Record<string, unknown>
}

function normalizeStatsChannelName(channelName: string | null | undefined): string | null {
  const trimmed = channelName?.trim()
  return trimmed || null
}

function shouldRecordStatsAction(action: string, pluginVersion: string) {
  if (action !== 'download_fail')
    return true

  // Older updater plugins reported download_fail when there was no update to download.
  if (typeof pluginVersion !== 'string')
    return false

  const parsedPluginVersion = tryParse(pluginVersion)
  if (!parsedPluginVersion)
    return false

  return greaterOrEqual(parsedPluginVersion, DOWNLOAD_FAIL_FIXED_PLUGIN_VERSION)
    || (pluginVersion.startsWith('6.') && greaterOrEqual(parsedPluginVersion, DOWNLOAD_FAIL_FIXED_PLUGIN_VERSION_V6))
}

async function post(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: AppStats, appStatus?: AppStatusResult, edgeCache = false): Promise<PostResult> {
  const { app_id, action, version_name, old_version_name, plugin_version, metadata } = body

  const planActions: Array<'mau' | 'bandwidth'> = ['mau', 'bandwidth']
  const cachedAppStatus = appStatus ?? await getAppStatus(c, app_id)
  const cachedStatus = cachedAppStatus.status
  if (cachedStatus === 'onprem') {
    const device = makeDevice(body, cachedAppStatus.allow_device_custom_id)
    await onPremStats(c, app_id, action, device, metadata)
    return { success: true, isOnprem: true }
  }

  if (cachedStatus === 'cancelled') {
    const allowDeviceCustomId = cachedAppStatus.allow_device_custom_id
    const device = makeDevice(body, allowDeviceCustomId)
    const statsActions: StatsActions[] = [{ action: 'needPlanUpgrade' }]
    // Keep behavior backward compatible (default allow=true), but allow owners to
    // disable custom_id persistence from unauthenticated /stats traffic.
    if (allowDeviceCustomId === false && typeof body.custom_id === 'string' && body.custom_id.trim() !== '') {
      statsActions.push({ action: 'customIdBlocked' })
    }
    await sendStatsAndDevice(c, device, statsActions)
    return { success: false, error: 'need_plan_upgrade', message: PLAN_ERROR }
  }
  // Same plan actions as /updates, so both endpoints share the cached owner entry.
  const appOwner = edgeCache
    ? (await getAppOwnerWithEdgeCache(c, app_id, drizzleClient, planActions)).value
    : await getAppOwnerPostgres(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>, planActions)
  const allowDeviceCustomId = appOwner?.allow_device_custom_id
  const device = makeDevice(body, allowDeviceCustomId)
  const blockProviderInfraRequests = appOwner?.block_provider_infra_requests ?? cachedAppStatus.block_provider_infra_requests
  const blocked = await blockProviderInfrastructure(c, blockProviderInfraRequests)
  if (blocked)
    return { success: false, response: blocked }

  if (!appOwner) {
    await setAppStatus(c, app_id, 'onprem', true, cachedAppStatus.block_provider_infra_requests)
    await onPremStats(c, app_id, action, device, metadata)
    return { success: true, isOnprem: true }
  }
  if (!appOwner.plan_valid) {
    await setAppStatus(c, app_id, 'cancelled', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, upgrade plan to continue to update', id: app_id })
    const upgradeActions: StatsActions[] = [{ action: 'needPlanUpgrade' }]
    if (allowDeviceCustomId === false && typeof body.custom_id === 'string' && body.custom_id.trim() !== '') {
      upgradeActions.push({ action: 'customIdBlocked' })
    }
    await sendStatsAndDevice(c, device, upgradeActions)
    // Send weekly notification about missing payment (not configurable - payment related)
    backgroundTask(c, sendNotifOrgCached(c, 'org:missing_payment', {
      app_id,
      device_id: body.device_id,
      app_id_url: app_id,
    }, appOwner.owner_org, app_id, '0 0 * * 1', appOwner.orgs.management_email, drizzleClient)) // Weekly on Monday
    return { success: false, error: 'need_plan_upgrade', message: 'Cannot update, upgrade plan to continue to update' }
  }
  await setAppStatus(c, app_id, 'cloud', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
  const statsActions: StatsActions[] = []
  if (allowDeviceCustomId === false && typeof body.custom_id === 'string' && body.custom_id.trim() !== '') {
    statsActions.push({ action: 'customIdBlocked' })
  }
  const shouldRecordAction = shouldRecordStatsAction(action, plugin_version)

  if (!shouldRecordAction) {
    // Legacy plugins can report download_fail for a non-existent target version
    // when there was no update to download, so skip version validation too.
    await backgroundTask(c, createStatsMau(c, device.device_id, app_id, appOwner.owner_org, device.platform, device.version_build))
    await sendStatsAndDevice(c, device, statsActions, !isRunningVersionAction(action))
    return { success: true }
  }

  // Client body.channel is ignored for version_usage; only defaultChannel and
  // server-side overrides (channel_devices / channel_self store) may attribute installs.
  let effectiveStatsChannelPromise: ReturnType<typeof getEffectiveDeviceChannelNamePostgres> | undefined
  const getEffectiveStatsChannel = () => {
    effectiveStatsChannelPromise ??= getEffectiveDeviceChannelNamePostgres(c, app_id, device.device_id, normalizeStatsChannelName(device.default_channel), device.platform, appOwner.channel_device_count > 0, drizzleClient as ReturnType<typeof getDrizzleClient>, { edgeCache })
    return effectiveStatsChannelPromise
  }

  let failureChannel: Awaited<ReturnType<typeof getEffectiveDeviceChannelNamePostgres>> = null
  const getVersionByName = (versionName: string) => edgeCache
    ? getAppVersionWithEdgeCache(c, app_id, versionName, drizzleClient)
    : getAppVersionPostgres(c, app_id, versionName, undefined, drizzleClient as ReturnType<typeof getDrizzleClient>)

  // Extract version from composite format if present (e.g., "1.2.3:main.js" -> "1.2.3")
  // Composite format is used for file-specific failure stats
  const colonIndex = version_name.indexOf(':')
  const versionOnly = colonIndex > 0 ? version_name.substring(0, colonIndex) : version_name

  // Devices keep running bundles after they are deleted, and builtin is reported as
  // the native version_build (see plugin_parser), which usually has no bundle row.
  // Resolve deleted and live bundles alike, and still record the log, device and MAU
  // when no bundle matches; only version_usage needs a known bundle.
  const appVersion = isInternalVersionName(versionOnly)
    ? null
    : await getVersionByName(versionOnly)
  if (!appVersion) {
    cloudlog({ requestId: c.get('requestId'), message: 'Stats version not found, skipping version usage', app_id, version_name, action })
  }
  else if (action === 'set' && !device.is_emulator && device.is_prod) {
    // Use versionOnly from the request body and resolve channel overrides only when configured.
    await createStatsVersion(c, versionOnly, app_id, 'install', await getEffectiveStatsChannel())
    if (old_version_name) {
      const oldVersion = await getVersionByName(old_version_name)
      if (oldVersion && oldVersion.id !== appVersion.id) {
        await createStatsVersion(c, old_version_name, app_id, 'uninstall', await getEffectiveStatsChannel())
        statsActions.push({ action: 'uninstall', versionName: old_version_name ?? 'unknown' })
      }
    }
  }
  // File-level failures ("1.2.3:main.js") are followed by a bundle-level failure for
  // the same update; count only the latter so one failed update is one version fail.
  else if (action.endsWith('_fail') && shouldRecordAction && colonIndex <= 0) {
    if (!device.is_emulator && device.is_prod) {
      // Keep version_usage fail and install cohorts aligned for rollout auto-pause.
      failureChannel = await getEffectiveStatsChannel()
      await createStatsVersion(c, versionOnly, app_id, 'fail', failureChannel)
      cloudlog({ requestId: c.get('requestId'), message: 'FAIL!' })
      // Daily fail ratio emails are now sent via cron job that checks aggregate stats
      // instead of per-device notifications. See process_daily_fail_ratio_email.
    }
  }
  if (shouldRecordAction) {
    // The failure log carries the same channel as its version_usage fail row so
    // the live release view can break failure reasons down per channel.
    statsActions.push({ action: action as Database['public']['Enums']['stats_action'], metadata, channel: failureChannel })
  }

  await backgroundTask(c, createStatsMau(c, device.device_id, app_id, appOwner.owner_org, device.platform, device.version_build))
  await sendStatsAndDevice(c, device, statsActions, !isRunningVersionAction(action))
  return { success: true }
}

// Plugin endpoints are intentionally public device endpoints: their responses are
// considered public data, so we do not require Capgo JWT/API-key auth or add
// checks beyond Supabase/platform protections. Endpoint-specific validation, plan
// checks, and rate limits still apply.
export const app = new Hono<MiddlewareKeyVariables>()

async function parseBodyRaw(c: Context): Promise<AppStats | AppStats[]> {
  try {
    const body = await c.req.json<AppStats | AppStats[]>()
    // Normalize device_id to lowercase for both single and array
    // Guard against non-object items to allow per-item validation errors
    if (Array.isArray(body)) {
      for (const item of body) {
        if (item && typeof item === 'object' && typeof (item as AppStats).device_id === 'string') {
          (item as AppStats).device_id = (item as AppStats).device_id.toLowerCase()
        }
      }
    }
    else if (body && typeof body === 'object' && typeof (body as AppStats).device_id === 'string') {
      (body as AppStats).device_id = (body as AppStats).device_id.toLowerCase()
    }
    return body
  }
  catch (e) {
    throw simpleError('invalid_json_parse_body', 'Invalid JSON body', { e })
  }
}

app.post('/', async (c) => {
  const body = await parseBodyRaw(c)
  const isBatch = Array.isArray(body)
  const events = isBatch ? body : [body]
  const requestIp = getClientIP(c)

  // Handle empty batch early - no need to acquire DB connection
  if (isBatch && events.length === 0) {
    return c.json({ status: 'ok', results: [] })
  }

  // Early validation of first event's app_id before using it in checks
  // Use optional chaining to safely handle null/primitive items
  const firstEvent = events[0]
  const firstAppId = (firstEvent as AppStats | null | undefined)?.app_id
  if (!firstAppId || typeof firstAppId !== 'string') {
    throw simpleError('invalid_app_id', MISSING_STRING_APP_ID)
  }
  if (!reverseDomainRegex.test(firstAppId)) {
    throw simpleError('invalid_app_id', INVALID_STRING_APP_ID)
  }

  // Validate all events in batch have valid app_ids and they all match
  if (isBatch) {
    for (let i = 1; i < events.length; i++) {
      const currentAppId = (events[i] as AppStats | null | undefined)?.app_id

      // Ensure each event has a valid string app_id in reverse-domain format
      if (!currentAppId || typeof currentAppId !== 'string') {
        return simpleError200(c, 'invalid_app_id', MISSING_STRING_APP_ID)
      }
      if (!reverseDomainRegex.test(currentAppId)) {
        return simpleError200(c, 'invalid_app_id', INVALID_STRING_APP_ID)
      }

      if (currentAppId !== firstAppId) {
        return simpleError200(c, 'mixed_app_ids', 'All events in a batch must have the same app_id')
      }
    }
  }

  // Rate limit check on app_id (all events share the same app)
  if (isLimited(c, firstAppId)) {
    return simpleRateLimit({ app_id: firstAppId })
  }

  const appStatus = await getAppStatus(c, firstAppId)
  const appStatusByAppId = new Map<string, AppStatusResult>([[firstAppId, appStatus]])
  if (appStatus.cacheHit && requestIp !== 'unknown') {
    const blocked = await blockProviderInfrastructure(c, appStatus.block_provider_infra_requests)
    if (blocked)
      return blocked
  }
  // One decision per request: a batch follows its first event's device. A
  // request without a device id keeps the live path (no per-device bucket).
  const firstDeviceId = (firstEvent as AppStats).device_id
  if (typeof firstDeviceId === 'string' && firstDeviceId !== '' && shouldUseUpdatesEdgeCache(c, firstAppId, firstDeviceId))
    return statsWithEdgeCache(c, events, isBatch, appStatus, appStatusByAppId, requestIp)

  // Plugin hot path must never hit primary. Device custom_id lives in Cloudflare
  // (Analytics Engine), not Postgres — never open primary from /stats for it.
  const pgClient = await getPgClient(c, true)
  const drizzleClient = getDrizzleClient(pgClient!, { logger: false })

  try {
    return await processStatsEvents(c, drizzleClient, events, isBatch, appStatus, appStatusByAppId, requestIp, false)
  }
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
})

/**
 * /stats with the edge cache on (same UPDATES_EDGE_CACHE gate and device
 * sampling as /updates): the client connects on its first query only, so an
 * event answered from cached app-level reads opens no database connection.
 * `X-Updates-Cache` reports hit (zero queries) or miss.
 */
async function statsWithEdgeCache(
  c: Context,
  events: AppStats[],
  isBatch: boolean,
  appStatus: AppStatusResult,
  appStatusByAppId: Map<string, AppStatusResult>,
  requestIp: string,
) {
  const start = performance.now()
  const lazyClient = createLazyPgClient(c, true)
  try {
    const drizzleClient = getDrizzleClient(lazyClient.client, { logger: false })
    const response = await processStatsEvents(c, drizzleClient, events, isBatch, appStatus, appStatusByAppId, requestIp, true)
    const dbQueries = getLazyPgQueryCount(c)
    try {
      response.headers.set('X-Updates-Cache', dbQueries === 0 ? 'hit' : 'miss')
    }
    catch {
      // Immutable response headers: observability only.
    }
    const totalMs = Math.round(performance.now() - start)
    if (totalMs >= 100) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'plugin_path_timing',
        path: 'stats',
        outcome: 'total',
        totalMs,
        dbQueries,
        events: events.length,
        app_id: (events[0] as AppStats | undefined)?.app_id,
      })
    }
    return response
  }
  finally {
    await lazyClient.close()
  }
}

async function processStatsEvents(
  c: Context,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  events: AppStats[],
  isBatch: boolean,
  appStatus: AppStatusResult,
  appStatusByAppId: Map<string, AppStatusResult>,
  requestIp: string,
  edgeCache: boolean,
): Promise<Response> {
  // For single event, process directly and let errors propagate for proper status codes
  if (!isBatch) {
    const bodyParsed = parsePluginBody<AppStats>(c, events[0], statsRequestSchema)
    const result = await post(c, drizzleClient, bodyParsed, appStatus, edgeCache)
    if (result.response) {
      return result.response
    }
    if (result.isOnprem) {
      return onPremiseAppResponse(c)
    }
    if (result.success) {
      return c.json(BRES)
    }
    if (result.error === 'need_plan_upgrade') {
      return onPremiseAppResponse(c)
    }
    return simpleError200(c, result.error!, result.message!, result.moreInfo)
  }

  // For batch, collect results and handle errors per event
  const results: BatchStatsResult[] = []

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    try {
      const bodyParsed = parsePluginBody<AppStats>(c, event, statsRequestSchema)
      let eventAppStatus = appStatusByAppId.get(bodyParsed.app_id)
      if (!eventAppStatus) {
        eventAppStatus = await getAppStatus(c, bodyParsed.app_id)
        appStatusByAppId.set(bodyParsed.app_id, eventAppStatus)
        if (eventAppStatus.cacheHit && requestIp !== 'unknown') {
          const blocked = await blockProviderInfrastructure(c, eventAppStatus.block_provider_infra_requests)
          if (blocked)
            return blocked
        }
      }
      const result = await post(c, drizzleClient, bodyParsed, eventAppStatus, edgeCache)
      if (result.response) {
        return result.response
      }

      if (result.isOnprem) {
        // Keep batch HTTP 200 + per-event results for backward compatibility.
        // Single-event path still returns onPremiseAppResponse (429 + headers).
        results.push({
          status: 'error',
          error: 'on_premise_app',
          message: 'On-premise app detected',
          index: i,
        })
      }
      else if (result.success) {
        results.push({ status: 'ok', index: i })
      }
      else if (result.error === 'need_plan_upgrade') {
        return onPremiseAppResponse(c)
      }
      else {
        results.push({
          status: 'error',
          error: result.error,
          message: result.message,
          index: i,
          moreInfo: result.moreInfo,
        })
      }
    }
    catch (e) {
      const err = e as Error & { cause?: { error?: string } }
      results.push({
        status: 'error',
        error: err?.cause?.error || 'processing_error',
        message: err?.message || 'Error processing event',
        index: i,
      })
    }
  }

  // For batch, return array of results
  return c.json({ status: 'ok', results })
}

app.get('/', (c) => {
  return c.json(BRES)
})
