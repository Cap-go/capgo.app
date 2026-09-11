import type { AppStats, DeviceWithoutCreatedAt } from './types.ts'
import type { StatsLogDimensions } from './plugin_stats.ts'

export type AppStatsMode = 'all' | 'updatesOnly' | 'billingOnly'

export const STATS_MODE_ALL: AppStatsMode = 'all'
export const STATS_MODE_UPDATES_ONLY: AppStatsMode = 'updatesOnly'
export const STATS_MODE_BILLING_ONLY: AppStatsMode = 'billingOnly'

/** Mirrors Cap-go/capacitor-updater#860 UPDATES_ONLY_STATS_ACTIONS. */
export const UPDATES_ONLY_STATS_ACTIONS = new Set([
  'download_complete',
  'download_manifest_start',
  'download_manifest_complete',
  'download_manifest_file_fail',
  'download_manifest_checksum_fail',
  'download_manifest_brotli_fail',
  'download_zip_start',
  'download_zip_complete',
  'download_fail',
  'finish_download_fail',
  'unzip_fail',
  'decrypt_fail',
  'checksum_fail',
  'checksum_required',
  'windows_path_fail',
  'canonical_path_fail',
  'directory_path_fail',
  'manifest_path_fail',
  'insufficient_disk_space',
  'low_mem_fail',
  'set',
  'set_fail',
  'set_next',
  'reset',
  'delete',
  'update_fail',
  'blocked_by_server_url',
  'rate_limit_reached',
])

/** Mirrors Cap-go/capacitor-updater#860 BILLING_ONLY_STATS_ACTIONS. */
export const BILLING_ONLY_STATS_ACTIONS = new Set([
  'set',
  'download_complete',
  'set_fail',
  'update_fail',
  'download_fail',
])

export function normalizeAppStatsMode(mode: string | null | undefined): AppStatsMode {
  if (mode === STATS_MODE_UPDATES_ONLY || mode === STATS_MODE_BILLING_ONLY)
    return mode
  return STATS_MODE_ALL
}

export function shouldAcceptStatsAction(action: string | undefined, mode: AppStatsMode): boolean {
  const normalizedAction = action?.trim() ?? ''
  if (!normalizedAction)
    return false

  switch (normalizeAppStatsMode(mode)) {
    case STATS_MODE_ALL:
      return true
    case STATS_MODE_BILLING_ONLY:
      return BILLING_ONLY_STATS_ACTIONS.has(normalizedAction)
    default:
      return UPDATES_ONLY_STATS_ACTIONS.has(normalizedAction)
  }
}

export function usesBillingStatsPayload(mode: AppStatsMode): boolean {
  return normalizeAppStatsMode(mode) === STATS_MODE_BILLING_ONLY
}

export function applyStatsModeToBody<T extends AppStats>(body: T, mode: AppStatsMode): T {
  const normalizedMode = normalizeAppStatsMode(mode)
  if (normalizedMode === STATS_MODE_ALL)
    return body

  if (!usesBillingStatsPayload(normalizedMode))
    return body

  const next = { ...body } as T
  next.custom_id = undefined
  next.metadata = undefined
  next.install_source = undefined
  next.defaultChannel = ''
  next.key_id = undefined
  next.old_version_name = undefined
  return next
}

export function applyStatsModeToDevice(device: DeviceWithoutCreatedAt, mode: AppStatsMode): DeviceWithoutCreatedAt {
  const normalizedMode = normalizeAppStatsMode(mode)
  if (normalizedMode === STATS_MODE_ALL)
    return device

  if (!usesBillingStatsPayload(normalizedMode))
    return device

  return {
    ...device,
    custom_id: undefined,
    install_source: undefined,
    default_channel: null,
    key_id: null,
    country_code: undefined,
  }
}

export function applyStatsModeToLogDimensions(dimensions: StatsLogDimensions, mode: AppStatsMode): StatsLogDimensions {
  if (normalizeAppStatsMode(mode) !== STATS_MODE_BILLING_ONLY)
    return dimensions

  return {
    ...dimensions,
    country_code: null,
  }
}
