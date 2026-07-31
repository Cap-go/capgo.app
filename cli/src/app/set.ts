import type { Buffer } from 'node:buffer'
import type { Options } from '../api/app'
import type { Database } from '../types/supabase.types'
import { existsSync, readFileSync } from 'node:fs'
import { intro, log, outro } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr, defaultAppIconPath, getAppIconStoragePath, resolveAppSetIconPath } from '../api/app'
import { assertChannelExists, disableDownloadChannels as disableAllDownloadChannels, setDefaultDownloadChannel } from './default-channels'
import { normalizeStoreUrl } from './store-url'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  getContentType,
  getOrganizationId,
  sendEvent,
} from '../utils'


const MIN_BUILD_TIMEOUT_MINUTES = 5
const MAX_BUILD_TIMEOUT_MINUTES = 360

export async function setAppInternal(appId: string, options: Options, silent = false) {
  if (!silent)
    intro('Set app')

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
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.update_settings', silent)
  const organizationUid = await getOrganizationId(supabase, appId)

  const {
    name,
    icon,
    retention,
    exposeMetadata,
    preview,
    allowDeviceCustomId,
    blockProviderInfraRequests,
    buildTimeoutMinutes,
    iosStoreUrl,
    androidStoreUrl,
    defaultUploadChannel,
    defaultDownloadChannel,
    disableDownloadChannels,
  } = options


  if (retention && Number.isNaN(Number(retention))) {
    if (!silent)
      log.error('retention value must be a number')
    throw new Error('Retention value must be a number')
  }
  else if (retention && retention < 0) {
    if (!silent)
      log.error('retention value cannot be less than 0')
    throw new Error('Retention value cannot be less than 0')
  }
  else if (retention && retention >= 63113904) {
    if (!silent)
      log.error('retention value cannot be greater than 63113904 seconds (2 years)')
    throw new Error('Retention value cannot be greater than 63113904 seconds (2 years)')
  }

  if (buildTimeoutMinutes != null) {
    const normalizedMinutes = Math.trunc(Number(buildTimeoutMinutes))
    if (!Number.isFinite(normalizedMinutes) || normalizedMinutes < MIN_BUILD_TIMEOUT_MINUTES || normalizedMinutes > MAX_BUILD_TIMEOUT_MINUTES) {
      if (!silent)
        log.error(`build timeout must be between ${MIN_BUILD_TIMEOUT_MINUTES} and ${MAX_BUILD_TIMEOUT_MINUTES} minutes`)
      throw new Error('Invalid build timeout minutes')
    }
  }

  if (defaultUploadChannel)
    await assertChannelExists(supabase, appId, defaultUploadChannel)

  if (disableDownloadChannels && defaultDownloadChannel) {
    if (!silent)
      log.error('Cannot set --default-download-channel and --disable-download-channels at the same time')
    throw new Error('Cannot set default download channel and disable download channels at the same time')
  }


  if (defaultDownloadChannel)
    await assertChannelExists(supabase, appId, defaultDownloadChannel)

  let normalizedIosStoreUrl: string | null | undefined
  let normalizedAndroidStoreUrl: string | null | undefined
  if (iosStoreUrl !== undefined)
    normalizedIosStoreUrl = normalizeStoreUrl(iosStoreUrl, 'apps.apple.com')
  if (androidStoreUrl !== undefined)
    normalizedAndroidStoreUrl = normalizeStoreUrl(androidStoreUrl, 'play.google.com')

  let iconBuff: Buffer | undefined
  let iconType: string | undefined
  const iconPath = getAppIconStoragePath(organizationUid, appId)
  let iconUrl: string | undefined = defaultAppIconPath

  const iconToUpload = resolveAppSetIconPath(icon)
  if (iconToUpload) {
    if (!existsSync(iconToUpload)) {
      if (!silent)
        log.error(`Cannot find app icon at ${iconToUpload}`)
      throw new Error(`Cannot find app icon at ${iconToUpload}`)
    }

    iconBuff = readFileSync(iconToUpload)
    const contentType = getContentType(iconToUpload)
    iconType = contentType || 'image/png'
    if (!silent)
      log.warn(`Found app icon ${iconToUpload}`)
  }

  if (iconBuff && iconType) {
    const { error } = await supabase.storage
      .from('images')
      .upload(iconPath, iconBuff, {
        contentType: iconType,
        upsert: true,
      })

    if (error) {
      if (!silent)
        log.error(`Could not set app ${formatError(error)}`)
      throw new Error(`Could not set app: ${formatError(error)}`)
    }

    iconUrl = iconPath
  }

  const appUpdate: Database['public']['Tables']['apps']['Update'] = {}
  if (iconBuff && iconType)
    appUpdate.icon_url = iconUrl
  if (name != null)
    appUpdate.name = name
  if (retention != null)
    appUpdate.retention = retention * 24 * 60 * 60
  if (exposeMetadata != null)
    appUpdate.expose_metadata = exposeMetadata
  if (preview != null)
    appUpdate.allow_preview = preview
  if (allowDeviceCustomId != null)
    appUpdate.allow_device_custom_id = allowDeviceCustomId
  if (blockProviderInfraRequests != null)
    appUpdate.block_provider_infra_requests = blockProviderInfraRequests
  if (buildTimeoutMinutes != null)
    appUpdate.build_timeout_seconds = Math.trunc(Number(buildTimeoutMinutes)) * 60
  if (iosStoreUrl !== undefined)
    appUpdate.ios_store_url = normalizedIosStoreUrl
  if (androidStoreUrl !== undefined)
    appUpdate.android_store_url = normalizedAndroidStoreUrl
  if (defaultUploadChannel != null)
    appUpdate.default_upload_channel = defaultUploadChannel

  const { error: dbError } = Object.keys(appUpdate).length === 0 && !defaultDownloadChannel && disableDownloadChannels == null
    ? { error: null }
    : await supabase
      .from('apps')
      .update(appUpdate)
      .eq('app_id', appId)

  if (dbError) {
    if (!silent)
      log.error(`Could not set app ${formatError(dbError)}`)
    throw new Error(`Could not set app: ${formatError(dbError)}`)
  }

  if (disableDownloadChannels)
    await disableAllDownloadChannels(supabase, appId)
  else if (defaultDownloadChannel)
    await setDefaultDownloadChannel(supabase, appId, defaultDownloadChannel)

  await sendEvent(options.apikey, {
    channel: 'app',
    event: 'App Updated',
    icon: '📝',
    org_id: organizationUid,
    tracking_version: 2,
    tags: { 'app-id': appId },
    notify: false,
    notifyConsole: true,
  }).catch(() => {})

  if (!silent)
    outro('Done ✅')

  return true
}

export async function setApp(appId: string, options: Options) {
  return setAppInternal(appId, options)
}
