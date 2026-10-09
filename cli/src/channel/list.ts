import type { OptionsBase } from '../schemas/base'
import { intro, log, outro } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { displayChannels, getActiveChannels } from '../api/channels'
import { CliUserError } from '../shared/cli-user-error'
import { createCapgoClient, findSavedKey, getAppId, getConfig, getOrganizationId, sendEvent } from '../utils'

export async function listChannelsInternal(appId: string, options: OptionsBase, silent = false) {
  if (!silent)
    intro('List channels')

  options.apikey = options.apikey || findSavedKey()
  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    const message = 'Missing API key. Provide an API key with --apikey or log in.'
    if (!silent)
      log.error(message)
    throw new CliUserError(message)
  }

  if (!appId) {
    if (!silent)
      log.error('Missing argument, you need to provide a appId, or be in a capacitor project')
    throw new CliUserError('Missing appId')
  }

  const client = await createCapgoClient(options.apikey, options.apiHost)
  await checkAppExistsAndHasPermissionOrgErr(client, options.apikey, appId, 'app.read_channels', silent)
  const orgId = await getOrganizationId(options.apikey!, appId, { apiHost: options.apiHost })

  if (!silent)
    log.info('Querying available channels in Capgo')

  const allChannels = await getActiveChannels({ apikey: options.apikey!, silent, apiHost: options.apiHost }, appId)

  if (!silent) {
    log.info(`Active channels in Capgo: ${allChannels?.length ?? 0}`)
    displayChannels(allChannels)
  }

  await sendEvent(options.apikey, {
    channel: 'channel',
    event: 'List channel',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appId,
    },
  }).catch(() => {})

  if (!silent)
    outro('Done ✅')

  return allChannels
}

export async function listChannels(appId: string, options: OptionsBase) {
  return listChannelsInternal(appId, options, false)
}
