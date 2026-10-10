import type { BundleDeleteOptions } from '../schemas/bundle'
import { intro, log, outro } from '@clack/prompts'
import { checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { deleteSpecificVersion } from '../api/versions'
import { CliUserError } from '../shared/cli-user-error'
import { createCapgoClient, findSavedKey, getAppId, getConfig, getOrganizationId, sendEvent } from '../utils'

export async function deleteBundleInternal(bundleId: string, appId: string, options: BundleDeleteOptions, silent = false) {
  if (!silent)
    intro('Delete bundle')

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

  if (!bundleId) {
    if (!silent)
      log.error('Missing argument, you need to provide a bundleId, or be in a capacitor project')
    throw new Error('Missing bundleId')
  }

  const client = await createCapgoClient(options.apikey, options.apiHost)
  await checkAppExistsAndHasPermissionOrgErr(client, options.apikey, appId, 'bundle.delete', silent)

  if (!silent) {
    log.info(`Deleting bundle ${appId}@${bundleId} from Capgo`)
    log.info(`Keep in mind that you will not be able to reuse this bundle version, it's gone forever`)
  }

  await deleteSpecificVersion(client, appId, bundleId, {
    silent,
    apikey: options.apikey,
    apiHost: options.apiHost,
  })

  const orgId = await getOrganizationId(options.apikey!, appId, { apiHost: options.apiHost })
  await sendEvent(options.apikey, {
    channel: 'app',
    event: 'Bundle Deleted',
    org_id: orgId,
    tracking_version: 2,
    tags: { 'app-id': appId, 'bundle': bundleId },
    notifyConsole: true,
  }).catch(() => {})

  if (!silent) {
    log.success(`Bundle ${appId}@${bundleId} deleted in Capgo`)
    outro('Done')
  }

  return true
}

export async function deleteBundle(bundleId: string, appId: string, options: BundleDeleteOptions) {
  return deleteBundleInternal(bundleId, appId, options)
}
