// channel self old function
import type { Context } from 'hono'
import type { StandardSchema } from '../utils/schema_validation.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import type { DeviceLink } from '../utils/plugin_parser.ts'
import type { Database } from '../utils/supabase.types.ts'
import { parse } from '@std/semver'
import { Hono } from 'hono/tiny'
import { getAppStatus, setAppStatus } from '../utils/appStatus.ts'
import { checkChannelSelfIPRateLimit, isChannelSelfRateLimited, recordChannelSelfIPRequest, recordChannelSelfRequest } from '../utils/channelSelfRateLimit.ts'
import { deleteChannelSelfOverride, getChannelSelfOverride, isChannelSelfStoreEnabled, setChannelSelfOverride } from '../utils/channelSelfStore.ts'
import { BRES, parseBody, quickError, simpleError200, simpleRateLimit } from '../utils/hono.ts'
import { invalidIpInfo } from '../utils/invalids_ip.ts'
import { cloudlog } from '../utils/logging.ts'
import { sendNotifOrgCached } from '../utils/notifications.ts'
import { sendNotifToOrgMembersCached } from '../utils/org_email_notifications.ts'
import { closeClient, deleteChannelDevicePg, getAppByIdPg, getAppOwnerPostgres, getChannelByIdPg, getChannelByNamePg, getChannelDeviceOverridePg, getChannelsPg, getCompatibleChannelsPg, getDrizzleClient, getMainChannelsPg, getPgClient, setReplicationLagHeader, upsertChannelDevicePg } from '../utils/pg.ts'
import { convertQueryToBody, makeDevice, parsePluginBody } from '../utils/plugin_parser.ts'
import { sendStatsAndDevice } from '../utils/plugin_stats.ts'
import { channelSelfGetRequestSchema, channelSelfRequestSchema, isDevicePlatform } from '../utils/plugin_validation.ts'
import { getClientIP } from '../utils/rate_limit.ts'
import { buildRateLimitInfo } from '../utils/rateLimitInfo.ts'
import { logSkippedSupabaseWrite, shouldSkipChannelSelfPostgresFallback } from '../utils/supabase_write_guard.ts'
import { backgroundTask, isDeprecatedPluginVersion, isLimited } from '../utils/utils.ts'

// Minimum versions for local channel storage behavior
const CHANNEL_SELF_MIN_V5 = '5.34.0'
const CHANNEL_SELF_MIN_V6 = '6.34.0'
const CHANNEL_SELF_MIN_V7 = '7.34.0'
const CHANNEL_SELF_MIN_V8 = '8.0.0'

const PLAN_MAU_ACTIONS: Array<'mau'> = ['mau']

async function blockProviderInfrastructure(c: Context, route: string, shouldBlockProviderInfrastructure: boolean) {
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
    message: 'Blocking /channel_self request from provider infrastructure IP',
    ip: requestIp,
    provider: providerInfo.provider,
    route,
  })
  return quickError(429, 'provider_infrastructure_request_blocked', 'Provider infrastructure requests are blocked')
}

async function assertChannelSelfIPRateLimit(c: Context, appId: string) {
  // IP rate limit: per-minute cap (default 1000/min via RATE_LIMIT_CHANNEL_SELF_IP) to mitigate device_id spoofing
  const ipRateLimitStatus = await checkChannelSelfIPRateLimit(c, appId, 'Channel self IP rate limited')
  if (ipRateLimitStatus.limited) {
    return simpleRateLimit({ reason: 'ip_rate_limit_exceeded', app_id: appId, ...buildRateLimitInfo(ipRateLimitStatus.resetAt) })
  }
}

async function recordChannelSelfIPRateLimitSafely(c: Context, appId: string) {
  try {
    await recordChannelSelfIPRequest(c, appId)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'Failed to record channel_self IP rate limit',
      app_id: appId,
      error,
    })
  }
}

