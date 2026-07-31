import type { ChannelDeleteOptions } from '../schemas/channel'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { delChannel, findBundleIdByChannelName, findChannel } from '../api/channels'
import { deleteAppVersion } from '../api/versions'
import {
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getConfig,
  hasCliPermission,
  sendEvent,
} from '../utils'

export async function deleteChannelInternal(channelId: string, appId: string, options: ChannelDeleteOptions, silent = false) {
  if (!silent)
    intro('Delete channel')

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
  await check2FAComplianceForApp(supabase, appId, silent)

  const { data: channel, error: channelError } = await findChannel(supabase, appId, channelId)
  if (channelError || !channel) {
    if (!silent)
      log.error(`Channel ${channelId} not found`)

    if (options.successIfNotFound) {
      if (!silent)
        log.success(`Channel ${channelId} not found and successIfNotFound is true`)
      return true
    }

    throw new Error(`Channel ${channelId} not found`)
  }
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'channel.delete', silent, true, channel.id)
  const canDeleteBundle = options.deleteBundle
    ? await hasCliPermission(supabase, options.apikey, 'bundle.delete', { appId })
    : false

  const orgId = channel.owner_org
  if (!orgId) {
    if (!silent)
      log.error(`Channel ${channelId} has no owner organization`)
    throw new Error(`Channel ${channelId} has no owner organization`)
  }

  if (options.deleteBundle && !canDeleteBundle) {
    if (!silent)
      log.info(`Deleting preview channel ${appId}#${channelId} and its bundle from Capgo`)

    const { error } = await supabase.functions.invoke('channel', {
      method: 'DELETE',
      body: JSON.stringify({
        app_id: appId,
        channel: channelId,
        delete_bundle: true,
      }),
    })
    if (error) {
      const message = `Cannot delete preview channel and bundle: ${formatError(error)}`
      if (!silent)
        log.error(message)
      throw new Error(message)
    }
  }
  else {
    if (options.deleteBundle && !silent)
      log.info(`Deleting bundle ${appId}#${channelId} from Capgo`)

    if (options.deleteBundle) {
      const bundle = await findBundleIdByChannelName(supabase, appId, channelId)
      if (bundle?.name && !silent)
        log.info(`Deleting bundle ${bundle.name} from Capgo`)
      if (bundle?.name)
        await deleteAppVersion(supabase, appId, bundle.name)
    }

    if (!silent)
      log.info(`Deleting channel ${appId}#${channelId} from Capgo`)

    const deleteStatus = await delChannel(supabase, channelId, appId)
    if (deleteStatus.error) {
      if (!silent)
        log.error(`Cannot delete Channel 🙀 ${formatError(deleteStatus.error)}`)
      throw new Error(`Cannot delete channel: ${formatError(deleteStatus.error)}`)
    }
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'Delete channel',
    icon: '✅',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
      'channel': channelId,
    },
    notify: false,
  }).catch(() => {})

  if (!silent) {
    log.success('Channel deleted')
    outro('Done ✅')
  }

  return true
}

export async function deleteChannel(channelId: string, appId: string, options: ChannelDeleteOptions) {
  return deleteChannelInternal(channelId, appId, options, false)
}
