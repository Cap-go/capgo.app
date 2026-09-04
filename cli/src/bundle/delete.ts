import type { BundleDeleteOptions } from '../schemas/bundle'
import { intro, log, outro } from '@clack/prompts'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { deleteSpecificVersion } from '../api/versions'
import { CliUserError } from '../shared/cli-user-error'
import { createSupabaseClient, findSavedKey, getAppId, getConfig, getOrganizationId, resolveUserIdFromApiKey, sendEvent } from '../utils'

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

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  const host = { supaHost: options.supaHost, supaAnon: options.supaAnon }
  await check2FAComplianceForApp(options.apikey, appId, silent, host)
  await resolveUserIdFromApiKey(supabase, options.apikey, silent, host)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'bundle.delete', silent, true)

  if (!silent) {
    log.info(`Deleting bundle ${appId}@${bundleId} from Capgo`)
    log.info(`Keep in mind that you will not be able to reuse this bundle version, it's gone forever`)
  }

  await deleteSpecificVersion(supabase, appId, bundleId, {
    silent,
    apikey: options.apikey,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  const orgId = await getOrganizationId(options.apikey!, appId, { supaHost: options.supaHost, supaAnon: options.supaAnon })
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