async function recordChannelSelfRequestSafely(
  c: Context,
  appId: string,
  deviceId: string,
  operation: 'set' | 'get' | 'delete' | 'list',
  channel?: string,
) {
  // Intentionally awaited: in Cloudflare Workers local testing we disable
  // background tasks (`CAPGO_PREVENT_BACKGROUND_FUNCTIONS=true`) and
  // `waitUntil` is not guaranteed in all runtimes. Awaiting ensures the
  // Cache-based limiter is updated before a rapid follow-up request.
  try {
    await recordChannelSelfRequest(c, appId, deviceId, operation, channel)
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: `Failed to record channel_self ${operation} rate limit`,
      app_id: appId,
      device_id: deviceId,
      channel,
      error,
    })
  }
}

type AppOwnerResult = Awaited<ReturnType<typeof getAppOwnerPostgres>>
type AppStatusResult = Awaited<ReturnType<typeof getAppStatus>>
type ChannelSelfOverrideResult = Awaited<ReturnType<typeof getChannelDeviceOverridePg>>
type ChannelSelfDeviceOperation = 'set' | 'get' | 'delete'

async function assertChannelSelfCachedStatus(
  c: Context,
  cachedAppStatus: AppStatusResult,
  appId: string,
  device: ReturnType<typeof makeDevice>,
  operationLabel: string,
) {
  if (cachedAppStatus.status === 'onprem') {
    cloudlog({ requestId: c.get('requestId'), message: `Channel_self cache hit (${operationLabel}), app marked onprem`, app_id: appId })
    return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
  }
  if (cachedAppStatus.status === 'cancelled') {
    await sendStatsAndDevice(c, device, [{ action: 'needPlanUpgrade' }])
    return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
  }
}

async function assertChannelSelfAppOwnerPlanValid(
  c: Context,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  appOwner: AppOwnerResult,
  appId: string,
  device: ReturnType<typeof makeDevice>,
  operationLabel: string,
  cachedBlockProviderInfraRequests: boolean,
  deviceId?: string,
): Promise<{ response: Response } | { appOwner: NonNullable<AppOwnerResult> }> {
  if (!appOwner) {
    cloudlog({ requestId: c.get('requestId'), message: `On-premise app detected in channel_self ${operationLabel}, returning 429`, app_id: appId })
    await setAppStatus(c, appId, 'onprem', true, cachedBlockProviderInfraRequests)
    return { response: c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429) }
  }

  if (!appOwner.plan_valid) {
    await setAppStatus(c, appId, 'cancelled', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, upgrade plan to continue to update', id: appId })
    await sendStatsAndDevice(c, device, [{ action: 'needPlanUpgrade' }])

    // Send weekly notification about missing payment (not configurable - payment related)
    const payload = deviceId
      ? { app_id: appId, device_id: deviceId, app_id_url: appId }
      : { app_id: appId, app_id_url: appId }
    backgroundTask(c, sendNotifOrgCached(
      c,
      'org:missing_payment',
      payload,
      appOwner.owner_org,
      appId,
      '0 0 * * 1',
      appOwner.orgs.management_email,
      drizzleClient,
    )) // Weekly on Monday

    return { response: c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429) }
  }

  await setAppStatus(c, appId, 'cloud', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
  return { appOwner }
}

function isChannelSelfLocalChannelStorageVersion(c: Context, body: DeviceLink, operationLabel: string) {
  const pluginVersion = body.plugin_version || '0.0.0'
  try {
    const parsed = parse(pluginVersion)
    return !isDeprecatedPluginVersion(parsed, CHANNEL_SELF_MIN_V5, CHANNEL_SELF_MIN_V6, CHANNEL_SELF_MIN_V7, CHANNEL_SELF_MIN_V8)
  }
  catch (error) {
    // If version parsing fails, assume old version
    cloudlog({ requestId: c.get('requestId'), message: `Failed to parse plugin version in ${operationLabel}, assuming old version`, plugin_version: pluginVersion, error })
    return false
  }
}

