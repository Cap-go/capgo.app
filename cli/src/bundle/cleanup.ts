import type { SemVer } from '@std/semver'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { BundleCleanupOptions } from '../schemas/bundle'
import type { Database } from '../types/supabase.types'
import { confirm as confirmC, intro, isCancel, log, outro } from '@clack/prompts'
import {
  format,
  greaterThan,
  increment,
  lessThan,
  parse,
} from '@std/semver'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { checkAlerts } from '../api/update'
import { deleteSpecificVersion, displayBundles, getActiveAppVersions, getChannelsVersion } from '../api/versions'
import {
  createSupabaseClient,
  findSavedKey,
  getAppId,
  getConfig,
  getHumanDate,
  resolveUserIdFromApiKey,
} from '../utils'

async function removeVersions(
  toRemove: Database['public']['Tables']['app_versions']['Row'][],
  supabase: SupabaseClient<Database>,
  appId: string,
  silent: boolean,
) {
  for await (const row of toRemove) {
    if (!silent)
      log.warn(`Removing ${row.name} created on ${getHumanDate(row.created_at)}`)
    await deleteSpecificVersion(supabase, appId, row.name)
  }
}

function getRemovableVersionsInSemverRange(
  data: Database['public']['Tables']['app_versions']['Row'][],
  bundleVersion: SemVer,
  nextMajorVersion: SemVer,
) {
  const toRemove: Database['public']['Tables']['app_versions']['Row'][] = []

  for (const row of data ?? []) {
    const rowVersion = parse(row.name)
    if (greaterThan(rowVersion, bundleVersion) && lessThan(rowVersion, nextMajorVersion))
      toRemove.push(row)
  }

  return toRemove
}

export async function cleanupBundleInternal(appId: string, options: BundleCleanupOptions, silent = false) {
  if (!silent)
    intro('Cleanup versions in Capgo')

  await checkAlerts()

  options.apikey = options.apikey || findSavedKey()
  const { bundle, keep = 4 } = options
  const force = options.force || false
  const ignoreChannel = options.ignoreChannel || false

  const extConfig = await getConfig()
  appId = getAppId(appId, extConfig?.config)

  if (!options.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to delete your app')
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
  await checkAppExistsAndHasPermissionOrgErr(supabase, options.apikey, appId, 'bundle.delete', silent, true)

  if (!silent)
    log.info('Querying all available versions in Capgo')

  let allVersions: (Database['public']['Tables']['app_versions']['Row'] & { keep?: string })[] = await getActiveAppVersions(supabase, appId)
  const versionInUse = await getChannelsVersion(supabase, appId)

  if (!silent)
    log.info(`Total active versions in Capgo: ${allVersions?.length ?? 0}`)

  if (!allVersions?.length) {
    if (!silent)
      log.error('No versions found, aborting cleanup')
    throw new Error('No versions found')
  }

  if (bundle) {
    const bundleVersion = parse(bundle)
    const nextMajorVersion = increment(bundleVersion, 'major')

    if (!silent)
      log.info(`Querying available versions in Capgo between ${format(bundleVersion)} and ${format(nextMajorVersion)}`)

    allVersions = getRemovableVersionsInSemverRange(allVersions, bundleVersion, nextMajorVersion) as (Database['public']['Tables']['app_versions']['Row'] & { keep: string })[]

    if (!silent)
      log.info(`Active versions in Capgo between ${format(bundleVersion)} and ${format(nextMajorVersion)}: ${allVersions?.length ?? 0}`)
  }

  const toRemove: (Database['public']['Tables']['app_versions']['Row'] & { keep?: string })[] = []
  let kept = 0

  for (const v of allVersions) {
    const isInUse = versionInUse.find(vi => vi === v.id)

    if (kept < keep || (isInUse && !ignoreChannel)) {
      v.keep = isInUse ? '✅ (Linked to channel)' : '✅'
      kept += 1
    }
    else {
      v.keep = '❌'
      toRemove.push(v)
    }
  }

  if (!toRemove.length) {
    if (!silent)
      log.warn('Nothing to be removed, aborting removal...')
    return { removed: 0, kept }
  }

  if (!silent)
    displayBundles(allVersions)

  if (!force) {
    if (!silent) {
      const doDelete = await confirmC({ message: 'Do you want to continue removing the versions specified?' })
      if (isCancel(doDelete) || !doDelete) {
        log.warn('Not confirmed, aborting removal...')
        throw new Error('Cleanup cancelled by user')
      }
    }
    else {
      throw new Error('Cleanup requires force=true in SDK mode to prevent accidental deletions')
    }
  }

  if (!silent)
    log.success('You have confirmed removal, removing versions now')

  await removeVersions(toRemove, supabase, appId, silent)

  void trackEvent({ channel: 'bundle', event: 'Bundles Cleaned', icon: '🧹', tags: { kept_count: kept, deleted_count: toRemove.length } })

  if (!silent)
    outro('Done ✅')

  return { removed: toRemove.length, kept }
}

export async function cleanupBundle(appId: string, options: BundleCleanupOptions) {
  return cleanupBundleInternal(appId, options)
}
