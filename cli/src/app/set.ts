import type { Buffer } from 'node:buffer'
import type { Options } from '../api/app'
import { existsSync, readFileSync } from 'node:fs'
import { intro, log, outro } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr, resolveAppSetIconPath, uploadAppIconHttp } from '../api/app'
import { assertChannelExists, disableDownloadChannels as disableAllDownloadChannels, setDefaultDownloadChannel } from './default-channels'
import { normalizeStoreUrl } from './store-url'
import { CliUserError } from '../shared/cli-user-error'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  getContentType,
  getOrganizationId,
  invokeCapgoCliApi,
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
    throw new CliUserError('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.update_settings', silent)
  const organizationUid = await getOrganizationId(options.apikey!, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })

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
  else if (retention && retention > 730) {
    if (!silent)
      log.error('retention value cannot be greater than 730 days (2 years)')
    throw new Error('Retention value cannot be greater than 730 days (2 years)')
  }

  if (buildTimeoutMinutes != null) {
    const normalizedMinutes = Math.trunc(Number(buildTimeoutMinutes))
    if (!Number.isFinite(normalizedMinutes) || normalizedMinutes < MIN_BUILD_TIMEOUT_MINUTES || normalizedMinutes > MAX_BUILD_TIMEOUT_MINUTES) {
      if (!silent)
        log.error(`build timeout must be between ${MIN_BUILD_TIMEOUT_MINUTES} and ${MAX_BUILD_TIMEOUT_MINUTES} minutes`)
      throw new Error('Invalid build timeout minutes')
    }
  }

  const channelHttp = {
    apikey: options.apikey!,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  }

  if (defaultUploadChannel)
    await assertChannelExists(channelHttp, appId, defaultUploadChannel)

  if (disableDownloadChannels && defaultDownloadChannel) {
    if (!silent)
      log.error('Cannot set --default-download-channel and --disable-download-channels at the same time')
    throw new Error('Cannot set default download channel and disable download channels at the same time')
  }


  if (defaultDownloadChannel)
    await assertChannelExists(channelHttp, appId, defaultDownloadChannel)

  let normalizedIosStoreUrl: string | null | undefined
  let normalizedAndroidStoreUrl: string | null | undefined
  if (iosStoreUrl !== undefined)
    normalizedIosStoreUrl = normalizeStoreUrl(iosStoreUrl, 'apps.apple.com')
  if (androidStoreUrl !== undefined)
    normalizedAndroidStoreUrl = normalizeStoreUrl(androidStoreUrl, 'play.google.com')

  let iconBuff: Buffer | undefined
  let iconType: string | undefined
  let iconUrl: string | undefined

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
    const uploadResult = await uploadAppIconHttp(options.apikey!, {
      appId,
      orgId: organizationUid,
      contentBase64: iconBuff.toString('base64'),
      contentType: iconType,
      upsert: true,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })

    if (uploadResult.error || !uploadResult.path) {
      if (!silent)
        log.error(`Could not set app ${formatError(uploadResult.error)}`)
      throw new Error(`Could not set app: ${formatError(uploadResult.error)}`)
    }

    iconUrl = uploadResult.path
  }

  const putBody: Record<string, unknown> = {}
  if (iconBuff && iconType)
    putBody.icon = iconUrl
  if (name != null)
    putBody.name = name
  if (retention != null)
    putBody.retention = retention * 24 * 60 * 60
  if (exposeMetadata != null)
    putBody.expose_metadata = exposeMetadata
  if (allowDeviceCustomId != null)
    putBody.allow_device_custom_id = allowDeviceCustomId
  if (blockProviderInfraRequests != null)
    putBody.block_provider_infra_requests = blockProviderInfraRequests
  if (preview != null)
    putBody.allow_preview = preview
  if (buildTimeoutMinutes != null)
    putBody.build_timeout_seconds = Math.trunc(Number(buildTimeoutMinutes)) * 60
  if (defaultUploadChannel != null)
    putBody.default_upload_channel = defaultUploadChannel
  if (iosStoreUrl !== undefined)
    putBody.ios_store_url = normalizedIosStoreUrl
  if (androidStoreUrl !== undefined)
    putBody.android_store_url = normalizedAndroidStoreUrl

  if (Object.keys(putBody).length > 0) {
    const { error: putError } = await invokeCapgoCliApi(`app/${encodeURIComponent(appId)}`, {
      apikey: options.apikey!,
      method: 'PUT',
      body: putBody,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
    })
    if (putError) {
      if (!silent)
        log.error(`Could not set app ${formatError(putError)}`)
      throw new Error(`Could not set app: ${formatError(putError)}`)
    }
  }

  if (disableDownloadChannels)
    await disableAllDownloadChannels(channelHttp, appId)
  else if (defaultDownloadChannel)
    await setDefaultDownloadChannel(channelHttp, appId, defaultDownloadChannel)

  await sendEvent(options.apikey, {
    channel: 'app',
    event: 'App Updated',
    icon: '📝',
    org_id: organizationUid,
    tracking_version: 2,
    tags: { 'app-id': appId },
    notifyConsole: true,
  }).catch(() => {})

  if (!silent)
    outro('Done ✅')

  return true
}

export async function setApp(appId: string, options: Options) {
  return setAppInternal(appId, options)
}
