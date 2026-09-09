import type { OptionsSetChannel } from '../schemas/channel'
import type { Database } from '../types/supabase.types'
import type { Compatibility } from '../utils'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { findChannel } from '../api/channels'
import { getActiveAppVersions, getVersionData } from '../api/versions'
import { sendUpdateNotificationsForChannels } from '../notifications/send-update'
import { printPreviewQrForResolvedTarget, resolveChannelPreviewTarget } from '../preview/qr'
import { formatTable } from '../terminal-table'
import { CliUserError } from '../shared/cli-user-error'
import { channelUpdatePackageCliError, checkCompatibilityNativePackages, createSupabaseClient, findSavedKey, getAppId, getBundleVersion, getCompatibilityDetails, getConfig, getOrganizationId, invokeCapgoCliApi, isCompatible, resolveUserIdFromApiKey, sendEvent } from '../utils'

/**
 * Display a compatibility table for the given packages
 */
function displayCompatibilityTable(packages: Compatibility[]) {
  const rows = packages.map((entry) => {
    const details = getCompatibilityDetails(entry)
    return [
      entry.name,
      entry.localVersion || '-',
      entry.remoteVersion || '-',
      details.compatible ? '✅' : '❌',
      details.message,
    ]
  })

  log.info(formatTable({
    headers: ['Package', 'Local', 'Remote', 'Status', 'Details'],
    rows,
  }))
}

export type { OptionsSetChannel } from '../schemas/channel'

const disableAutoUpdatesPossibleOptions = ['major', 'minor', 'metadata', 'patch', 'none']
const updatePackagePossibleOptions = ['all', 'zip', 'delta', 'zip_from_builtin', 'delta_from_builtin'] as const

function assertIntegerInRange(value: number, label: string, min: number, max: number) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`${label} must be an integer between ${min} and ${max}`)
}

function assertOptionalIntegerInRange(value: number | null | undefined, label: string, min: number, max: number) {
  if (value == null)
    return
  assertIntegerInRange(value, label, min, max)
}

function assertOptionalConfidence(value: number | undefined) {
  if (value == null)
    return
  if (!Number.isFinite(value) || value <= 0 || value >= 1)
    throw new Error('Auto-pause confidence must be a number greater than 0 and less than 1')
}

/**
 * Warn (and optionally throw) when a bundle's native packages don't match the
 * channel. `--accept-incompatible` continues after the warning so callers can
 * mark a handled mismatch (runtime plugin guards, etc.).
 */
export function rejectOrAcceptIncompatibleChannelBundle(params: {
  silent: boolean
  acceptIncompatible?: boolean
  incompatible: boolean
  finalCompatibility: Compatibility[]
  heading: string
  errorMessage: string
}): void {
  if (!params.incompatible)
    return
  if (!params.silent) {
    log.warn(params.heading)
    log.warn('')
    displayCompatibilityTable(params.finalCompatibility)
    log.warn('')
    log.warn('An app store update may be required for these changes to take effect.')
  }
  if (params.acceptIncompatible) {
    if (!params.silent)
      log.warn('Proceeding because --accept-incompatible was set.')
    return
  }
  throw new Error(params.errorMessage)
}

