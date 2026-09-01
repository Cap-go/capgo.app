import type { ChannelCurrentBundleOptions } from '../schemas/channel'
import { intro, log } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp } from '../api/app'
import { CliUserError } from '../shared/cli-user-error'
import {
  fetchChannelCurrentBundleViaHttp,
  findSavedKey,
  formatCapgoCliApiError,
  getAppId,
  getCapgoCliHttpStatus,
  getConfig,
  readCapgoCliApiErrorPayload,
  resolveUserIdFromApiKey,
} from '../utils'

export async function currentBundleInternal(channel: string, appId: string, options: ChannelCurrentBundleOptions, silent = false) {
  const { quiet } = options

  if (!quiet && !silent)
    intro('List current bundle')

  options.apikey = options.apikey || findSavedKey(quiet)
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to upload your bundle')
    throw new CliUserError('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new CliUserError('Missing appId')
  }

  const host = { supaHost: options.supaHost, supaAnon: options.supaAnon }
  await check2FAComplianceForApp(options.apikey, appId, silent, host)
  await resolveUserIdFromApiKey(null, options.apikey, silent, host)

  if (!channel) {
    if (!silent)
      log.error('Please provide a channel to get the bundle from.')
    throw new CliUserError('Channel name missing')
  }

  const { data, error } = await fetchChannelCurrentBundleViaHttp(options.apikey, appId, channel, host)
  if (error) {
    const status = getCapgoCliHttpStatus(error)
    const payload = await readCapgoCliApiErrorPayload(error)
    const code = payload?.error

    if (status === 401) {
      if (!silent)
        log.error(`Insufficient permissions for channel ${channel}. Required RBAC permission for this action: channel.read.`)
      throw new CliUserError('Insufficient permissions for channel. Required RBAC permission for this action: channel.read.', { appId, channel })
    }
    if (status === 404 && code === 'channel_has_no_bundle') {
      if (!silent)
        log.error(`Error retrieving channel ${channel} for app ${appId}. Perhaps the channel does not exist?`)
      throw new CliUserError('Channel does not have a bundle linked', { appId, channel })
    }
    if (status === 404 && code === 'channel_not_found') {
      if (!silent)
        log.error(`Error retrieving channel ${channel} for app ${appId}. Perhaps the channel does not exist?`)
      throw new CliUserError('Channel not found for app', { appId, channel })
    }
    if (status === 404 && code === 'channel_bundle_unreadable') {
      if (!silent)
        log.error(`Error retrieving current bundle for channel ${channel}.`)
      throw new CliUserError('Channel does not have a readable current bundle', { appId, channel })
    }
    const message = await formatCapgoCliApiError(error)
    if (!silent)
      log.error(message)
    throw new CliUserError(message, { appId, channel })
  }

  const bundleName = data?.bundle_name
  if (!bundleName) {
    if (!silent)
      log.error(`Error retrieving current bundle for channel ${channel}.`)
    throw new CliUserError('Channel does not have a readable current bundle', { appId, channel })
  }

  void trackEvent({ channel: 'channel', event: 'Channel Current Bundle Viewed', tags: { has_bundle: true } })

  if (!silent) {
    if (!quiet)
      log.info(`Current bundle for channel ${channel} is ${bundleName}`)
    else
      log.info(bundleName)
  }

  return bundleName
}

export async function currentBundle(channel: string, appId: string, options: ChannelCurrentBundleOptions) {
  return currentBundleInternal(channel, appId, options)
}