async function getChannelSelfOverrideForDevice(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  deviceId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<ChannelSelfOverrideResult> {
  if (isChannelSelfStoreEnabled(c)) {
    const storedOverride = await getChannelSelfOverride(c, appId, deviceId)
    if (!storedOverride)
      return null

    const channel = await getChannelByIdPg(c, appId, storedOverride.channel_id.id, drizzleClient)
    if (!channel)
      return null

    return {
      app_id: storedOverride.app_id,
      device_id: storedOverride.device_id,
      channel_id: {
        id: channel.id,
        allow_device_self_set: channel.allow_device_self_set,
        name: channel.name,
      },
    }
  }

  return getChannelDeviceOverridePg(c, appId, deviceId, drizzleClient)
}

async function deleteChannelSelfOverrideForDevice(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  deviceId: string,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
) {
  if (isChannelSelfStoreEnabled(c))
    return deleteChannelSelfOverride(c, appId, deviceId)

  if (shouldSkipChannelSelfPostgresFallback(c)) {
    logSkippedSupabaseWrite(c, 'deleteChannelDevicePg fallback')
    return false
  }

  return deleteChannelDevicePg(c, appId, deviceId, drizzleClient)
}

async function upsertChannelSelfOverrideForDevice(
  c: Context<MiddlewareKeyVariables>,
  appId: string,
  deviceId: string,
  channel: NonNullable<Awaited<ReturnType<typeof getChannelByNamePg>>>,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
) {
  if (isChannelSelfStoreEnabled(c)) {
    return setChannelSelfOverride(c, appId, deviceId, {
      app_id: appId,
      device_id: deviceId,
      channel_id: {
        id: channel.id,
      },
    })
  }

  if (shouldSkipChannelSelfPostgresFallback(c)) {
    logSkippedSupabaseWrite(c, 'upsertChannelDevicePg fallback')
    return false
  }

  return upsertChannelDevicePg(c, {
    device_id: deviceId,
    channel_id: channel.id,
    app_id: appId,
    owner_org: channel.owner_org,
  }, drizzleClient)
}

async function prepareChannelSelfDeviceRequest(
  c: Context,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  body: DeviceLink,
  operationLabel: string,
  cachedAppStatus: AppStatusResult,
): Promise<{ response: Response } | { appOwner: NonNullable<AppOwnerResult>, device: ReturnType<typeof makeDevice> }> {
  const { app_id, device_id } = body
  const cachedLimit = await assertChannelSelfCachedStatus(c, cachedAppStatus, app_id, makeDevice(body, cachedAppStatus.allow_device_custom_id), operationLabel.toLowerCase())
  if (cachedLimit) {
    return { response: cachedLimit }
  }

  const appOwner = await getAppOwnerPostgres(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>, PLAN_MAU_ACTIONS)
  const device = makeDevice(body, appOwner?.allow_device_custom_id)
  const blockProviderInfraRequests = appOwner?.block_provider_infra_requests ?? cachedAppStatus.block_provider_infra_requests
  const blocked = await blockProviderInfrastructure(c, operationLabel, blockProviderInfraRequests)
  if (blocked)
    return { response: blocked }

  const ownerRes = await assertChannelSelfAppOwnerPlanValid(c, drizzleClient, appOwner, app_id, device, operationLabel, blockProviderInfraRequests, device_id)
  if ('response' in ownerRes) {
    return { response: ownerRes.response }
  }

  return { appOwner: ownerRes.appOwner, device }
}
async function post(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: DeviceLink, cachedAppStatus: AppStatusResult): Promise<Response> {
  const { app_id, device_id, channel } = body
  cloudlog({ requestId: c.get('requestId'), message: 'post channel self body', app_id, device_id, channel })

  const requestContext = await prepareChannelSelfDeviceRequest(c, drizzleClient, body, 'POST', cachedAppStatus)
  if ('response' in requestContext) {
    return requestContext.response
  }
  const { appOwner: validatedAppOwner, device } = requestContext

  const isNewVersion = isChannelSelfLocalChannelStorageVersion(c, body, 'POST')
  // Only old versions use server-side channel_self storage.
  const dataChannelOverride = isNewVersion ? null : await getChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)

  if (!channel) {
    return simpleError200(c, 'cannot_override', 'Missing channel')
  }
  if (dataChannelOverride && !dataChannelOverride.channel_id.allow_device_self_set) {
    // Send weekly notification to org about self-assignment rejection
    backgroundTask(c, sendNotifToOrgMembersCached(
      c,
      'device:channel_self_set_rejected',
      'channel_self_rejected',
      {
        channel_name: dataChannelOverride.channel_id.name,
        channel_id: dataChannelOverride.channel_id.id,
        device_id: dataChannelOverride.device_id,
        app_id,
      },
      validatedAppOwner.owner_org,
      `${app_id}`,
      '0 0 * * 0', // Weekly on Sunday at midnight
      drizzleClient,
    ))
    return simpleError200(c, 'cannot_override', 'Cannot change device override current channel don\'t allow it')
  }
  // if channel set channel_override to it
  // get channel by name - Read operation can use v2 flag
  const dataChannel = await getChannelByNamePg(c, app_id, channel, drizzleClient as ReturnType<typeof getDrizzleClient>)

  if (!dataChannel) {
    return simpleError200(c, 'channel_not_found', `Cannot find channel`, { channel, app_id })
  }

  if (!dataChannel.allow_device_self_set) {
    // Send weekly notification to org about self-assignment rejection
    backgroundTask(c, sendNotifToOrgMembersCached(
      c,
      'device:channel_self_set_rejected',
      'channel_self_rejected',
      {
        channel_name: dataChannel.name,
        app_id,
      },
      validatedAppOwner.owner_org,
      `${app_id}`,
      '0 0 * * 0', // Weekly on Sunday at midnight
      drizzleClient,
    ))
    if (dataChannel.public) {
      return simpleError200(
        c,
        'public_channel_self_set_not_allowed',
        'This channel is public and does not allow device self-assignment. Unset the channel and the device will automatically use the public channel.',
        { channel, app_id },
      )
    }
    return simpleError200(c, 'channel_self_set_not_allowed', 'This channel does not allow devices to self associate', { channel, app_id })
  }

  // For vX.34.0+: only validate. Do not read or write server-side channel_self storage.
  if (isNewVersion) {
    // Return validation result only (plugin will store locally)
    await sendStatsAndDevice(c, device, [{ action: 'setChannel' }])
    return c.json({
      status: 'ok',
      allowSet: dataChannel.allow_device_self_set,
    })
  }

  // Old behavior (< v7.34.0): persist the override server-side.
  // Get the main channel - Read operation can use v2 flag
  const mainChannel = await getMainChannelsPg(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>)

  // We DO NOT return if there is no main channel as it's not a critical error
  // We will just set the override as the user requested
  let mainChannelName = null as string | null
  if (mainChannel && mainChannel.length > 0) {
    const devicePlatform = body.platform as Database['public']['Enums']['platform_os']
    const finalChannel = mainChannel.find((channel: { name: string, ios: boolean, android: boolean, electron: boolean }) => channel[devicePlatform])
    mainChannelName = (finalChannel !== undefined) ? finalChannel.name : null
  }

  // const mainChannelName = (!dbMainChannelError && mainChannel) ? mainChannel.name : null
  if (!mainChannel || mainChannel.length === 0)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot find main channel' })

  if (mainChannelName && mainChannelName === channel) {
    // Write operation - use the PG client created by the route handler

    const success = await deleteChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)
    if (!success) {
      return simpleError200(c, 'override_not_allowed', `Cannot remove channel override`)
    }

    cloudlog({ requestId: c.get('requestId'), message: 'main channel set, removing override' })
    await sendStatsAndDevice(c, device, [{ action: 'setChannel' }])
    return c.json(BRES)
  }
  // if dataChannelOverride is same from dataChannel and exist then do nothing
  if (dataChannelOverride && dataChannelOverride.channel_id.id === dataChannel.id) {
    // already set
    cloudlog({ requestId: c.get('requestId'), message: 'channel already set' })
    return c.json(BRES)
  }

  cloudlog({ requestId: c.get('requestId'), message: 'setting channel' })

  // Write operations - use the PG client created by the route handler

  if (dataChannelOverride) {
    const success = await deleteChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)
    if (!success) {
      return simpleError200(c, 'override_not_allowed', `Cannot remove channel override`)
    }
  }
  const success = await upsertChannelSelfOverrideForDevice(c, app_id, device_id, dataChannel, drizzleClient)
  if (!success) {
    return simpleError200(c, 'override_not_allowed', `Cannot do channel override`)
  }

  await sendStatsAndDevice(c, device, [{ action: 'setChannel' }])
  return c.json(BRES)
}

