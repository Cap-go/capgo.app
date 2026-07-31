import type { ChannelCurrentBundleOptions } from '../schemas/channel'
import { intro, log } from '@clack/prompts'
import { trackEvent, withSupabaseSource } from '../analytics/track'
import { check2FAComplianceForApp } from '../api/app'
import {
  createSupabaseClient,
  findSavedKey,
  getAppId,
  getConfig,
  hasCliPermission,
  resolveUserIdFromApiKey,
} from '../utils'

interface Channel {
  id: number
  version: number | null
}

interface CurrentBundleRow {
  bundle_name: string | null
}

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
    throw new Error('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await check2FAComplianceForApp(supabase, appId, silent)
  await resolveUserIdFromApiKey(supabase, options.apikey)

  if (!channel) {
    if (!silent)
      log.error('Please provide a channel to get the bundle from.')
    throw new Error('Channel name missing')
  }

  const { data: supabaseChannel, error } = await withSupabaseSource('channels.currentBundle', () => supabase
    .from('channels')
    .select('id, version')
    .eq('name', channel)
    .eq('app_id', appId)
    .limit(1))

  if (error || !supabaseChannel?.length) {
    if (!silent)
      log.error(`Error retrieving channel ${channel} for app ${appId}. Perhaps the channel does not exist?`)
    throw new Error(`Channel ${channel} not found for app ${appId}`)
  }

  const { id: channelId, version } = supabaseChannel[0] as Channel
  if (!(await hasCliPermission(supabase, options.apikey, 'channel.read', { appId, channelId }))) {
    const msg = `Insufficient permissions for channel ${channel}. Required RBAC permission for this action: channel.read.`
    if (!silent)
      log.error(msg)
    throw new Error(msg)
  }

  void trackEvent({ channel: 'channel', event: 'Channel Current Bundle Viewed', icon: '📦', tags: { has_bundle: Boolean(version) } })

  if (!version) {
    if (!silent)
      log.error(`Error retrieving channel ${channel} for app ${appId}. Perhaps the channel does not exist?`)
    throw new Error(`Channel ${channel} does not have a bundle linked`)
  }

  const { data: bundleRows, error: bundleError } = await withSupabaseSource('channels.currentBundleName', () => supabase
    .rpc('get_channel_current_bundle_rbac' as any, {
      p_app_id: appId,
      p_channel_id: channelId,
    }))

  const bundleName = (bundleRows as CurrentBundleRow[] | null)?.[0]?.bundle_name
  if (bundleError || !bundleName) {
    if (!silent)
      log.error(`Error retrieving current bundle for channel ${channel}.`)
    throw new Error(`Channel ${channel} does not have a readable current bundle`)
  }

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
