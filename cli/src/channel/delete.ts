import type { ChannelDeleteOptions } from '../schemas/channel'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { delChannel, findChannel, findVersionsLinkedToChannel, isVersionLinkedToOtherChannel } from '../api/channels'
import { deleteAppVersion } from '../api/versions'
import { CliUserError } from '../shared/cli-user-error'
import { createSupabaseClient, findSavedKey, formatError, getAppId, getConfig, getOrganizationId, hasCliPermission, invokeCapgoCliApi, sendEvent } from '../utils'

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
    throw new CliUserError('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await check2FAComplianceForApp(options.apikey, appId, silent, { supaHost: options.supaHost, supaAnon: options.supaAnon })

  const httpOptions = {
    apikey: options.apikey,
    silent,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  }

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
    ? await hasCliPermission(supabase, options.apikey, 'bundle.delete', { appId }, { supaHost: options.supaHost, supaAnon: options.supaAnon })
    : false

  const orgId = await getOrganizationId(options.apikey, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })

  if (options.deleteBundle && !canDeleteBundle) {
    if (!silent)
      log.info(`Deleting preview channel ${appId}#${channelId} and its bundle from Capgo`)

    const { error } = await invokeCapgoCliApi('channel', {
      apikey: options.apikey!,
      method: 'DELETE',
      body: {
        app_id: appId,
        channel: channelId,
        delete_bundle: true,
      },
      supaHost: options.supaHost,
      supaAnon: options.supaAnon,
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

    // App-admin cleanup: soft-delete linked bundles that are not shared, then DELETE the channel.
    // Do not send delete_bundle=true here — that path is preview-key only.
    const softDeletedBundleNames: string[] = []
    if (options.deleteBundle) {
      const linked = await findVersionsLinkedToChannel(supabase, appId, channelId)
      const candidates = [linked.stable, linked.rollout].filter((row): row is NonNullable<typeof row> => !!row?.name)
      const uniqueByName = new Map(candidates.map(row => [row.name, row]))
      for (const bundle of uniqueByName.values()) {
        const shared = await isVersionLinkedToOtherChannel(supabase, appId, bundle.id, channelId)
        if (shared) {
          if (!silent)
            log.info(`Keeping bundle ${bundle.name}; it is still linked to another channel`)
          continue
        }
        if (!silent)
          log.info(`Deleting bundle ${bundle.name} from Capgo`)
        await deleteAppVersion(supabase, appId, bundle.name, {
          silent,
          apikey: options.apikey,
          supaHost: options.supaHost,
          supaAnon: options.supaAnon,
        })
        softDeletedBundleNames.push(bundle.name)
      }
    }

    if (!silent)
      log.info(`Deleting channel ${appId}#${channelId} from Capgo`)

    const deleteStatus = await delChannel(httpOptions, channelId, appId, false)
    if (deleteStatus.error) {
      if (softDeletedBundleNames.length) {
        await supabase
          .from('app_versions')
          .update({ deleted: false })
          .eq('app_id', appId)
          .in('name', softDeletedBundleNames)
      }
      if (!silent)
        log.error(`Cannot delete Channel 🙀 ${formatError(deleteStatus.error)}`)
      throw new Error(`Cannot delete channel: ${formatError(deleteStatus.error)}`)
    }
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'Delete channel',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
      'channel': channelId,
    },
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