async function put(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: DeviceLink, cachedAppStatus: AppStatusResult): Promise<Response> {
  const { app_id, defaultChannel, device_id } = body
  cloudlog({ requestId: c.get('requestId'), message: 'put channel self body', app_id, device_id, channel: body.channel, defaultChannel })

  const requestContext = await prepareChannelSelfDeviceRequest(c, drizzleClient, body, 'PUT', cachedAppStatus)
  if ('response' in requestContext) {
    return requestContext.response
  }
  const { device } = requestContext

  const isNewVersion = isChannelSelfLocalChannelStorageVersion(c, body, 'PUT')

  // For vX.34.0+: Use channel from request body (plugin sends its local channelOverride)
  if (isNewVersion) {
    cloudlog({ requestId: c.get('requestId'), message: 'Plugin vX.34.0+ detected in getChannel, using channel from request body' })
    const channelOverride = body.channel

    if (channelOverride) {
      // Return the channel they sent (it's stored locally)
      await sendStatsAndDevice(c, device, [{ action: 'getChannel' }])
      return c.json({
        channel: channelOverride,
        status: 'override',
        allowSet: true, // Already validated when they set it
      })
    }
    else {
      // No override, use defaultChannel logic
      const channelName = defaultChannel || 'production' // Fallback to production if no defaultChannel
      await sendStatsAndDevice(c, device, [{ action: 'getChannel' }])
      return c.json({
        channel: channelName,
        status: 'default',
      })
    }
  }

  // Old behavior (< v7.34.0): query server-side override storage.
  // Read operations can use v2 flag
  const dataChannel = await getChannelsPg(c, app_id, defaultChannel ? { defaultChannel } : { public: true }, drizzleClient as ReturnType<typeof getDrizzleClient>)

  const dataChannelOverride = await getChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)
  if (dataChannelOverride?.channel_id) {
    await sendStatsAndDevice(c, device, [{ action: 'getChannel' }])
    return c.json({
      channel: dataChannelOverride.channel_id.name,
      status: 'override',
      allowSet: dataChannelOverride.channel_id.allow_device_self_set,
    })
  }
  if (!dataChannel || dataChannel.length === 0) {
    return simpleError200(c, 'channel_not_found', 'Cannot find channel')
  }

  if (!isDevicePlatform(body.platform)) {
    return simpleError200(c, 'invalid_platform', 'Invalid device platform', { platform: body.platform })
  }

  const platform = body.platform
  const finalChannel = defaultChannel
    ? dataChannel.find((channel: { name: string }) => channel.name === defaultChannel)
    : dataChannel.find((channel: { ios: boolean, android: boolean, electron: boolean }) => channel[platform])

  if (!finalChannel) {
    return simpleError200(c, 'channel_not_found', 'Cannot find channel')
  }
  await sendStatsAndDevice(c, device, [{ action: 'getChannel' }])
  return c.json({
    channel: finalChannel.name,
    status: 'default',
  })
}

