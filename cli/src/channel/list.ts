import type { OptionsBase } from '../schemas/base'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { displayChannels, getActiveChannels } from '../api/channels'
import { createSupabaseClient, findSavedKey, getAppId, getConfig, getOrganizationId, sendEvent } from '../utils'

export async function listChannelsInternal(appId: string, options: OptionsBase, silent = false) {
  if (!silent)
    intro('List channels')

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
  const orgId = await getOrganizationId(supabase, appId)

  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read_channels', silent, true)

  if (!silent)
    log.info('Querying available channels in Capgo')

  const allChannels = await getActiveChannels(supabase, appId)

  if (!silent) {
    log.info(`Active channels in Capgo: ${allChannels?.length ?? 0}`)
    displayChannels(allChannels)
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'List channel',
    icon: '✅',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
    },
    notify: false,
  }).catch(() => {})

  if (!silent)
    outro('Done ✅')

  return allChannels
}

export async function listChannels(appId: string, options: OptionsBase) {
  return listChannelsInternal(appId, options, false)
}
