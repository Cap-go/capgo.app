import type { SemVer } from '@std/semver'
import type { Context } from 'hono'
import type { ManifestEntry } from './downloadUrl.ts'
import type { MiddlewareKeyVariables } from './hono.ts'
import type { Database } from './supabase.types.ts'
import type { AppInfos } from './types.ts'
import {
  greaterOrEqual,
  greaterThan,
  lessThan,
  parse,
  tryParse,
} from '@std/semver'
import { getRuntimeKey } from 'hono/adapter'
import { getAppStatus, setAppStatus } from './appStatus.ts'
import { getBundleUrl, getManifestUrl } from './downloadUrl.ts'
import { simpleError200 } from './hono.ts'
import { cloudlog } from './logging.ts'
import { sendNotifOrgCached } from './notifications.ts'
import { sendNotifToOrgMembersCached } from './org_email_notifications.ts'
import { closeClient, getAppBlockProviderInfraRequestsPostgres, getAppOwnerPostgres, getDrizzleClient, getPgClient, requestInfosPostgres, setReplicationLagHeader } from './pg.ts'
import { makeDevice } from './plugin_parser.ts'
import { createStatsBandwidth, createStatsMau, createStatsVersion, onPremStats, sendStatsAndDevice } from './plugin_stats.ts'
import { getClientIP } from './rate_limit.ts'
import { s3 } from './s3.ts'
import { shouldQueuePluginNotifications } from './supabase_write_guard.ts'
import { isUpdateEnumerationLimited, recordUpdateEnumerationMiss, updateEnumerationLimitedResponse } from './updateOracleGuard.ts'
import { backgroundTask, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, fixSemver, isDeprecatedPluginVersion, isInternalVersionName } from './utils.ts'

const PLAN_LIMIT: Array<'mau' | 'bandwidth' | 'storage'> = ['mau', 'bandwidth']
const CHANNEL_SELF_STORE_MIN_V5 = '5.34.0'
const CHANNEL_SELF_STORE_MIN_V6 = '6.34.0'
const CHANNEL_SELF_STORE_MIN_V7 = '7.34.0'
const CHANNEL_SELF_STORE_MIN_V8 = '8.0.0'

type AutoUpdateBlockReason = 'major' | 'minor' | 'patch' | 'metadata' | 'under_native'

function notifyAutoUpdateVersionBlocked(
  c: Context,
  kind: 'upgrade' | 'downgrade',
  reason: AutoUpdateBlockReason,
  args: {
    appId: string
    deviceId: string
    platform: string
    orgId: string
    channelName: string
    channelId: number
    version: string
    versionBuild: string
    versionName: string
  },
) {
  const eventName = kind === 'upgrade' ? 'device:upgrade_blocked' : 'device:downgrade_blocked'
  const eventData = {
    app_id: args.appId,
    app_id_url: args.appId,
    device_id: args.deviceId,
    platform: args.platform,
    channel_name: args.channelName,
    channel_id: args.channelId,
    version: args.version,
    version_build: args.versionBuild,
    version_name: args.versionName,
    reason,
  }
  return backgroundTask(c, (async () => {
    // Cloudflare plugin sets queuePluginNotifications — enqueue only, no request DB client.
    if (shouldQueuePluginNotifications(c)) {
      await sendNotifToOrgMembersCached(
        c,
        eventName,
        'device_error',
        eventData,
        args.orgId,
        args.appId,
        '0 0 * * 0',
        // Unused on the queued path; avoid borrowing the request-scoped client.
        null as unknown as ReturnType<typeof getDrizzleClient>,
      )
      return
    }

    // Non-queued fallback (local/Supabase): own a short-lived client so the request
    // pool can close without cancelling the Bento send.
    const pgClient = getPgClient(c)
    const drizzleClient = getDrizzleClient(pgClient, { logger: false })
    try {
      await sendNotifToOrgMembersCached(
        c,
        eventName,
        'device_error',
        eventData,
        args.orgId,
        args.appId,
        '0 0 * * 0',
        drizzleClient,
      )
    }
    finally {
      await closeClient(c, pgClient)
    }
  })())
}