async function deleteOverride(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: DeviceLink, cachedAppStatus: AppStatusResult): Promise<Response> {
  const {
    app_id,
    device_id,
    version_build,
  } = body
  cloudlog({ requestId: c.get('requestId'), message: 'delete channel self body', app_id, device_id, version_build })

  const requestContext = await prepareChannelSelfDeviceRequest(c, drizzleClient, body, 'DELETE', cachedAppStatus)
  if ('response' in requestContext) {
    return requestContext.response
  }
  const { appOwner: validatedAppOwner, device } = requestContext

  const isNewVersion = isChannelSelfLocalChannelStorageVersion(c, body, 'DELETE')

  // For vX.34.0+: do not read or write server-side channel_self storage.
  const dataChannelOverride = isNewVersion ? null : await getChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)

  if (isNewVersion) {
    await sendStatsAndDevice(c, device, [{ action: 'setChannel' }])
    return c.json(BRES)
  }

  // Old behavior (< v7.34.0): Validate and delete the server-side override.

  if (!dataChannelOverride?.channel_id) {
    return simpleError200(c, 'cannot_override', 'Cannot change device override current channel don\'t allow it')
  }

  if (!dataChannelOverride.channel_id.allow_device_self_set) {
    // Send weekly notification to org about self-assignment rejection
    backgroundTask(c, sendNotifToOrgMembersCached(
      c,
      'device:channel_self_set_rejected',
      'channel_self_rejected',
      {
        channel_name: dataChannelOverride.channel_id.name,
        app_id,
      },
      validatedAppOwner.owner_org,
      `${app_id}`,
      '0 0 * * 0', // Weekly on Sunday at midnight
      drizzleClient,
    ))
    return simpleError200(c, 'cannot_override', 'Cannot change device override current channel don\'t allow it')
  }

  // Write operation - use the PG client created by the route handler

  const success = await deleteChannelSelfOverrideForDevice(c, app_id, device_id, drizzleClient)
  if (!success) {
    return simpleError200(c, 'override_not_allowed', `Cannot delete channel override`)
  }

  return c.json(BRES)
}

