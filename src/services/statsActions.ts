export const statsActionFilters = [
  ['action-ping', 'ping'],
  ['action-delete', 'delete'],
  ['action-reset', 'reset'],
  ['action-set', 'set'],
  ['action-get', 'get'],
  ['action-set-fail', 'set_fail'],
  ['action-update-fail', 'update_fail'],
  ['action-download-fail', 'download_fail'],
  ['action-windows-path-fail', 'windows_path_fail'],
  ['action-canonical-path-fail', 'canonical_path_fail'],
  ['action-directory-path-fail', 'directory_path_fail'],
  ['action-unzip-fail', 'unzip_fail'],
  ['action-low-mem-fail', 'low_mem_fail'],
  ['action-download-0', 'download_0'],
  ['action-download-10', 'download_10'],
  ['action-download-20', 'download_20'],
  ['action-download-30', 'download_30'],
  ['action-download-40', 'download_40'],
  ['action-download-50', 'download_50'],
  ['action-download-60', 'download_60'],
  ['action-download-70', 'download_70'],
  ['action-download-80', 'download_80'],
  ['action-download-90', 'download_90'],
  ['action-download-complete', 'download_complete'],
  ['action-download-manifest-start', 'download_manifest_start'],
  ['action-download-manifest-complete', 'download_manifest_complete'],
  ['action-download-zip-start', 'download_zip_start'],
  ['action-download-zip-complete', 'download_zip_complete'],
  ['action-download-manifest-file-fail', 'download_manifest_file_fail'],
  ['action-download-manifest-checksum-fail', 'download_manifest_checksum_fail'],
  ['action-download-manifest-brotli-fail', 'download_manifest_brotli_fail'],
  ['action-finish-download-fail', 'finish_download_fail'],
  ['action-manifest-path-fail', 'manifest_path_fail'],
  ['action-decrypt-fail', 'decrypt_fail'],
  ['action-checksum-required', 'checksum_required'],
  ['action-insufficient-disk-space', 'insufficient_disk_space'],
  ['action-app-moved-to-foreground', 'app_moved_to_foreground'],
  ['action-app-moved-to-background', 'app_moved_to_background'],
  ['action-app-launch-start', 'app_launch_start'],
  ['action-app-launch-ready', 'app_launch_ready'],
  ['action-app-launch-timeout', 'app_launch_timeout'],
  ['action-app-crash', 'app_crash'],
  ['action-app-crash-native', 'app_crash_native'],
  ['action-app-anr', 'app_anr'],
  ['action-app-killed-low-memory', 'app_killed_low_memory'],
  ['action-app-killed-excessive-resource-usage', 'app_killed_excessive_resource_usage'],
  ['action-app-initialization-failure', 'app_initialization_failure'],
  ['action-app-memory-warning', 'app_memory_warning'],
  ['action-webview-javascript-error', 'webview_javascript_error'],
  ['action-webview-unhandled-rejection', 'webview_unhandled_rejection'],
  ['action-webview-resource-error', 'webview_resource_error'],
  ['action-webview-security-policy-violation', 'webview_security_policy_violation'],
  ['action-webview-unclean-restart', 'webview_unclean_restart'],
  ['action-webview-render-process-gone', 'webview_render_process_gone'],
  ['action-webview-content-process-terminated', 'webview_content_process_terminated'],
  ['action-webview-dom-content-loaded', 'webview_dom_content_loaded'],
  ['action-webview-page-loaded', 'webview_page_loaded'],
  ['action-app-nav', 'app_nav'],
  ['action-os-version-changed', 'os_version_changed'],
  ['action-native-app-version-changed', 'native_app_version_changed'],
  ['action-uninstall', 'uninstall'],
  ['action-need-plan-upgrade', 'needPlanUpgrade'],
  ['action-missing-bundle', 'missingBundle'],
  ['action-no-new', 'noNew'],
  ['action-disable-platform-ios', 'disablePlatformIos'],
  ['action-disable-platform-android', 'disablePlatformAndroid'],
  ['action-disable-platform-electron', 'disablePlatformElectron'],
  ['action-disable-auto-update-to-major', 'disableAutoUpdateToMajor'],
  ['action-cannot-update-via-private-channel', 'cannotUpdateViaPrivateChannel'],
  ['action-disable-auto-update-to-minor', 'disableAutoUpdateToMinor'],
  ['action-disable-auto-update-to-patch', 'disableAutoUpdateToPatch'],
  ['action-channel-misconfigured', 'channelMisconfigured'],
  ['action-disable-auto-update-metadata', 'disableAutoUpdateMetadata'],
  ['action-disable-auto-update-under-native', 'disableAutoUpdateUnderNative'],
  ['action-disable-dev-build', 'disableDevBuild'],
  ['action-disable-prod-build', 'disableProdBuild'],
  ['action-disable-emulator', 'disableEmulator'],
  ['action-disable-device', 'disableDevice'],
  ['action-cannot-get-bundle', 'cannotGetBundle'],
  ['action-checksum-fail', 'checksum_fail'],
  ['action-key-mismatch', 'keyMismatch'],
  ['action-no-channel-or-override', 'NoChannelOrOverride'],
  ['action-set-channel', 'setChannel'],
  ['action-get-channel', 'getChannel'],
  ['action-rate-limited', 'rateLimited'],
  ['action-rate-limit-reached', 'rate_limit_reached'],
  ['action-disable-auto-update', 'disableAutoUpdate'],
  ['action-invalid-ip', 'InvalidIp'],
  ['action-blocked-by-server-url', 'blocked_by_server_url'],
  ['action-backend-refusal', 'backend_refusal'],
  ['action-custom-id-blocked', 'customIdBlocked'],
  ['action-set-next', 'set_next'],
] as const