interface InvalidIpInfo {
  blocked: boolean
  provider: 'google' | 'apple' | null
}

let loadInvalidIpInfo: Promise<((ip: string, context?: Context) => Promise<InvalidIpInfo>)> | null = null

function getInvalidIpInfo(): Promise<(ip: string, context?: Context) => Promise<InvalidIpInfo>> {
  if (!loadInvalidIpInfo)
    loadInvalidIpInfo = import('./invalids_ip.ts').then(module => module.invalidIpInfo)
  return loadInvalidIpInfo
}

export type UpdateResponseKind = 'up_to_date' | 'blocked' | 'failed'

const UPDATE_UP_TO_DATE_CODES = new Set([
  'no_new_version_available',
  'already_on_builtin',
])

const UPDATE_BLOCKED_CODES = new Set([
  'cannot_update_via_private_channel',
  'disabled_platform_ios',
  'disabled_platform_android',
  'disabled_platform_electron',
  'disable_auto_update_to_major',
  'disable_auto_update_to_minor',
  'disable_auto_update_to_patch',
  'disable_auto_update_to_metadata',
  'disable_auto_update_under_native',
  'disable_prod_build',
  'disable_dev_build',
  'disable_device',
  'disable_emulator',
  'key_id_mismatch',
  'provider_infrastructure_request_blocked',
])

export function getUpdateResponseKind(errorCode: string): UpdateResponseKind {
  if (UPDATE_UP_TO_DATE_CODES.has(errorCode))
    return 'up_to_date'
  if (UPDATE_BLOCKED_CODES.has(errorCode))
    return 'blocked'
  return 'failed'
}

function updateError200(c: Context, errorCode: string, message: string, moreInfo: Record<string, unknown> = {}) {
  return simpleError200(c, errorCode, message, {
    ...moreInfo,
    kind: getUpdateResponseKind(errorCode),
  })
}

async function getProviderInfrastructureInfo(c: Context) {
  const requestIp = getClientIP(c)
  if (requestIp === 'unknown')
    return null

  const invalidIpInfo = await getInvalidIpInfo()
  const providerInfo = await invalidIpInfo(requestIp, c)
  return { requestIp, providerInfo }
}

function providerInfrastructureBlockedResponse(c: Context, requestIp: string, providerInfo: InvalidIpInfo) {
  cloudlog({
    requestId: c.get('requestId'),
    message: 'Blocking update request from provider infrastructure IP',
    ip: requestIp,
    provider: providerInfo.provider,
  })
  return updateError200(c, 'provider_infrastructure_request_blocked', 'Update requests from known provider infrastructure are blocked', {
    provider: providerInfo.provider,
  })
}

async function providerInfrastructureBlockResponse(c: Context, blockProviderInfraRequests: boolean, knownProviderInfo?: Awaited<ReturnType<typeof getProviderInfrastructureInfo>>) {
  if (!blockProviderInfraRequests)
    return null

  const providerInfo = knownProviderInfo ?? await getProviderInfrastructureInfo(c)
  if (!providerInfo?.providerInfo.blocked)
    return null

  return providerInfrastructureBlockedResponse(c, providerInfo.requestIp, providerInfo.providerInfo)
}

async function providerInfrastructureColdCacheBlockResponse(c: Context, appId: string, drizzleClient: ReturnType<typeof getDrizzleClient>) {
  const providerInfo = await getProviderInfrastructureInfo(c)
  if (!providerInfo?.providerInfo.blocked)
    return null

  const blockProviderInfraRequests = await getAppBlockProviderInfraRequestsPostgres(c, appId, drizzleClient)
  if (blockProviderInfraRequests.status === 'error')
    return null
  if (blockProviderInfraRequests.status === 'found' && !blockProviderInfraRequests.blockProviderInfraRequests)
    return null

  return providerInfrastructureBlockedResponse(c, providerInfo.requestIp, providerInfo.providerInfo)
}

interface ResponseFeatureSupport {
  manifest: boolean
  metadata: boolean
}

