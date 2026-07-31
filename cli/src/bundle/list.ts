import type { OptionsBase } from '../schemas/base'
import { intro, log, outro } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { checkAlerts } from '../api/update'
import { displayBundles, getActiveAppVersions } from '../api/versions'
import { createSupabaseClient, findSavedKey, getAppId, getConfig, resolveUserIdFromApiKey } from '../utils'

export async function listBundle(appId: string, options: OptionsBase, silent = false) {
  if (!silent)
    intro('List bundles')

  await checkAlerts()
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
      log.error('Missing argument, you need to provide a appid, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(options.apikey, options.supaHost, options.supaAnon)
  await check2FAComplianceForApp(supabase, appId, silent)
  await resolveUserIdFromApiKey(supabase, options.apikey)
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'app.read_bundles', silent, true)

  if (!silent)
    log.info(`Querying available versions of: ${appId} in Capgo`)

  const allVersions = await getActiveAppVersions(supabase, appId)

  void trackEvent({ channel: 'bundle', event: 'Bundles Listed', icon: '📋', tags: { bundle_count: allVersions?.length ?? 0 } })

  if (!silent) {
    log.info(`Active versions in Capgo: ${allVersions?.length ?? 0}`)
    displayBundles(allVersions)
    outro('Done ✅')
  }

  return allVersions
}
