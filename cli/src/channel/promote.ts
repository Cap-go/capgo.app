import type { ChannelPromoteOptions } from '../schemas/channel'
import { intro, log, outro } from '@clack/prompts'
import { CliUserError } from '../shared/cli-user-error'
import { findSavedKey, formatError, getAppId, getConfig } from '../utils'
import { currentBundleInternal } from './currentBundle'
import { setChannelInternal } from './set'

export interface PromoteChannelResult {
  bundle: string
  fromChannel: string
  toChannel: string
}

/**
 * Link the bundle currently served by `fromChannel` to `toChannel`.
 * Reuses `channel set --bundle` so compatibility checks and RBAC stay identical.
 */
export async function promoteChannelInternal(
  fromChannel: string,
  toChannel: string,
  appId: string,
  options: ChannelPromoteOptions,
  silent = false,
): Promise<PromoteChannelResult> {
  if (!silent)
    intro('Promote channel')

  if (!fromChannel || !toChannel) {
    if (!silent)
      log.error('Missing argument, you need to provide a source and a target channel, for example: channel promote staging production')
    throw new CliUserError('Missing source or target channel')
  }

  if (fromChannel === toChannel) {
    if (!silent)
      log.error('Source and target channels must be different')
    throw new CliUserError('Source and target channels must be different')
  }

  options.apikey = options.apikey || findSavedKey(silent)
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to promote a channel')
    throw new CliUserError('Missing API key')
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new CliUserError('Missing appId')
  }

  let bundle: string
  try {
    bundle = await currentBundleInternal(fromChannel, appId, {
      apikey: options.apikey,
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
      quiet: true,
    }, true)
  }
  catch (error) {
    if (!silent)
      log.error(`Cannot read the bundle linked to channel ${fromChannel}: ${formatError(error)}`)
    throw error
  }

  if (!silent)
    log.info(`Promoting bundle ${bundle} from channel ${fromChannel} to channel ${toChannel}`)

  await setChannelInternal(toChannel, appId, {
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
    bundle,
    ignoreMetadataCheck: options.ignoreMetadataCheck,
    acceptIncompatible: options.acceptIncompatible,
    sendUpdateNotification: options.sendUpdateNotification,
  }, silent, false)

  if (!silent)
    outro(`Channel ${toChannel} now serves bundle ${bundle} ✅`)

  return { bundle, fromChannel, toChannel }
}

export async function promoteChannel(fromChannel: string, toChannel: string, appId: string, options: ChannelPromoteOptions) {
  await promoteChannelInternal(fromChannel, toChannel, appId, options, false)
}