const responseFeatureSupportCache = new Map<string, ResponseFeatureSupport>()

function getResponseFeatureSupport(plugin_version: string): ResponseFeatureSupport {
  const cached = responseFeatureSupportCache.get(plugin_version)
  if (cached)
    return cached

  const pluginVersion = parse(plugin_version)
  const support = {
    manifest: !isDeprecatedPluginVersion(pluginVersion, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7),
    metadata: !isDeprecatedPluginVersion(pluginVersion, '5.35.0', '6.35.0', '7.35.0', '8.35.0'),
  }
  responseFeatureSupportCache.set(plugin_version, support)
  return support
}

export function resToVersion(plugin_version: string, signedURL: string, version: Database['public']['Tables']['app_versions']['Row'], manifest: ManifestEntry[], expose_metadata: boolean = false) {
  const support = getResponseFeatureSupport(plugin_version)
  const res: {
    version: string
    url: string
    session_key: string
    checksum: string | null
    manifest?: ManifestEntry[]
    link?: string | null
    comment?: string | null
  } = {
    version: version.name,
    url: signedURL,
    // session_key and checksum are always included since v4 is no longer supported
    session_key: version.session_key ?? '',
    checksum: version.checksum,
  }
  // manifest is supported in v5.10.0+, v6.25.0+, v7.0.35+, v8+
  if (manifest.length > 0 && support.manifest)
    res.manifest = manifest
  // Include link and comment for plugin v5.35.0+, v6.35.0+, v7.35.0+, v8.35.0+ (only if expose_metadata is enabled and they have values)
  if (expose_metadata && support.metadata) {
    if (version.link)
      res.link = version.link
    if (version.comment)
      res.comment = version.comment
  }
  return res
}

function hasChannelSelfStoreBinding(c: Context) {
  return Boolean((c as Context<MiddlewareKeyVariables>).env?.CHANNEL_SELF_STORE)
}

function usesLegacyChannelSelfStoreVersion(pluginVersion: SemVer) {
  return isDeprecatedPluginVersion(pluginVersion, CHANNEL_SELF_STORE_MIN_V5, CHANNEL_SELF_STORE_MIN_V6, CHANNEL_SELF_STORE_MIN_V7, CHANNEL_SELF_STORE_MIN_V8)
}

async function getStoredChannelSelfOverride(c: Context, appId: string, deviceId: string) {
  const { getChannelSelfOverride } = await import('./channelSelfStore.ts')
  return getChannelSelfOverride(c as Context<MiddlewareKeyVariables>, appId, deviceId)
}

