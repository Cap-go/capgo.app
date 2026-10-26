import { tryParse } from '@std/semver'

// utils/legacyDownloadFail.ts duplicates these checks for API readers (plugin_runtime stays isolated).
// Updater plugins before 6.53.0, 7.53.0 and 8.53.0 report a failed update check
// (offline, timeout, unreadable response) as download_fail, against the bundle
// the device already runs. Their background download failures carry that running
// bundle too, not the bundle being downloaded. Such a download_fail never says
// which bundle failed, so it must not count as a failure of a bundle.
const UPDATE_CHECK_ERROR_PLUGIN_MINOR = 53

/** Whether this plugin version can report a failed update check as download_fail. */
export function isLegacyDownloadFailPlugin(pluginVersion: string | null | undefined): boolean {
  const parsed = typeof pluginVersion === 'string' ? tryParse(pluginVersion.trim()) : undefined
  if (!parsed)
    return false
  if (parsed.major >= 9)
    return false
  if (parsed.major < 6)
    return true
  return parsed.minor < UPDATE_CHECK_ERROR_PLUGIN_MINOR
}

/** download_fail from such a plugin is logged but never counted as a bundle failure. */
export function countsAsBundleFailure(action: string, pluginVersion: string | null | undefined): boolean {
  return action !== 'download_fail' || !isLegacyDownloadFailPlugin(pluginVersion)
}
