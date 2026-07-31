import type { BundleCompatibilityOptions } from '../schemas/bundle'
import type { Compatibility } from '../utils'
import { intro, log } from '@clack/prompts'
import { trackEvent } from '../analytics/track'
import { check2FAComplianceForApp, checkAppExistsAndHasPermissionOrgErr } from '../api/app'
import { formatTable } from '../terminal-table'
import {
  checkCompatibilityCloud,
  createSupabaseClient,
  findSavedKey,
  formatError,
  getAppId,
  getCompatibilityDetails,
  getConfig,
  isCompatible,
} from '../utils'

interface CompatibilityResult {
  finalCompatibility: Compatibility[]
  hasIncompatible: boolean
  resolvedAppId: string
  channel: string
}

export async function checkCompatibilityInternal(
  appId: string,
  options: BundleCompatibilityOptions,
  silent = false,
): Promise<CompatibilityResult> {
  if (!silent)
    intro('Check compatibility')

  const enrichedOptions: BundleCompatibilityOptions = {
    ...options,
    apikey: options.apikey || findSavedKey(),
  }

  const extConfig = appId ? undefined : await getConfig()
  const resolvedAppId = getAppId(appId, extConfig?.config)
  const channel = enrichedOptions.channel

  if (!channel) {
    if (!silent)
      log.error('Missing argument, you need to provide a channel')
    throw new Error('Missing channel')
  }

  if (!enrichedOptions.apikey) {
    if (!silent)
      log.error('Missing API key, you need to provide an API key to access Capgo Cloud metadata')
    throw new Error('Missing API key')
  }

  if (!resolvedAppId) {
    if (!silent)
      log.error('Missing argument, you need to provide an appId, or be in a capacitor project')
    throw new Error('Missing appId')
  }

  const supabase = await createSupabaseClient(
    enrichedOptions.apikey,
    enrichedOptions.supaHost,
    enrichedOptions.supaAnon,
  )
  await check2FAComplianceForApp(supabase, resolvedAppId, silent)
  await checkAppExistsAndHasPermissionOrgErr(
    supabase,
    enrichedOptions.apikey,
    resolvedAppId,
    'app.read_bundles',
    silent,
    true,
  )

  const compatibility = await checkCompatibilityCloud(
    supabase,
    resolvedAppId,
    channel,
    enrichedOptions.packageJson,
    enrichedOptions.nodeModules,
  )

  const hasIncompatible = compatibility.finalCompatibility.some(entry => !isCompatible(entry))

  void trackEvent({
    channel: 'bundle',
    event: 'Bundle Compatibility Checked',
    icon: '🧪',
    tags: {
      result: hasIncompatible ? 'incompatible' : 'compatible',
      missing_deps_count: compatibility.finalCompatibility.filter(entry => !isCompatible(entry)).length,
    },
  })

  if (!silent) {
    const yesSymbol = enrichedOptions.text ? 'OK' : '✅'
    const noSymbol = enrichedOptions.text ? 'FAIL' : '❌'
    const rows = compatibility.finalCompatibility.map((entry) => {
      const details = getCompatibilityDetails(entry)
      return [
        entry.name,
        entry.localVersion || '-',
        entry.remoteVersion || '-',
        details.compatible ? yesSymbol : noSymbol,
        details.message,
      ]
    })

    log.success('Compatibility Check Results')
    log.info(formatTable({
      headers: ['Package', 'Local', 'Remote', 'Status', 'Details'],
      rows,
    }))

    // Summary
    if (hasIncompatible) {
      const incompatibleCount = compatibility.finalCompatibility.filter(e => !isCompatible(e)).length
      log.warn(`\n${incompatibleCount} package(s) are incompatible with channel "${channel}"`)
      log.warn('An app store update may be required for these changes to take effect.')
    }
    else {
      log.success(`\nAll packages are compatible with channel "${channel}"`)
    }
  }

  return {
    finalCompatibility: compatibility.finalCompatibility,
    hasIncompatible,
    resolvedAppId,
    channel,
  }
}

export async function checkCompatibility(appId: string, options: BundleCompatibilityOptions) {
  try {
    await checkCompatibilityInternal(appId, options, false)
  }
  catch (error) {
    log.error(`Error checking compatibility ${formatError(error)}`)
    throw error
  }
}

export type UploadCompatibilityResult = 'compatible' | 'incompatible' | 'skipped'

export interface UploadCompatibilitySummary {
  result: UploadCompatibilityResult
  incompatibleCount: number
  reasons: string[]
}

/**
 * Summarize an upload's compatibility outcome for analytics.
 *
 * `finalCompatibility` is `undefined` when the comparison did not run (new
 * channel / no remote native metadata / `--ignore-metadata-check`), which is
 * reported as `skipped` so the funnel never silently counts a skip as
 * `compatible`.
 */
export function summarizeUploadCompatibility(
  finalCompatibility: Compatibility[] | undefined,
): UploadCompatibilitySummary {
  if (!finalCompatibility)
    return { result: 'skipped', incompatibleCount: 0, reasons: [] }

  const incompatible = finalCompatibility.filter(entry => !isCompatible(entry))
  const reasons = [...new Set(incompatible.flatMap(entry => getCompatibilityDetails(entry).reasons))]

  return {
    result: incompatible.length > 0 ? 'incompatible' : 'compatible',
    incompatibleCount: incompatible.length,
    reasons,
  }
}