async function listCompatibleChannels(c: Context, drizzleClient: ReturnType<typeof getDrizzleClient>, body: DeviceLink, cachedAppStatus: AppStatusResult): Promise<Response> {
  const { app_id, platform, is_emulator, is_prod } = body
  const cachedLimit = await assertChannelSelfCachedStatus(c, cachedAppStatus, app_id, makeDevice(body, cachedAppStatus.allow_device_custom_id), 'list')
  if (cachedLimit) {
    return cachedLimit
  }

  // First check if app exists - Read operation can use v2 flag
  const appExists = await getAppByIdPg(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>, PLAN_MAU_ACTIONS)

  if (!appExists) {
    const blocked = await blockProviderInfrastructure(c, 'GET', true)
    if (blocked)
      return blocked

    // App doesn't exist in database - normalize response to avoid oracle
    return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
  }
  const appOwner = await getAppOwnerPostgres(c, app_id, drizzleClient as ReturnType<typeof getDrizzleClient>, PLAN_MAU_ACTIONS)
  const device = makeDevice(body, appOwner?.allow_device_custom_id)
  const blockProviderInfraRequests = appOwner?.block_provider_infra_requests ?? cachedAppStatus.block_provider_infra_requests
  const blocked = await blockProviderInfrastructure(c, 'GET', blockProviderInfraRequests)
  if (blocked)
    return blocked

  const ownerRes = await assertChannelSelfAppOwnerPlanValid(c, drizzleClient, appOwner, app_id, device, 'GET', blockProviderInfraRequests)
  if ('response' in ownerRes) {
    return ownerRes.response
  }

  // Channels compatible with platform/device/build AND (public OR allow_device_self_set)
  const channels = await getCompatibleChannelsPg(c, app_id, platform as 'ios' | 'android' | 'electron', is_emulator!, is_prod!, drizzleClient as ReturnType<typeof getDrizzleClient>)

  if (!channels || channels.length === 0) {
    return c.json([])
  }

  const compatibleChannels = channels.map((channel: { id: number, name: string, public: boolean, allow_device_self_set: boolean }) => ({
    id: channel.id,
    name: channel.name,
    public: channel.public,
    allow_self_set: channel.allow_device_self_set,
  }))

  cloudlog({ requestId: c.get('requestId'), message: 'Found compatible channels', count: compatibleChannels.length })

  return c.json(compatibleChannels)
}

