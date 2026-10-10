import { intro, log, outro } from '@clack/prompts'
import { checkVersionNotUsedInChannel } from '../api/channels'
import { runCliPreflight } from '../api/preflight'
import { getVersionData } from '../api/versions'
import { CliUserError } from '../shared/cli-user-error'
import {
  createCapgoClient,
  findSavedKey,
  formatError,
  getAppId,
  getBundleVersion,
  getConfig,
  getOrganizationId,
  sendEvent,
} from '../utils'

interface BundleUnlinkOptions {
  bundle?: string
  packageJson?: string
  apikey?: string
  apiHost?: string
}

export async function unlinkDeviceInternal(
  channel: string,
  appId: string,
  options: BundleUnlinkOptions,
  silent = false,
) {
  if (!silent)
    intro('Unlink bundle')

  try {
    const enrichedOptions: BundleUnlinkOptions = {
      ...options,
      apikey: options.apikey || findSavedKey(),
    }

    const packVersion = getBundleVersion('', options.packageJson)
    const needsProjectConfig = !appId || (!enrichedOptions.bundle && !packVersion)
    const extConfig = needsProjectConfig ? await getConfig(silent) : undefined
    const resolvedAppId = getAppId(appId, extConfig?.config)
    const bundle = enrichedOptions.bundle
      || extConfig?.config?.plugins?.CapacitorUpdater?.version
      || packVersion

    if (!enrichedOptions.apikey) {
      if (!silent)
        log.error('Missing API key, you need to provide an API key to upload your bundle')
      throw new Error('Missing API key')
    }

    if (!resolvedAppId) {
      if (!silent)
        log.error('Missing argument, you need to provide an appId, or be in a capacitor project')
      throw new CliUserError('Missing appId')
    }

    if (!bundle) {
      if (!silent)
        log.error('Missing argument, you need to provide a bundle, or be in a capacitor project')
      throw new Error('Missing bundle')
    }

    if (!channel) {
      if (!silent)
        log.error('Missing argument, you need to provide a channel')
      throw new Error('Missing channel')
    }

    const client = await createCapgoClient(
      enrichedOptions.apikey,
      enrichedOptions.apiHost,
    )
    const preflight = await runCliPreflight(client, {
      appId: resolvedAppId,
      permission: 'bundle.delete',
      plan: 'all',
    }, {
      silent,
      permissionDeniedMessage: `Insufficient permissions for app ${resolvedAppId}. Required RBAC permission for this action: bundle.delete.`,
    })
    const orgId = preflight?.orgId ?? await getOrganizationId(enrichedOptions.apikey!, resolvedAppId, { apiHost: enrichedOptions.apiHost })

    const versionData = await getVersionData(enrichedOptions.apikey!, resolvedAppId, bundle, {
      silent,
      apikey: enrichedOptions.apikey!,
      apiHost: enrichedOptions.apiHost,
    })
    await checkVersionNotUsedInChannel(client, resolvedAppId, versionData, {
      silent,
      autoUnlink: true,
      channelName: channel,
      requireMatch: true,
      apikey: enrichedOptions.apikey!,
      apiHost: enrichedOptions.apiHost,
    })

    await sendEvent(enrichedOptions.apikey, {
      channel: 'bundle',
      event: 'Unlink bundle',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': resolvedAppId,
      },
    }).catch(() => {})

    if (!silent)
      outro('Done ✅')

    return true
  }
  catch (error) {
    if (!silent)
      log.error(`Unknown error ${formatError(error)}`)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

export async function unlinkDevice(channel: string, appId: string, options: BundleUnlinkOptions) {
  await unlinkDeviceInternal(channel, appId, options, false)
}