export const filterToAction: Record<string, string> = Object.fromEntries(statsActionFilters)
export const actionToFilter: Record<string, string> = Object.fromEntries(
  statsActionFilters.map(([filterKey, actionValue]) => [actionValue, filterKey]),
)

const failureActions = new Set<string>([
  'set_fail',
  'update_fail',
  'download_fail',
  'windows_path_fail',
  'canonical_path_fail',
  'directory_path_fail',
  'unzip_fail',
  'low_mem_fail',
  'download_manifest_file_fail',
  'download_manifest_checksum_fail',
  'download_manifest_brotli_fail',
  'decrypt_fail',
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
  'cannotGetBundle',
  'checksum_fail',
  'blocked_by_server_url',
  'backend_refusal',
])

export const failureActionFilterKeys = statsActionFilters
  .filter(([, actionValue]) => failureActions.has(actionValue))
  .map(([filterKey]) => filterKey)

/** Observe / health events (webview, crashes, launches, native version changes). */
const observeActions = new Set<string>([
  'app_moved_to_foreground',
  'app_moved_to_background',
  'app_launch_start',
  'app_launch_ready',
  'app_launch_timeout',
  'app_crash',
  'app_crash_native',
  'app_anr',
  'app_killed_low_memory',
  'app_killed_excessive_resource_usage',
  'app_initialization_failure',
  'app_memory_warning',
  'webview_javascript_error',
  'webview_unhandled_rejection',
  'webview_resource_error',
  'webview_security_policy_violation',
  'webview_unclean_restart',
  'webview_render_process_gone',
  'webview_content_process_terminated',
  'webview_dom_content_loaded',
  'webview_page_loaded',
  'app_nav',
  'os_version_changed',
  'native_app_version_changed',
])

export const observeActionFilterKeys = statsActionFilters
  .filter(([, actionValue]) => observeActions.has(actionValue))
  .map(([filterKey]) => filterKey)

/** Live-update / OTA process events (everything that is not observe). */
export const updateActionFilterKeys = statsActionFilters
  .filter(([, actionValue]) => !observeActions.has(actionValue))
  .map(([filterKey]) => filterKey)

export function createActionFilterState(): Record<string, boolean> {
  return Object.fromEntries(statsActionFilters.map(([filterKey]) => [filterKey, false]))
}

/**
 * Observe signal categories. None of these come from Capgo itself: the updater
 * plugin only relays what the OS and the WebView report about the host app.
 * - crash: the app process failed (crash, ANR, startup failure, launch timeout).
 * - web: an error thrown or triggered by the app's own web code.
 * - system: the OS reclaimed memory or restarted the WebView. Often expected,
 *   especially while the app sits in the background.
 * - context: informational events (launches, page loads, navigation).
 */
export type ObserveSignalCategory = 'crash' | 'web' | 'system' | 'context'

