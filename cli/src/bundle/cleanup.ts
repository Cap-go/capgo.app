import type { CleanupBundleRow, CleanupBundlesResult } from '../api/versions'
import type { BundleCleanupOptions } from '../schemas/bundle'
import { confirm as confirmC, intro, isCancel, log, outro } from '@clack/prompts'
import { format, increment, parse } from '@std/semver'
import { trackEvent } from '../analytics/track'
import { checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { checkAlerts } from '../api/update'
import { cleanupAppVersions, displayBundles } from '../api/versions'
import { CliUserError } from '../shared/cli-user-error'
import {
  createCapgoClient,
  findSavedKey,
  getAppId,
  getConfig,
  getHumanDate,
} from '../utils'

function toDisplayRows(kept: CleanupBundleRow[], removed: CleanupBundleRow[]) {
  return [
    ...kept.map(row => ({ ...row, keep: row.linked ? '✅ (Linked to channel)' : '✅' })),
    ...removed.map(row => ({ ...row, keep: '❌' })),
  ].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
}

function nothingToRemove(result: CleanupBundlesResult, silent: boolean) {
  if (!result.active) {
    if (!silent)
      log.error('No versions found, aborting cleanup')
    throw new Error('No versions found')
  }
  if (result.removed.length)
    return null
  if (!silent)
    log.warn('Nothing to be removed, aborting removal...')
  return { removed: 0, kept: result.kept.length }
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
    throw new CliUserError('Missing appId')
  }

  const client = await createCapgoClient(options.apikey, options.apiHost)
  await checkAppExistsAndHasPermissionOrgErr(client, options.apikey, appId, 'bundle.delete', silent)

  if (bundle) {
    const bundleVersion = parse(bundle)
    if (!silent)
      log.info(`Cleaning versions in Capgo between ${format(bundleVersion)} and ${format(increment(bundleVersion, 'major'))}`)
  }

  // The API selects (and, once confirmed, soft-deletes) the bundles itself: no client-side
  // listing of every bundle and no per-bundle round trips.
  const http = { apikey: options.apikey, silent, apiHost: options.apiHost }
  const request = { keep, bundle, ignoreChannel }

  let confirmedIds: number[] | undefined
  if (!force) {
    if (!silent)
      log.info('Querying available versions in Capgo')
    const plan = await cleanupAppVersions(appId, { ...request, dryRun: true }, http)
    if (!silent)
      log.info(`Total active versions in Capgo: ${plan.active}${bundle ? ` (${plan.total} in range)` : ''}`)
    const nothing = nothingToRemove(plan, silent)
    if (nothing)
      return nothing
    if (silent)
      throw new Error('Cleanup requires force=true in SDK mode to prevent accidental deletions')

    displayBundles(toDisplayRows(plan.kept, plan.removed))
    const doDelete = await confirmC({ message: `Do you want to continue removing the ${plan.removed.length} versions specified?` })
    if (isCancel(doDelete) || !doDelete) {
      log.warn('Not confirmed, aborting removal...')
      throw new CliUserError('Cleanup cancelled by user')
    }
    log.success('You have confirmed removal, removing versions now')
    // Delete exactly what was shown, never a set recomputed after the prompt.
    confirmedIds = plan.removed.map(row => row.id)
  }

  const result = await cleanupAppVersions(appId, { ...request, dryRun: false, ids: confirmedIds }, http)
  const nothing = nothingToRemove(result, silent)
  if (nothing)
    return nothing
  if (!silent) {
    for (const row of result.removed)
      log.warn(`Removed ${row.name} created on ${getHumanDate(row.created_at)}`)
  }
  const kept = result.kept.length
  const removed = result.removed.length

  void trackEvent({ channel: 'bundle', event: 'Bundles Cleaned', tags: { kept_count: kept, deleted_count: removed } })

  if (!silent)
    outro('Done ✅')

  return { removed, kept }
}

export async function cleanupBundle(appId: string, options: BundleCleanupOptions) {
  return cleanupBundleInternal(appId, options)
}