export async function setChannelInternal(channel: string, appId: string, options: OptionsSetChannel, silent = false) {
  if (!silent)
    intro('Set channel')

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new Error('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new CliUserError('Missing appId')
  }

  if (!channel) {
    if (!silent)
      log.error('Missing argument, you need to provide a channel')
    throw new Error('Missing channel id')
  }

  if (options.acceptIncompatible && options.ignoreMetadataCheck) {
    const message = 'You cannot use --accept-incompatible together with --ignore-metadata-check — accepting a mismatch requires running the compatibility check. Remove one of them.'
    if (!silent)
      log.error(message)
    throw new Error(message)
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await check2FAComplianceForApp(supabase, appId, silent)
  const userId = await resolveUserIdFromApiKey(supabase, options.apikey)

  const {
    bundle,
    state,
    downgrade,
    latest,
    latestRemote,
    ios,
    android,
    selfAssign,
    disableAutoUpdate,
    updatePackage,
    dev,
    emulator,
    device,
    prod,
    rolloutBundle,
    rolloutPercentage,
    rolloutPercentageBps,
    rolloutEnable,
    rolloutDisable,
    rolloutPause,
    rolloutResume,
    rolloutRollback,
    rolloutPromote,
    rolloutCacheTtlSeconds,
    autoPauseEnabled,
    autoPauseDisabled,
    autoPauseWindowMinutes,
    autoPauseFailureRateBps,
    autoPauseConfidence,
    autoPauseMinAttempts,
    autoPauseMinFailures,
    autoPauseAction,
    autoPauseCooldownMinutes,
    sendUpdateNotification,
  } = options
  let bundleLinkChanged = false

  if (latest && bundle) {
    if (!silent)
      log.error('Cannot set latest and bundle at the same time')
    throw new Error('Cannot set both latest and bundle simultaneously')
  }

  if (latestRemote && bundle) {
    if (!silent)
      log.error('Cannot set latest remote and bundle at the same time')
    throw new Error('Cannot set both latest remote and bundle simultaneously')
  }

  if (latestRemote && latest) {
    if (!silent)
      log.error('Cannot set latest remote and latest at the same time')
    throw new Error('Cannot set both latest remote and latest simultaneously')
  }

  if (
    bundle == null
    && state == null
    && latest == null
    && latestRemote == null
    && downgrade == null
    && ios == null
    && android == null
    && selfAssign == null
    && dev == null
    && emulator == null
    && device == null
    && prod == null
    && disableAutoUpdate == null
    && updatePackage == null
    && rolloutBundle == null
    && rolloutPercentage == null
    && rolloutPercentageBps == null
    && rolloutEnable == null
    && rolloutDisable == null
    && rolloutPause == null
    && rolloutResume == null
    && rolloutRollback == null
    && rolloutPromote == null
    && rolloutCacheTtlSeconds == null
    && autoPauseEnabled == null
    && autoPauseDisabled == null
    && autoPauseWindowMinutes == null
    && autoPauseFailureRateBps === undefined
    && autoPauseConfidence == null
    && autoPauseMinAttempts === undefined
    && autoPauseMinFailures === undefined
    && autoPauseAction == null
    && autoPauseCooldownMinutes == null
  ) {
    if (!silent)
      log.error('Missing argument, you need to provide a option to set')
    throw new Error('No channel option provided')
  }

  const hasStableBundlePromotion = bundle != null || latest === true || latestRemote === true
  const hasRolloutTargetChange = rolloutBundle != null || rolloutRollback === true || rolloutPromote === true
  const hasRolloutConfiguration = rolloutPercentage != null
    || rolloutPercentageBps != null
    || rolloutEnable != null
    || rolloutDisable != null
    || rolloutPause != null
    || rolloutResume != null
    || rolloutCacheTtlSeconds != null
    || autoPauseEnabled != null
    || autoPauseDisabled != null
    || autoPauseWindowMinutes != null
    || autoPauseFailureRateBps !== undefined
    || autoPauseConfidence != null
    || autoPauseMinAttempts !== undefined
    || autoPauseMinFailures !== undefined
    || autoPauseAction != null
    || autoPauseCooldownMinutes != null
  const hasSettingsUpdate = state != null
    || downgrade != null
    || ios != null
    || android != null
    || selfAssign != null
    || disableAutoUpdate != null
    || updatePackage != null
    || dev != null
    || emulator != null
    || device != null
    || prod != null
    || hasRolloutTargetChange
    || hasRolloutConfiguration
  const hasBundlePromotion = hasStableBundlePromotion || hasRolloutTargetChange
  const { data: existingChannel, error: channelError } = await findChannel(supabase, appId, channel)
  if (channelError || !existingChannel) {
    if (!silent)
      log.error(`Cannot find channel ${channel}`)
    throw new Error(`Cannot find channel ${channel}`)
  }

  // Disable unlinks only when a rollout bundle is linked; match API promote gating.
  const disableUnlinksRollout = rolloutDisable === true && existingChannel.rollout_version != null
  if (hasSettingsUpdate)
    await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'channel.update_settings', silent, true, existingChannel.id)
  if (hasBundlePromotion || disableUnlinksRollout)
    await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'channel.promote_bundle', silent, true, existingChannel.id)

  const orgId = await getOrganizationId(options.apikey!, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })

  const channelPayload: Database['public']['Tables']['channels']['Insert'] = {
    created_by: userId,
    app_id: appId,
    name: channel,
    owner_org: orgId,
    version: undefined as any,
  }

  async function findRemoteBundle(versionName: string) {
    return getVersionData(options.apikey!, appId, versionName, {
      silent,
      apikey: options.apikey!,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
  }

  const resolvedBundleVersion = latest
    ? (extConfig?.config?.plugins?.CapacitorUpdater?.version || getBundleVersion('', options.packageJson))
    : bundle

  if (resolvedBundleVersion != null) {
    const data = await getVersionData(options.apikey!, appId, resolvedBundleVersion, {
      silent,
      apikey: options.apikey!,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })

    if (!options.ignoreMetadataCheck) {
      const { finalCompatibility, localDependencies } = await checkCompatibilityNativePackages(
        supabase,
        appId,
        channel,
        (data.native_packages as any) ?? [],
      )

      const incompatiblePackages = finalCompatibility.filter(item => !isCompatible(item))

      rejectOrAcceptIncompatibleChannelBundle({
        silent,
        acceptIncompatible: options.acceptIncompatible,
        incompatible: localDependencies.length > 0 && incompatiblePackages.length > 0,
        finalCompatibility,
        heading: `Bundle NOT compatible with ${channel} channel`,
        errorMessage: `Bundle is not compatible with ${channel} channel`,
      })

      if (!silent && !(localDependencies.length > 0 && incompatiblePackages.length > 0)) {
        if (localDependencies.length === 0 && finalCompatibility.length > 0)
          log.info(`Ignoring check compatibility with ${channel} channel because the bundle does not contain any native packages`)
        else
          log.info(`Bundle is compatible with ${channel} channel`)
      }
    }

    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to @${resolvedBundleVersion}`)

    channelPayload.version = data.id
    bundleLinkChanged = bundleLinkChanged || existingChannel.version !== data.id
  }

  if (latestRemote) {
    const versions = await getActiveAppVersions(options.apikey!, appId, {
      silent,
      apikey: options.apikey!,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
    const data = versions[0]
    if (!data) {
      if (!silent)
        log.error('Cannot find latest remote version')
      throw new Error('Cannot find latest remote version')
    }

    if (!options.ignoreMetadataCheck) {
      const { finalCompatibility } = await checkCompatibilityNativePackages(
        supabase,
        appId,
        channel,
        (data.native_packages as any) ?? [],
      )

      const incompatiblePackages = finalCompatibility.filter(item => !isCompatible(item))

      rejectOrAcceptIncompatibleChannelBundle({
        silent,
        acceptIncompatible: options.acceptIncompatible,
        incompatible: incompatiblePackages.length > 0,
        finalCompatibility,
        heading: `Bundle NOT compatible with ${channel} channel`,
        errorMessage: `Latest remote bundle is not compatible with ${channel} channel`,
      })
    }

    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to @${data.name}`)

    channelPayload.version = data.id
    bundleLinkChanged = bundleLinkChanged || existingChannel.version !== data.id
  }

  if (rolloutBundle != null) {
    const data = await findRemoteBundle(rolloutBundle)

    if (!options.ignoreMetadataCheck) {
      const { finalCompatibility, localDependencies } = await checkCompatibilityNativePackages(
        supabase,
        appId,
        channel,
        (data.native_packages as any) ?? [],
      )

      const incompatiblePackages = finalCompatibility.filter(item => !isCompatible(item))

      rejectOrAcceptIncompatibleChannelBundle({
        silent,
        acceptIncompatible: options.acceptIncompatible,
        incompatible: localDependencies.length > 0 && incompatiblePackages.length > 0,
        finalCompatibility,
        heading: `Rollout bundle NOT compatible with ${channel} channel`,
        errorMessage: `Rollout bundle is not compatible with ${channel} channel`,
      })

      if (!silent && !(localDependencies.length > 0 && incompatiblePackages.length > 0)) {
        if (localDependencies.length === 0 && finalCompatibility.length > 0)
          log.info(`Ignoring check compatibility with ${channel} channel because the rollout bundle does not contain any native packages`)
        else
          log.info(`Rollout bundle is compatible with ${channel} channel`)
      }
    }

    if (existingChannel.version == null && channelPayload.version == null)
      throw new Error('Cannot set rollout target without a stable bundle')

    channelPayload.rollout_version = data.id
    bundleLinkChanged = bundleLinkChanged || existingChannel.rollout_version !== data.id
    if (rolloutEnable == null)
      channelPayload.rollout_enabled = true
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} rollout target to @${rolloutBundle}`)
  }

  if (rolloutPercentage != null) {
    if (!Number.isFinite(rolloutPercentage) || rolloutPercentage < 0 || rolloutPercentage > 100)
      throw new Error('Rollout percentage must be between 0 and 100')
  }
  const finalRolloutPercentageBps = rolloutPercentageBps ?? (rolloutPercentage == null ? undefined : Math.round(rolloutPercentage * 100))
  if (finalRolloutPercentageBps != null) {
    assertIntegerInRange(finalRolloutPercentageBps, 'Rollout percentage basis points', 0, 10000)
    channelPayload.rollout_percentage_bps = finalRolloutPercentageBps
  }

  if (rolloutEnable != null)
    channelPayload.rollout_enabled = !!rolloutEnable
  if (rolloutDisable) {
    bundleLinkChanged = bundleLinkChanged || existingChannel.rollout_version != null
    channelPayload.rollout_enabled = false
    channelPayload.rollout_version = null
    channelPayload.rollout_paused_at = null
    channelPayload.rollout_pause_reason = null
  }

  if (rolloutPause) {
    channelPayload.rollout_paused_at = new Date().toISOString()
    channelPayload.rollout_pause_reason = 'Paused from CLI'
  }

  if (rolloutResume) {
    channelPayload.rollout_paused_at = null
    channelPayload.rollout_pause_reason = null
  }

  if (rolloutRollback) {
    bundleLinkChanged = bundleLinkChanged || existingChannel.rollout_version != null
    channelPayload.rollout_version = null
    channelPayload.rollout_enabled = false
    channelPayload.rollout_percentage_bps = 0
    channelPayload.rollout_paused_at = null
    channelPayload.rollout_pause_reason = null
  }

  if (rolloutPromote) {
    const rolloutVersion = channelPayload.rollout_version ?? existingChannel.rollout_version
    if (!rolloutVersion)
      throw new Error('Cannot promote rollout without a rollout target')

    if (channelPayload.rollout_version == null && !options.ignoreMetadataCheck) {
      const versions = await getActiveAppVersions(options.apikey!, appId, {
        silent,
        apikey: options.apikey!,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      })
      const data = versions.find(v => v.id === rolloutVersion)
      if (!data)
        throw new Error('Cannot find rollout version to promote')

      const { finalCompatibility, localDependencies } = await checkCompatibilityNativePackages(
        supabase,
        appId,
        channel,
        (data.native_packages as any) ?? [],
      )

      const incompatiblePackages = finalCompatibility.filter(item => !isCompatible(item))

      rejectOrAcceptIncompatibleChannelBundle({
        silent,
        acceptIncompatible: options.acceptIncompatible,
        incompatible: localDependencies.length > 0 && incompatiblePackages.length > 0,
        finalCompatibility,
        heading: `Rollout bundle NOT compatible with ${channel} channel`,
        errorMessage: `Rollout bundle is not compatible with ${channel} channel`,
      })
    }

    channelPayload.version = rolloutVersion
    bundleLinkChanged = bundleLinkChanged || existingChannel.version !== rolloutVersion
    channelPayload.rollout_version = null
    channelPayload.rollout_enabled = false
    channelPayload.rollout_percentage_bps = 0
    channelPayload.rollout_paused_at = null
    channelPayload.rollout_pause_reason = null
  }

  assertOptionalIntegerInRange(rolloutCacheTtlSeconds, 'Rollout cache TTL seconds', 60, 31536000)
  assertOptionalIntegerInRange(autoPauseWindowMinutes, 'Auto-pause window minutes', 1, 10080)
  assertOptionalIntegerInRange(autoPauseFailureRateBps, 'Auto-pause failure rate basis points', 0, 10000)
  assertOptionalConfidence(autoPauseConfidence)
  assertOptionalIntegerInRange(autoPauseMinAttempts, 'Auto-pause minimum attempts', 0, Number.MAX_SAFE_INTEGER)
  assertOptionalIntegerInRange(autoPauseMinFailures, 'Auto-pause minimum failures', 0, Number.MAX_SAFE_INTEGER)
  assertOptionalIntegerInRange(autoPauseCooldownMinutes, 'Auto-pause cooldown minutes', 0, 10080)

  if (rolloutCacheTtlSeconds != null)
    channelPayload.rollout_cache_ttl_seconds = rolloutCacheTtlSeconds

  if (autoPauseEnabled != null)
    channelPayload.auto_pause_enabled = !!autoPauseEnabled
  if (autoPauseDisabled)
    channelPayload.auto_pause_enabled = false
  if (autoPauseWindowMinutes != null)
    channelPayload.auto_pause_window_minutes = autoPauseWindowMinutes
  if (autoPauseFailureRateBps !== undefined)
    channelPayload.auto_pause_failure_rate_bps = autoPauseFailureRateBps
  if (autoPauseConfidence != null)
    channelPayload.auto_pause_confidence = autoPauseConfidence as any
  if (autoPauseMinAttempts !== undefined)
    channelPayload.auto_pause_min_attempts = autoPauseMinAttempts
  if (autoPauseMinFailures !== undefined)
    channelPayload.auto_pause_min_failures = autoPauseMinFailures
  if (autoPauseAction != null)
    channelPayload.auto_pause_action = autoPauseAction
  if (autoPauseCooldownMinutes != null)
    channelPayload.auto_pause_cooldown_minutes = autoPauseCooldownMinutes

  if (hasStableBundlePromotion && channelPayload.version == null) {
    if (!silent)
      log.error('Cannot set channel because no bundle version could be resolved')
    throw new Error('Cannot set channel without a bundle version')
  }

  if (state != null) {
    if (state !== 'normal' && state !== 'default') {
      if (!silent)
        log.error(`State ${state} is not known. The possible values are: normal, default.`)
      throw new Error(`Unknown state ${state}. Expected normal or default`)
    }

    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${state}`)

    channelPayload.public = state === 'default'
  }

  if (downgrade != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${downgrade ? 'allow' : 'disallow'} downgrade`)
    channelPayload.disable_auto_update_under_native = !downgrade
  }

  if (ios != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${ios ? 'allow' : 'disallow'} ios update`)
    channelPayload.ios = !!ios
  }

  if (android != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${android ? 'allow' : 'disallow'} android update`)
    channelPayload.android = !!android
  }

  if (selfAssign != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${selfAssign ? 'allow' : 'disallow'} self assign to this channel`)
    channelPayload.allow_device_self_set = !!selfAssign
  }

  if (dev != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${dev ? 'allow' : 'disallow'} dev devices`)
    channelPayload.allow_dev = !!dev
  }

  if (emulator != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${emulator ? 'allow' : 'disallow'} emulator devices`)
    channelPayload.allow_emulator = !!emulator
  }

  if (device != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${device ? 'allow' : 'disallow'} physical devices`)
    channelPayload.allow_device = !!device
  }

  if (prod != null) {
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${prod ? 'allow' : 'disallow'} prod builds`)
    channelPayload.allow_prod = !!prod
  }

  if (disableAutoUpdate != null) {
    let finalDisableAutoUpdate = disableAutoUpdate.toLowerCase()

    if (!disableAutoUpdatesPossibleOptions.includes(finalDisableAutoUpdate)) {
      if (!silent)
        log.error(`Channel strategy ${finalDisableAutoUpdate} is not known. The possible values are: ${disableAutoUpdatesPossibleOptions.join(', ')}.`)
      throw new Error(`Unknown channel strategy ${finalDisableAutoUpdate}`)
    }

    if (finalDisableAutoUpdate === 'metadata')
      finalDisableAutoUpdate = 'version_number'

    channelPayload.disable_auto_update = finalDisableAutoUpdate as any

    if (!silent)
      log.info(`Set ${appId} channel: ${channel} to ${finalDisableAutoUpdate} disable update strategy to this channel`)
  }

  if (updatePackage != null) {
    if (!updatePackagePossibleOptions.includes(updatePackage)) {
      if (!silent)
        log.error(`Update package ${updatePackage} is not known. The possible values are: ${updatePackagePossibleOptions.join(', ')}.`)
      throw new Error(`Unknown update package ${updatePackage}`)
    }
    channelPayload.update_package = updatePackage
    if (!silent)
      log.info(`Set ${appId} channel: ${channel} update package to ${updatePackage}`)
  }

  if (hasStableBundlePromotion && !hasSettingsUpdate) {
    const { error } = await invokeCapgoCliApi('bundle', {
      apikey: options.apikey!,
      method: 'PUT',
      body: {
        app_id: appId,
        version_id: channelPayload.version,
        channel_id: existingChannel.id,
      },
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
    if (error) {
      const packageError = await channelUpdatePackageCliError(error)
      if (packageError) {
        if (!silent)
          log.error(packageError)
        throw new Error(packageError)
      }
      if (!silent)
        log.error('Cannot set channel because this API key does not have the required RBAC permission.')
      throw new Error('API key is not allowed to set this channel')
    }
  }
  else {
    const channelBody: Record<string, unknown> = {
      app_id: appId,
      channel,
    }
    if (channelPayload.version !== undefined)
      channelBody.version = typeof channelPayload.version === 'number' ? undefined : channelPayload.version
    // POST channel expects version as version name string; resolve from id when needed
    if (typeof channelPayload.version === 'number') {
      const versions = await getActiveAppVersions(options.apikey!, appId, {
        silent: true,
        apikey: options.apikey!,
        supaHost: options.supaHost,
        supaAnon: options.supaAnon,
      })
      const matched = versions.find(v => v.id === channelPayload.version)
      if (!matched) {
        if (!silent)
          log.error('Cannot set channel because no bundle version could be resolved')
        throw new Error('Cannot set channel without a bundle version')
      }
      channelBody.version = matched.name
    }
    else if (channelPayload.version === null) {
      channelBody.version = null
    }
    if (channelPayload.public !== undefined)
      channelBody.public = channelPayload.public
    if (channelPayload.disable_auto_update_under_native !== undefined)
      channelBody.disableAutoUpdateUnderNative = channelPayload.disable_auto_update_under_native
    if (channelPayload.disable_auto_update !== undefined)
      channelBody.disableAutoUpdate = channelPayload.disable_auto_update
    if (channelPayload.update_package !== undefined)
      channelBody.updatePackage = channelPayload.update_package
    if (channelPayload.ios !== undefined)
      channelBody.ios = channelPayload.ios
    if (channelPayload.android !== undefined)
      channelBody.android = channelPayload.android
    if (channelPayload.allow_device_self_set !== undefined)
      channelBody.allow_device_self_set = channelPayload.allow_device_self_set
    if (channelPayload.allow_emulator !== undefined)
      channelBody.allow_emulator = channelPayload.allow_emulator
    if (channelPayload.allow_device !== undefined)
      channelBody.allow_device = channelPayload.allow_device
    if (channelPayload.allow_dev !== undefined)
      channelBody.allow_dev = channelPayload.allow_dev
    if (channelPayload.allow_prod !== undefined)
      channelBody.allow_prod = channelPayload.allow_prod
    if (channelPayload.rollout_version !== undefined) {
      if (typeof channelPayload.rollout_version === 'number') {
        const versions = await getActiveAppVersions(options.apikey!, appId, {
          silent: true,
          apikey: options.apikey!,
          supaHost: options.supaHost,
          supaAnon: options.supaAnon,
        })
        const matched = versions.find(v => v.id === channelPayload.rollout_version)
        if (!matched) {
          if (!silent)
            log.error('Cannot set channel because no rollout bundle version could be resolved')
          throw new Error('Cannot set channel without a rollout bundle version')
        }
        channelBody.rolloutVersion = matched.name
      }
      else {
        channelBody.rolloutVersion = channelPayload.rollout_version
      }
    }
    if (channelPayload.rollout_percentage_bps !== undefined)
      channelBody.rolloutPercentageBps = channelPayload.rollout_percentage_bps
    if (channelPayload.rollout_enabled !== undefined)
      channelBody.rolloutEnabled = channelPayload.rollout_enabled
    if (channelPayload.rollout_paused_at !== undefined)
      channelBody.rolloutPausedAt = channelPayload.rollout_paused_at
    if (channelPayload.rollout_pause_reason !== undefined)
      channelBody.rolloutPauseReason = channelPayload.rollout_pause_reason
    if (channelPayload.rollout_cache_ttl_seconds !== undefined)
      channelBody.rolloutCacheTtlSeconds = channelPayload.rollout_cache_ttl_seconds
    if (channelPayload.auto_pause_enabled !== undefined)
      channelBody.autoPauseEnabled = channelPayload.auto_pause_enabled
    if (channelPayload.auto_pause_window_minutes !== undefined)
      channelBody.autoPauseWindowMinutes = channelPayload.auto_pause_window_minutes
    if (channelPayload.auto_pause_failure_rate_bps !== undefined)
      channelBody.autoPauseFailureRateBps = channelPayload.auto_pause_failure_rate_bps
    if (channelPayload.auto_pause_confidence !== undefined)
      channelBody.autoPauseConfidence = channelPayload.auto_pause_confidence
    if (channelPayload.auto_pause_min_attempts !== undefined)
      channelBody.autoPauseMinAttempts = channelPayload.auto_pause_min_attempts
    if (channelPayload.auto_pause_min_failures !== undefined)
      channelBody.autoPauseMinFailures = channelPayload.auto_pause_min_failures
    if (channelPayload.auto_pause_action !== undefined)
      channelBody.autoPauseAction = channelPayload.auto_pause_action
    if (channelPayload.auto_pause_cooldown_minutes !== undefined)
      channelBody.autoPauseCooldownMinutes = channelPayload.auto_pause_cooldown_minutes

    const { error: dbError } = await invokeCapgoCliApi('channel', {
      apikey: options.apikey!,
      method: 'POST',
      body: channelBody,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
    if (dbError) {
      const packageError = await channelUpdatePackageCliError(dbError)
      if (packageError) {
        if (!silent)
          log.error(packageError)
        throw new Error(packageError)
      }
      if (!silent)
        log.error('Cannot set channel because this API key does not have the required RBAC permission.')
      throw new Error('API key is not allowed to set this channel')
    }
  }

  if (sendUpdateNotification && bundleLinkChanged) {
    try {
      await sendUpdateNotificationsForChannels({
        appId,
        apikey: options.apikey,
        channels: [channel],
        silent,
      })
    }
    catch {}
  }

  if (options.qrPreview && !silent) {
    const previewHttp = { apikey: options.apikey!, supaHost: options.supaHost, supaAnon: options.supaAnon }
    const previewTarget = await resolveChannelPreviewTarget(previewHttp, appId, channel)
    if (!previewTarget)
      throw new Error(`Channel ${channel} not found for app ${appId}`)
    await printPreviewQrForResolvedTarget(previewHttp, appId, previewTarget)
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'Set channel',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
    },
  }).catch(() => {})

  if (!silent)
    outro('Done ✅')

  return true
}

export async function setChannel(channel: string, appId: string, options: OptionsSetChannel) {
  return setChannelInternal(channel, appId, options, false)
}