async function parseChannelSelfPluginRequest(
  c: Context,
  body: DeviceLink,
  logMessage: string,
  schema: StandardSchema<DeviceLink>,
  requireDevice = true,
): Promise<{ response: Response } | { body: DeviceLink, bodyParsed: DeviceLink }> {
  // Curated fields only — full body serialization was a top CPU cost on HAR inspect.
  cloudlog({
    requestId: c.get('requestId'),
    message: logMessage,
    app_id: body.app_id,
    device_id: body.device_id,
    channel: body.channel,
    version_name: body.version_name,
    plugin_version: body.plugin_version,
  })

  if (isLimited(c, body.app_id)) {
    // Pass curated metadata only — see simpleRateLimit contract in hono.ts.
    // Reflecting the raw `body` would echo the client's full DeviceLink
    // payload back inside the 429 response's `moreInfo`.
    return { response: simpleRateLimit({ app_id: body.app_id, device_id: body.device_id }) }
  }

  const bodyParsed = parsePluginBody<DeviceLink>(c, body, schema, requireDevice)

  const ipLimit = await assertChannelSelfIPRateLimit(c, bodyParsed.app_id)
  if (ipLimit) {
    return { response: ipLimit }
  }

  return { body, bodyParsed }
}

async function runChannelSelfWithPgClient(
  c: Context,
  pgClient: ReturnType<typeof getPgClient>,
  run: (drizzleClient: ReturnType<typeof getDrizzleClient>) => Promise<Response>,
  record: () => Promise<void>,
) {
  await setReplicationLagHeader(c, pgClient)

  try {
    return await run(getDrizzleClient(pgClient as any, { logger: false }))
  }
  finally {
    await closeClient(c, pgClient)
    await record()
  }
}

async function runChannelSelfDeviceOperation(
  c: Context,
  bodyParsed: DeviceLink,
  operation: ChannelSelfDeviceOperation,
  operationLabel: string,
  run: (drizzleClient: ReturnType<typeof getDrizzleClient>) => Promise<Response>,
  channel?: string,
) {
  const rateLimitStatus = await isChannelSelfRateLimited(c, bodyParsed.app_id, bodyParsed.device_id, operation, channel)
  if (rateLimitStatus.limited) {
    cloudlog({ requestId: c.get('requestId'), message: `Channel self ${operation} rate limited`, app_id: bodyParsed.app_id, device_id: bodyParsed.device_id, channel })
    return simpleRateLimit({ app_id: bodyParsed.app_id, device_id: bodyParsed.device_id, ...buildRateLimitInfo(rateLimitStatus.resetAt) })
  }

  // Old KV-backed requests and new local-storage requests can use the read replica.
  const canUseReadReplica = isChannelSelfStoreEnabled(c) || isChannelSelfLocalChannelStorageVersion(c, bodyParsed, operationLabel)
  if (!canUseReadReplica && shouldSkipChannelSelfPostgresFallback(c)) {
    await recordChannelSelfRequestSafely(c, bodyParsed.app_id, bodyParsed.device_id, operation, channel)
    await recordChannelSelfIPRateLimitSafely(c, bodyParsed.app_id)
    logSkippedSupabaseWrite(c, 'channel_self channel_devices fallback')
    return simpleError200(c, 'channel_self_server_storage_unavailable', 'Server channel_self storage unavailable')
  }

  const pgClient = getPgClient(c, canUseReadReplica)

  return await runChannelSelfWithPgClient(
    c,
    pgClient,
    run,
    async () => {
      await recordChannelSelfRequestSafely(c, bodyParsed.app_id, bodyParsed.device_id, operation, channel)
      await recordChannelSelfIPRateLimitSafely(c, bodyParsed.app_id)
    },
  )
}

// Plugin endpoints are intentionally public device endpoints: their responses are
// considered public data, so we do not require Capgo JWT/API-key auth or add
// checks beyond Supabase/platform protections. Endpoint-specific validation, plan
// checks, and rate limits still apply.
export const app = new Hono<MiddlewareKeyVariables>()

