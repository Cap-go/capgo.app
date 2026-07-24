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
import { closeClient, getAppOwnerPostgres, getAppVersionPostgres, getDrizzleClient, getEffectiveDeviceChannelNamePostgres, getPgClient } from '../utils/pg.ts'
import { makeDevice, parsePluginBody } from '../utils/plugin_parser.ts'
import { createStatsMau, createStatsVersion, onPremStats, sendStatsAndDevice } from '../utils/plugin_stats.ts'
import { statsRequestSchema } from '../utils/plugin_validation.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { backgroundTask, INVALID_STRING_APP_ID, isLimited, MISSING_STRING_APP_ID, reverseDomainRegex } from '../utils/utils.ts'

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

async function post(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: AppStats, appStatus?: AppStatusResult): Promise<PostResult> {
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
  const appOwner = await getAppOwnerPostgres(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>, planActions)
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
    await sendStatsAndDevice(c, device, statsActions, action.endsWith('_fail'))
    return { success: true }
  }

  let effectiveStatsChannelPromise: ReturnType<typeof getEffectiveDeviceChannelNamePostgres> | undefined
  const getEffectiveStatsChannel = () => {
    effectiveStatsChannelPromise ??= getEffectiveDeviceChannelNamePostgres(c, app_id, device.device_id, normalizeStatsChannelName(device.default_channel), device.platform, appOwner.channel_device_count > 0, drizzleClient as ReturnType<typeof getDrizzleClient>)
    return effectiveStatsChannelPromise
  }

  // Extract version from composite format if present (e.g., "1.2.3:main.js" -> "1.2.3")
  // Composite format is used for file-specific failure stats
  const colonIndex = version_name.indexOf(':')
  const versionOnly = colonIndex > 0 ? version_name.substring(0, colonIndex) : version_name

  let allowedDeleted = false
  if (versionOnly === 'builtin' || versionOnly === 'unknown') {
    allowedDeleted = true
  }
  const appVersion = await getAppVersionPostgres(c, app_id, versionOnly, allowedDeleted, drizzleClient as ReturnType<typeof getDrizzleClient>)
  if (!appVersion) {
    return { success: false, error: 'version_not_found', message: 'Version not found', moreInfo: { app_id, version_name } }
  }
  // device.version = appVersion.id
  if (action === 'set' && !device.is_emulator && device.is_prod) {
    // Use versionOnly from the request body and resolve channel overrides only when configured.
    await createStatsVersion(c, versionOnly, app_id, 'install', await getEffectiveStatsChannel())
    if (old_version_name) {
      const oldVersion = await getAppVersionPostgres(c, app_id, old_version_name, undefined, drizzleClient as ReturnType<typeof getDrizzleClient>)
      if (oldVersion && oldVersion.id !== appVersion.id) {
        await createStatsVersion(c, old_version_name, app_id, 'uninstall', await getEffectiveStatsChannel())
        statsActions.push({ action: 'uninstall', versionName: old_version_name ?? 'unknown' })
      }
    }
  }
  else if (action.endsWith('_fail') && shouldRecordAction) {
    if (!device.is_emulator && device.is_prod) {
      // Keep version_usage fail and install cohorts aligned for rollout auto-pause.
      await createStatsVersion(c, versionOnly, app_id, 'fail', await getEffectiveStatsChannel())
      cloudlog({ requestId: c.get('requestId'), message: 'FAIL!' })
      // Daily fail ratio emails are now sent via cron job that checks aggregate stats
      // instead of per-device notifications. See process_daily_fail_ratio_email.
    }
  }
  if (shouldRecordAction) {
    statsActions.push({ action: action as Database['public']['Enums']['stats_action'], metadata })
  }

  // Don't update device record on failure actions - the version_name in the request
  // is the failed version, not the actual running version on the device
  await backgroundTask(c, createStatsMau(c, device.device_id, app_id, appOwner.owner_org, device.platform, device.version_build))
  await sendStatsAndDevice(c, device, statsActions, action.endsWith('_fail'))
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
  // When clients send a custom_id, the app-level allow flag should take effect
  // immediately. Use a read-write (primary) connection in that case to avoid
  // replica staleness.
  const hasCustomId = events.some((event) => {
    if (!event || typeof event !== 'object')
      return false
    const v = (event as AppStats).custom_id
    return typeof v === 'string' && v.trim() !== ''
  })

  const pgClient = getPgClient(c, !hasCustomId)
  const drizzleClient = getDrizzleClient(pgClient!, { logger: false })

  try {
    // For single event, process directly and let errors propagate for proper status codes
    if (!isBatch) {
      const bodyParsed = parsePluginBody<AppStats>(c, events[0], statsRequestSchema)
      const result = await post(c, drizzleClient, bodyParsed, appStatus)
      if (result.response) {
        return result.response
      }
      if (result.isOnprem) {
        return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
      }
      if (result.success) {
        return c.json(BRES)
      }
      if (result.error === 'need_plan_upgrade') {
        return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
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
        const result = await post(c, drizzleClient, bodyParsed, eventAppStatus)
        if (result.response) {
          return result.response
        }

        if (result.isOnprem) {
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
          return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
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
  finally {
    if (pgClient)
      await closeClient(c, pgClient)
  }
})

app.get('/', (c) => {
  return c.json(BRES)
})
