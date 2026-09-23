import type { ChannelCurrentBundleOptions } from '../schemas/channel'
import { intro, log } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp } from '../api/app'
import { CliUserError } from '../shared/cli-user-error'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  invokeCapgoCliApi,
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

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await check2FAComplianceForApp(supabase, appId, silent)
  await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!channel) {
    if (!silent)
      log.error('Please provide a channel to get the bundle from.')
    throw new CliUserError('Channel name missing')
  }

  const params = new URLSearchParams({
    app_id: appId,
    channel,
  })
  const { data, error } = await invokeCapgoCliApi<{ bundle_name?: string }>(`channel/current-bundle?${params.toString()}`, {
    apikey: options.apikey,
    method: 'GET',
    body: undefined,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  const bundleName = data?.bundle_name
  if (error || !bundleName) {
    if (!silent)
      log.error(`Error retrieving current bundle for channel ${channel}.`)
    throw new CliUserError('Channel does not have a readable current bundle', { appId, channel, cause: error ? formatError(error) : undefined })
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