const observeSignals: Record<string, { category: ObserveSignalCategory, helpKey: string }> = {
  app_crash: { category: 'crash', helpKey: 'observe-signal-help-app-crash' },
  app_crash_native: { category: 'crash', helpKey: 'observe-signal-help-app-crash-native' },
  app_anr: { category: 'crash', helpKey: 'observe-signal-help-app-anr' },
  app_initialization_failure: { category: 'crash', helpKey: 'observe-signal-help-app-initialization-failure' },
  app_launch_timeout: { category: 'crash', helpKey: 'observe-signal-help-app-launch-timeout' },
  webview_javascript_error: { category: 'web', helpKey: 'observe-signal-help-webview-javascript-error' },
  webview_unhandled_rejection: { category: 'web', helpKey: 'observe-signal-help-webview-unhandled-rejection' },
  webview_resource_error: { category: 'web', helpKey: 'observe-signal-help-webview-resource-error' },
  webview_security_policy_violation: { category: 'web', helpKey: 'observe-signal-help-webview-security-policy-violation' },
  app_killed_low_memory: { category: 'system', helpKey: 'observe-signal-help-app-killed-low-memory' },
  app_killed_excessive_resource_usage: { category: 'system', helpKey: 'observe-signal-help-app-killed-excessive-resource-usage' },
  app_memory_warning: { category: 'system', helpKey: 'observe-signal-help-app-memory-warning' },
  webview_unclean_restart: { category: 'system', helpKey: 'observe-signal-help-webview-unclean-restart' },
  webview_render_process_gone: { category: 'system', helpKey: 'observe-signal-help-webview-render-process-gone' },
  webview_content_process_terminated: { category: 'system', helpKey: 'observe-signal-help-webview-content-process-terminated' },
}

export function observeSignalCategory(action: string): ObserveSignalCategory {
  return observeSignals[action]?.category ?? 'context'
}

export function observeSignalHelpKey(action: string): string | null {
  return observeSignals[action]?.helpKey ?? null
}

/**
 * Updater failure categories. These are the live update failures shown on the
 * Observe > Updater page. App crashes and WebView errors belong to the Native
 * page and are intentionally left out.
 * - rollback: the new bundle did not call notifyAppReady() in time, so the
 *   plugin restored the previous bundle.
 * - bundle: the bundle was rejected or could not be served (checksum,
 *   encryption, invalid paths, install step).
 * - device: the device could not finish the download (network, storage,
 *   memory). The device keeps its current bundle and retries later.
 * - setup: the plugin setup prevents updates (server.url, old plugin).
 */
export type UpdaterFailureCategory = 'rollback' | 'bundle' | 'device' | 'setup'

const updaterFailures: Record<string, { category: UpdaterFailureCategory, helpKey: string }> = {
  update_fail: { category: 'rollback', helpKey: 'updater-failure-help-update-fail' },
  set_fail: { category: 'bundle', helpKey: 'updater-failure-help-set-fail' },
  checksum_fail: { category: 'bundle', helpKey: 'updater-failure-help-checksum-fail' },
  decrypt_fail: { category: 'bundle', helpKey: 'updater-failure-help-decrypt-fail' },
  cannotGetBundle: { category: 'bundle', helpKey: 'updater-failure-help-cannot-get-bundle' },
  download_manifest_checksum_fail: { category: 'bundle', helpKey: 'updater-failure-help-checksum-fail' },
  download_manifest_brotli_fail: { category: 'bundle', helpKey: 'updater-failure-help-brotli-fail' },
  manifest_path_fail: { category: 'bundle', helpKey: 'updater-failure-help-path-fail' },
  windows_path_fail: { category: 'bundle', helpKey: 'updater-failure-help-path-fail' },
  canonical_path_fail: { category: 'bundle', helpKey: 'updater-failure-help-path-fail' },
  directory_path_fail: { category: 'bundle', helpKey: 'updater-failure-help-path-fail' },
  download_fail: { category: 'device', helpKey: 'updater-failure-help-download-fail' },
  download_manifest_file_fail: { category: 'device', helpKey: 'updater-failure-help-download-fail' },
  finish_download_fail: { category: 'device', helpKey: 'updater-failure-help-finish-download-fail' },
  unzip_fail: { category: 'device', helpKey: 'updater-failure-help-unzip-fail' },
  low_mem_fail: { category: 'device', helpKey: 'updater-failure-help-low-mem-fail' },
  insufficient_disk_space: { category: 'device', helpKey: 'updater-failure-help-insufficient-disk-space' },
  blocked_by_server_url: { category: 'setup', helpKey: 'updater-failure-help-blocked-by-server-url' },
  backend_refusal: { category: 'setup', helpKey: 'updater-failure-help-backend-refusal' },
}

/** Actions requested by the Observe > Updater insights. */
export const updaterInsightActions = Object.keys(updaterFailures)

export function updaterFailureCategory(action: string): UpdaterFailureCategory {
  return updaterFailures[action]?.category ?? 'bundle'
}

export function updaterFailureHelpKey(action: string): string | null {
  return updaterFailures[action]?.helpKey ?? null
}
