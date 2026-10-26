import { tryParse } from '@std/semver'

// The first two checks duplicate plugin_runtime/utils/legacyDownloadFail.ts (plugin_runtime stays isolated).
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

// The stats endpoint used to count these as version fails. It now flags their
// logs (app_log blob10 = '1') instead; readers subtract the unflagged ones from
// version_usage until Analytics Engine expires them (90 days, late January 2027).

export interface LegacyDownloadFailLogRow {
  bucket: string | number
  version_name: string
  plugin_version: string
  count: string | number
}

export function legacyDownloadFailKey(bucket: string | number, versionName: string) {
  return `${bucket}|${versionName}`
}

/** Legacy download_fail count per bucket and version, from logs grouped by plugin version. */
export function sumLegacyDownloadFails(rows: LegacyDownloadFailLogRow[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (!isLegacyDownloadFailPlugin(row.plugin_version))
      continue
    const count = Number(row.count)
    if (!Number.isFinite(count) || count <= 0)
      continue
    const key = legacyDownloadFailKey(row.bucket, row.version_name)
    counts.set(key, (counts.get(key) ?? 0) + count)
  }
  return counts
}

/**
 * Removes legacy download_fail from version fail counts. Logs also hold
 * download_fail that never became a version fail (dev builds, emulators,
 * unknown bundles), so a count never drops below zero.
 */
export function subtractLegacyDownloadFails<T extends { fail: number | string | null }>(rows: T[], keyOf: (row: T) => string, legacy: Map<string, number>): T[] {
  if (legacy.size === 0)
    return rows
  return rows.map((row) => {
    const legacyFails = legacy.get(keyOf(row))
    if (!legacyFails)
      return row
    return { ...row, fail: Math.max(0, Number(row.fail) - legacyFails) }
  })
}

/**
 * Analytics Engine predicate (LIKE only) matching the plugin versions of
 * isLegacyDownloadFailPlugin: majors 0 to 5, and minors 0 to 52 of 6, 7 and 8.
 */
export function legacyDownloadFailPluginSqlCF(column: string): string {
  const patterns = ['0', '1', '2', '3', '4', '5'].map(major => `${major}.%`)
  for (const major of [6, 7, 8]) {
    patterns.push(`${major}._.%`, `${major}.1_.%`, `${major}.2_.%`, `${major}.3_.%`, `${major}.4_.%`, `${major}.50.%`, `${major}.51.%`, `${major}.52.%`)
  }
  return `(${patterns.map(pattern => `${column} LIKE '${pattern}'`).join(' OR ')})`
}

/** Analytics Engine app_log filter dropping download_fail that may be a failed update check. */
export const NOT_LEGACY_DOWNLOAD_FAIL_CF = `NOT (blob2 = 'download_fail' AND ${legacyDownloadFailPluginSqlCF('blob7')})`