app.post('/', async (c) => {
  const body = await parseBody<DeviceLink>(c)
  const parsed = await parseChannelSelfPluginRequest(c, body, 'post body', channelSelfRequestSchema)
  if ('response' in parsed) {
    return parsed.response
  }
  const { bodyParsed } = parsed
  if (!bodyParsed.channel) {
    return simpleError200(c, 'missing_channel', 'Cannot find channel in body')
  }

  const appStatus = await getAppStatus(c, bodyParsed.app_id)
  const blocked = appStatus.cacheHit ? await blockProviderInfrastructure(c, 'POST', appStatus.block_provider_infra_requests) : null
  if (blocked)
    return blocked

  // Rate limit: max 5 set per second per device+app, and same set max once per 60 seconds
  return await runChannelSelfDeviceOperation(
    c,
    bodyParsed,
    'set',
    'POST',
    drizzleClient => post(c, drizzleClient, bodyParsed, appStatus),
    bodyParsed.channel,
  )
})

app.put('/', async (c) => {
  // TODO: Used as get, should be refactor with query param instead
  const body = await parseBody<DeviceLink>(c)
  const parsed = await parseChannelSelfPluginRequest(c, body, 'put body', channelSelfRequestSchema)
  if ('response' in parsed) {
    return parsed.response
  }
  const { bodyParsed } = parsed
  const appStatus = await getAppStatus(c, bodyParsed.app_id)
  const blocked = appStatus.cacheHit ? await blockProviderInfrastructure(c, 'PUT', appStatus.block_provider_infra_requests) : null
  if (blocked)
    return blocked

  // Rate limit: max 5 get per second per device+app
  return await runChannelSelfDeviceOperation(
    c,
    bodyParsed,
    'get',
    'PUT',
    drizzleClient => put(c, drizzleClient, bodyParsed, appStatus),
  )
})

app.delete('/', async (c) => {
  const body = convertQueryToBody(c.req.query())
  const parsed = await parseChannelSelfPluginRequest(c, body, 'delete body', channelSelfRequestSchema)
  if ('response' in parsed) {
    return parsed.response
  }
  const { bodyParsed } = parsed
  const appStatus = await getAppStatus(c, bodyParsed.app_id)
  const blocked = appStatus.cacheHit ? await blockProviderInfrastructure(c, 'DELETE', appStatus.block_provider_infra_requests) : null
  if (blocked)
    return blocked

  // Rate limit: max 5 delete per second per device+app
  return await runChannelSelfDeviceOperation(
    c,
    bodyParsed,
    'delete',
    'DELETE',
    drizzleClient => deleteOverride(c, drizzleClient, bodyParsed, appStatus),
  )
})

app.get('/', async (c) => {
  const body = convertQueryToBody(c.req.query())
  const parsed = await parseChannelSelfPluginRequest(c, body, 'list compatible channels', channelSelfGetRequestSchema as StandardSchema<DeviceLink>, false)
  if ('response' in parsed) {
    return parsed.response
  }
  const { body: bodyRaw, bodyParsed } = parsed
  const appStatus = await getAppStatus(c, bodyParsed.app_id)
  const blocked = appStatus.cacheHit ? await blockProviderInfrastructure(c, 'GET', appStatus.block_provider_infra_requests) : null
  if (blocked)
    return blocked

  // Rate limit: max 5 list per second per device+app (if device_id is provided)
  if (bodyRaw.device_id) {
    const rateLimitStatus = await isChannelSelfRateLimited(c, bodyParsed.app_id, bodyRaw.device_id, 'list')
    if (rateLimitStatus.limited) {
      cloudlog({ requestId: c.get('requestId'), message: 'Channel self list rate limited', app_id: bodyParsed.app_id, device_id: bodyRaw.device_id })
      return simpleRateLimit({ app_id: bodyParsed.app_id, device_id: bodyRaw.device_id, ...buildRateLimitInfo(rateLimitStatus.resetAt) })
    }
  }

  const pgClient = getPgClient(c, true)

  return await runChannelSelfWithPgClient(
    c,
    pgClient,
    drizzleClient => listCompatibleChannels(c, drizzleClient, bodyParsed, appStatus),
    async () => {
      // Record the request for rate limiting (all requests to prevent abuse, if device_id is provided)
      if (bodyRaw.device_id) {
        await recordChannelSelfRequestSafely(c, bodyParsed.app_id, bodyRaw.device_id, 'list')
      }
      await recordChannelSelfIPRateLimitSafely(c, bodyParsed.app_id)
    },
  )
})