export async function updateWithPG(
  c: Context,
  body: AppInfos,
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  appStatus?: Awaited<ReturnType<typeof getAppStatus>>,
) {
  const {
    version_name,
    version_build,
    device_id,
    platform,
    app_id,
    plugin_version = '2.3.3',
    defaultChannel,
  } = body
  // Request body is already logged with curated fields in plugins/updates.ts.
  // Avoid a second per-request cloudlog on this hot path (HAR CPU inspect).
  const cachedAppStatus = appStatus ?? await getAppStatus(c, app_id)
  const cachedStatus = cachedAppStatus.status
  if (cachedStatus === 'onprem') {
    const updateEnumerationLimit = await recordUpdateEnumerationMiss(c, app_id)
    if (updateEnumerationLimit.limited)
      return updateEnumerationLimitedResponse(c)

    const device = makeDevice(body, cachedAppStatus.allow_device_custom_id)
    return onPremStats(c, app_id, 'get', device)
  }
  if (cachedStatus === 'cancelled') {
    const device = makeDevice(body, cachedAppStatus.allow_device_custom_id)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, upgrade plan to continue to update', id: app_id })
    await sendStatsAndDevice(c, device, [{ action: 'needPlanUpgrade' }])
    return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
  }
  const existingUpdateEnumerationLimit = await isUpdateEnumerationLimited(c)
  if (existingUpdateEnumerationLimit.limited)
    return updateEnumerationLimitedResponse(c)

  if (!cachedAppStatus.cacheHit) {
    const providerBlockedResponse = await providerInfrastructureColdCacheBlockResponse(c, app_id, drizzleClient)
    if (providerBlockedResponse)
      return providerBlockedResponse
  }

  const appOwner = await getAppOwnerPostgres(c, app_id, drizzleClient, PLAN_LIMIT)
  // if version_build is not semver, then make it semver
  const device = makeDevice(body, appOwner?.allow_device_custom_id)
  if (!appOwner) {
    const updateEnumerationLimit = await recordUpdateEnumerationMiss(c, app_id)
    if (updateEnumerationLimit.limited)
      return updateEnumerationLimitedResponse(c)

    await setAppStatus(c, app_id, 'onprem', true, cachedAppStatus.block_provider_infra_requests)
    return onPremStats(c, app_id, 'get', device)
  }
  const providerBlockedResponse = await providerInfrastructureBlockResponse(c, appOwner.block_provider_infra_requests)
  if (providerBlockedResponse)
    return providerBlockedResponse

  if (!appOwner.plan_valid) {
    await setAppStatus(c, app_id, 'cancelled', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, upgrade plan to continue to update', id: app_id })
    await sendStatsAndDevice(c, device, [{ action: 'needPlanUpgrade' }])
    // Send weekly notification about missing payment (not configurable - payment related)
    await backgroundTask(c, sendNotifOrgCached(c, 'org:missing_payment', {
      app_id,
      device_id,
      app_id_url: app_id,
    }, appOwner.owner_org, app_id, '0 0 * * 1', appOwner.orgs.management_email, drizzleClient)) // Weekly on Monday
    return c.json({ error: 'on_premise_app', message: 'On-premise app detected' }, 429)
  }
  await setAppStatus(c, app_id, 'cloud', appOwner.allow_device_custom_id, appOwner.block_provider_infra_requests)
  const pluginVersion = parse(plugin_version)
  const shouldUseChannelSelfStore = usesLegacyChannelSelfStoreVersion(pluginVersion) && hasChannelSelfStoreBinding(c)
  const channelSelfOverride = shouldUseChannelSelfStore
    ? await getStoredChannelSelfOverride(c, app_id, device_id)
    : null
  const channelDeviceCount = appOwner.channel_device_count ?? 0
  const effectiveChannelDeviceCount = channelDeviceCount
  const manifestBundleCount = appOwner.manifest_bundle_count ?? 0
  const rolloutChannelCount = appOwner.rollout_channel_count ?? 0
  const rolloutPausedVersionNames = appOwner.rollout_paused_version_names ?? []
  const bypassChannelOverrides = !channelSelfOverride && effectiveChannelDeviceCount <= 0
  // v5 is deprecated if < 5.10.0, v6 is deprecated if < 6.25.0, v7 is deprecated if < 7.25.0
  const isDeprecated = isDeprecatedPluginVersion(pluginVersion)
  // Ensure there is manifest and the plugin version support manifest fetching (v5.10.0+, v6.25.0+, v7.0.35+)
  const fetchManifestEntries = manifestBundleCount > 0 && !isDeprecatedPluginVersion(pluginVersion, undefined, undefined, BROTLI_MIN_UPDATER_VERSION_V7)
  cloudlog({
    requestId: c.get('requestId'),
    message: 'App channel device count evaluated',
    app_id,
    channelDeviceCount,
    effectiveChannelDeviceCount,
    bypassChannelOverrides,
    manifestBundleCount,
    rolloutChannelCount,
    rolloutPausedVersionCount: rolloutPausedVersionNames.length,
    fetchManifestEntries,
  })
  if (body.version_build === 'unknown') {
    return updateError200(c, 'unknown_version_build', 'Version build is unknown, cannot proceed with update', { body })
  }
  const coerce = tryParse(fixSemver(body.version_build))
  if (!coerce) {
    // get app owner with app_id
    await backgroundTask(c, sendNotifOrgCached(c, 'user:semver_issue', {
      app_id,
      device_id,
      version_id: version_build,
      app_id_url: app_id,
    }, appOwner.owner_org, app_id, '0 0 * * 1', appOwner.orgs.management_email, drizzleClient))
    return updateError200(c, 'semver_error', `Native version: ${body.version_build} doesn't follow semver convention, please check https://capgo.app/semver_tester/ to learn more about semver usage in Capgo`)
  }
  // Reject v4 completely - it's no longer supported
  if (pluginVersion.major === 4) {
    cloudlog({ requestId: c.get('requestId'), message: 'Plugin version 4.x is no longer supported', plugin_version, app_id })
    await backgroundTask(c, sendNotifOrgCached(c, 'user:plugin_issue', {
      app_id,
      device_id,
      version_id: version_build,
      app_id_url: app_id,
    }, appOwner.owner_org, app_id, '0 0 * * 1', appOwner.orgs.management_email, drizzleClient))
    await sendStatsAndDevice(c, device, [{ action: 'backend_refusal' }])
    return updateError200(c, 'unsupported_plugin_version', `Plugin version ${plugin_version} (v4) is no longer supported. Please upgrade to v5.10.0 or later.`)
  }

  // Check if plugin_version is deprecated and send notification
  if (isDeprecated) {
    await backgroundTask(c, sendNotifOrgCached(c, 'user:plugin_issue', {
      app_id,
      device_id,
      version_id: version_build,
      app_id_url: app_id,
    }, appOwner.owner_org, app_id, '0 0 * * 1', appOwner.orgs.management_email, drizzleClient))
  }
  if (!app_id || !device_id || !version_build || !version_name || !platform) {
    return updateError200(c, 'missing_info', 'Cannot find device_id or app_id')
  }

  await backgroundTask(c, createStatsMau(c, device_id, app_id, appOwner.owner_org, platform, version_build))

  cloudlog({ requestId: c.get('requestId'), message: 'vals', platform, device })

  // Only query link/comment if plugin supports it (v5.35.0+, v6.35.0+, v7.35.0+, v8.35.0+) AND app has expose_metadata enabled
  const needsMetadata = appOwner.expose_metadata && !isDeprecatedPluginVersion(pluginVersion, '5.35.0', '6.35.0', '7.35.0', '8.35.0')

  const requestedInto = await requestInfosPostgres({
    c,
    platform,
    app_id,
    device_id,
    defaultChannel,
    drizzleClient,
    channelDeviceCount: effectiveChannelDeviceCount,
    manifestBundleCount,
    rolloutChannelCount,
    rolloutPausedVersionNames,
    currentVersionName: version_name,
    includeMetadata: needsMetadata,
    channelSelfOverrideChannelId: channelSelfOverride?.channel_id.id,
  })
  const { channelOverride } = requestedInto
  let { channelData } = requestedInto
  cloudlog({ requestId: c.get('requestId'), message: `channelData exists ? ${channelData !== undefined}, channelOverride exists ? ${channelOverride !== undefined}` })

  if (!channelData && !channelOverride) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot get channel or override', id: app_id, date: new Date().toISOString() })
    await sendStatsAndDevice(c, device, [{ action: 'NoChannelOrOverride' }])
    return updateError200(c, 'no_channel', 'no default channel or override')
  }

  // Trigger only if the channel is overwritten but the version is not
  if (channelOverride)
    channelData = channelOverride

  if (!channelData) {
    return updateError200(c, 'null_channel_data', 'channel data still null')
  }

  const version = channelOverride?.version ?? channelData.version
  const manifestEntries = (channelOverride?.manifestEntries ?? channelData?.manifestEntries ?? []) as Partial<Database['public']['Tables']['manifest']['Row']>[]
  // device.version = versionData ? versionData.id : version.id

  if (!version.external_url && !version.r2_path && !isInternalVersionName(version.name) && (!manifestEntries || manifestEntries.length === 0)) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot get bundle', id: app_id, version, manifestEntriesLength: manifestEntries ? manifestEntries.length : 0, channelData: channelData ? channelData.channels.name : 'no channel data', defaultChannel })
    await sendStatsAndDevice(c, device, [{ action: 'missingBundle', versionName: version.name }])
    return updateError200(c, 'no_bundle', 'Cannot get bundle')
  }

  // Check for encryption key mismatch between device and bundle
  // Only check if both device and bundle have key_id set (encrypted bundle)
  // Only enforce for plugin_version > 8.40.7 (transitional period for key_id format change from 4 to 20 chars)
  if (body.key_id && version.key_id && body.key_id !== version.key_id && greaterThan(pluginVersion, parse('8.40.7'))) {
    cloudlog({ requestId: c.get('requestId'), message: 'Encryption key mismatch', device_id, deviceKeyId: body.key_id, bundleKeyId: version.key_id, versionName: version.name })
    await sendStatsAndDevice(c, device, [{ action: 'keyMismatch', versionName: version.name }])
    return updateError200(c, 'key_id_mismatch', 'Device encryption key does not match bundle encryption key. The device may have a different public key than the one used to encrypt this bundle.', {
      deviceKeyId: body.key_id,
      bundleKeyId: version.key_id,
    })
  }

  // cloudlog(c.get('requestId'), 'signedURL', device_id, version_name, version.name)
  if (version_name === version.name) {
    cloudlog({ requestId: c.get('requestId'), message: 'No new version available', id: device_id, version_name, version: version.name, date: new Date().toISOString() })
    // TODO: check why this event is send with wrong version_name
    await sendStatsAndDevice(c, device, [{ action: 'noNew', versionName: version.name }])
    return updateError200(c, 'no_new_version_available', 'No new version available')
  }

  if (channelData) {
    const notifyVersionBlocked = (
      kind: 'upgrade' | 'downgrade',
      reason: AutoUpdateBlockReason,
    ) => notifyAutoUpdateVersionBlocked(c, kind, reason, {
      appId: app_id,
      deviceId: device_id,
      platform,
      orgId: appOwner.owner_org,
      channelName: channelData.channels.name,
      channelId: channelData.channels.id,
      version: version.name,
      versionBuild: version_build,
      versionName: version_name,
    })
    // cloudlog(c.get('requestId'), 'check disableAutoUpdateToMajor', device_id)
    if (!channelData.channels.ios && platform === 'ios') {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, ios is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disablePlatformIos', versionName: version.name }])
      return updateError200(c, 'disabled_platform_ios', 'Cannot update, ios it\'s disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!channelData.channels.android && platform === 'android') {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, android is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disablePlatformAndroid', versionName: version.name }])
      cloudlog({ requestId: c.get('requestId'), message: 'sendStats', date: new Date().toISOString() })
      return updateError200(c, 'disabled_platform_android', 'Cannot update, android is disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!channelData.channels.electron && platform === 'electron') {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update, electron is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disablePlatformElectron', versionName: version.name }])
      return updateError200(c, 'disabled_platform_electron', 'Cannot update, electron is disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!isInternalVersionName(version.name) && channelData?.channels.disable_auto_update === 'major' && parse(version.name).major > parse(version_build).major) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot upgrade major version', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableAutoUpdateToMajor', versionName: version.name }])
      await notifyVersionBlocked('upgrade', 'major')
      return updateError200(c, 'disable_auto_update_to_major', 'Cannot upgrade major version', {
        major: true,
        version: version.name,
        old: version_build,
      })
    }

    if (!channelData.channels.allow_device_self_set && !channelData.channels.public && !channelOverride) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update via a private channel', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'cannotUpdateViaPrivateChannel', versionName: version.name }])
      const errorMessage = defaultChannel
        ? `Cannot update via a private channel. The channel "${channelData.channels.name}" does not allow device self-assignment. Please ensure your defaultChannel "${defaultChannel}" has "Allow devices to self dissociate/associate" set to true.`
        : `Cannot update via a private channel. The channel "${channelData.channels.name}" does not allow device self-assignment. Please set a defaultChannel with "Allow devices to self dissociate/associate" enabled.`
      return updateError200(c, 'cannot_update_via_private_channel', errorMessage)
    }

    if (!isInternalVersionName(version.name) && channelData.channels.disable_auto_update === 'minor' && (
      parse(version.name).major !== parse(version_build).major
      || parse(version.name).minor !== parse(version_build).minor
    )) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot upgrade minor version', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableAutoUpdateToMinor', versionName: version.name }])
      await notifyVersionBlocked('upgrade', 'minor')
      return updateError200(c, 'disable_auto_update_to_minor', 'Cannot upgrade minor version', {
        major: true,
        version: version.name,
        old: version_build,
      })
    }

    cloudlog({ requestId: c.get('requestId'), message: 'version', version: version.name, old: version_name })
    if (!isInternalVersionName(version.name) && channelData.channels.disable_auto_update === 'patch' && (
      parse(version.name).major !== parse(version_build).major
      || parse(version.name).minor !== parse(version_build).minor
      || parse(version.name).patch !== parse(version_build).patch
    )) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot upgrade patch version', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableAutoUpdateToPatch', versionName: version.name }])
      await notifyVersionBlocked('upgrade', 'patch')
      return updateError200(c, 'disable_auto_update_to_patch', 'Cannot upgrade patch version', {
        major: true,
        version: version.name,
        old: version_build,
      })
    }

    if (!isInternalVersionName(version.name) && channelData.channels.disable_auto_update === 'version_number') {
      const minUpdateVersion = version.min_update_version

      // The channel is misconfigured
      if (minUpdateVersion === null) {
        cloudlog({ requestId: c.get('requestId'), message: 'Channel is misconfigured', channel: channelData.channels.name, date: new Date().toISOString() })
        await sendStatsAndDevice(c, device, [{ action: 'channelMisconfigured', versionName: version.name }])
        return updateError200(c, 'misconfigured_channel', `Channel ${channelData.channels.name} is misconfigured`, {
          version: version.name,
          old: version_build,
        })
      }

      // Check if the minVersion is greater then the current version
      if (greaterThan(parse(minUpdateVersion), parse(version_build))) {
        cloudlog({ requestId: c.get('requestId'), message: 'Cannot upgrade, metadata > current version', id: device_id, min: minUpdateVersion, old: version_name, date: new Date().toISOString() })
        await sendStatsAndDevice(c, device, [{ action: 'disableAutoUpdateMetadata', versionName: version.name }])
        await notifyVersionBlocked('upgrade', 'metadata')
        return updateError200(c, 'disable_auto_update_to_metadata', 'Cannot upgrade version, min update version > current version', {
          major: true,
          version: version.name,
          old: version_build,
        })
      }
    }

    // cloudlog(c.get('requestId'), 'check disableAutoUpdateUnderNative', device_id)
    if (!isInternalVersionName(version.name) && channelData.channels.disable_auto_update_under_native && lessThan(parse(version.name), parse(version_build))) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot revert under native version', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableAutoUpdateUnderNative', versionName: version.name }])
      await notifyVersionBlocked('downgrade', 'under_native')
      return updateError200(c, 'disable_auto_update_under_native', 'Cannot revert under native version', {
        version: version.name,
        old: version_name,
      })
    }

    if (!channelData.channels.allow_prod && body.is_prod) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update prod build is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableProdBuild', versionName: version.name }])
      return updateError200(c, 'disable_prod_build', 'Cannot update, prod build is disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!channelData.channels.allow_dev && !body.is_prod) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update dev build is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableDevBuild', versionName: version.name }])
      return updateError200(c, 'disable_dev_build', 'Cannot update, dev build is disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!channelData.channels.allow_device && !body.is_emulator) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update device is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableDevice', versionName: version.name }])
      return updateError200(c, 'disable_device', 'Cannot update, device is disabled', {
        version: version.name,
        old: version_name,
      })
    }
    if (!channelData.channels.allow_emulator && body.is_emulator) {
      cloudlog({ requestId: c.get('requestId'), message: 'Cannot update emulator is disabled', id: device_id, date: new Date().toISOString() })
      await sendStatsAndDevice(c, device, [{ action: 'disableEmulator', versionName: version.name }])
      return updateError200(c, 'disable_emulator', 'Cannot update, emulator is disabled', {
        version: version.name,
        old: version_name,
      })
    }
  }
  if (version.name === 'builtin' && greaterOrEqual(parse(plugin_version), parse('6.2.0'))) {
    if (body.version_name === 'builtin' && version.name === 'builtin') {
      return updateError200(c, 'already_on_builtin', 'Already on builtin')
    }
    else {
      return updateError200(c, 'already_on_builtin', 'Already on builtin', {
        version: 'builtin',
      })
    }
  }
  else if (version.name === 'builtin' && !greaterOrEqual(parse(plugin_version), parse('6.2.0'))) {
    return updateError200(c, 'revert_to_builtin_plugin_version_too_old', 'revert_to_builtin used, but plugin version is too old')
  }
  const startBundleUrl = performance.now()
  let signedURL = version.external_url ?? ''
  let manifest: ManifestEntry[] = []
  if (!version.external_url) {
    if (version.r2_path) {
      const url = await getBundleUrl(c, version.r2_path, device_id, version.checksum ?? '')
      if (url) {
        // only count the size of the bundle if it's not external and zip for now
        signedURL = url
        if (getRuntimeKey() !== 'workerd') {
          await backgroundTask(c, async () => {
            const size = await s3.getSize(c, version.r2_path)
            await createStatsBandwidth(c, device_id, app_id, size ?? 0)
          })
        }
      }
    }
    manifest = getManifestUrl(c, version.id, manifestEntries, device_id)
  }
  const endBundleUrl = performance.now()
  cloudlog({ requestId: c.get('requestId'), message: 'bundle_url_timing', duration: `${endBundleUrl - startBundleUrl}ms`, date: new Date().toISOString() })
  //  check signedURL and if it's url
  if ((!signedURL || (!(signedURL.startsWith('http://') || signedURL.startsWith('https://')))) && !manifest.length) {
    cloudlog({ requestId: c.get('requestId'), message: 'Cannot get bundle signedURL', url: signedURL, id: app_id, date: new Date().toISOString() })
    await sendStatsAndDevice(c, device, [{ action: 'cannotGetBundle', versionName: version.name }])
    return updateError200(c, 'no_bundle_url', 'Cannot get bundle url')
  }
  if (manifest.length && !signedURL) {
    // TODO: remove this when all plugin accept no URL
    signedURL = 'https://404.capgo.app/no.zip'
  }
  // cloudlog(c.get('requestId'), 'save stats', device_id)
  device.version_name = version.name
  await Promise.all([
    createStatsVersion(c, version.name, app_id, 'get'),
    sendStatsAndDevice(c, device, [{ action: 'get', versionName: version.name }]),
  ])
  cloudlog({ requestId: c.get('requestId'), message: 'New version available', app_id, version: version.name, signedURL, date: new Date().toISOString() })
  const res = resToVersion(plugin_version, signedURL, version as any, manifest, needsMetadata)
  if (!res.url && !res.manifest) {
    cloudlog({ requestId: c.get('requestId'), message: 'No url or manifest', id: app_id, version: version.name, date: new Date().toISOString() })
    return updateError200(c, 'no_url_or_manifest', 'No url or manifest')
  }
  return c.json(res, 200)
}

export async function update(c: Context, body: AppInfos) {
  const appStatus = await getAppStatus(c, body.app_id)
  if (appStatus.cacheHit) {
    const providerBlockedResponse = await providerInfrastructureBlockResponse(c, appStatus.block_provider_infra_requests)
    if (providerBlockedResponse)
      return providerBlockedResponse
  }
  const pgClient = getPgClient(c, true)
  try {
    await setReplicationLagHeader(c, pgClient)

    const drizzlePg = getDrizzleClient(pgClient, { logger: false })
    // Use the active DB client only when needed
    return await updateWithPG(c, body, drizzlePg, appStatus)
  }
  finally {
    await closeClient(c, pgClient)
  }
}
