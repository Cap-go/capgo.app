import type { DeviceWithoutCreatedAt } from './types.ts'

export type StatsMode = 'all' | 'updatesOnly' | 'billingOnly'

const STATS_MODE_ALL: StatsMode = 'all'
const STATS_MODE_UPDATES_ONLY: StatsMode = 'updatesOnly'
const STATS_MODE_BILLING_ONLY: StatsMode = 'billingOnly'

export function normalizeStatsMode(value: unknown): StatsMode {
  if (value === STATS_MODE_UPDATES_ONLY || value === STATS_MODE_BILLING_ONLY)
    return value
  return STATS_MODE_ALL
}

export function isBillingOnlyStatsMode(statsMode: StatsMode): boolean {
  return statsMode === STATS_MODE_BILLING_ONLY
}

export function getStatsModeFromBody(body: { stats_mode?: unknown }): StatsMode {
  return normalizeStatsMode(body.stats_mode)
}

export function sanitizeDeviceForPersistence(device: DeviceWithoutCreatedAt, statsMode: StatsMode): DeviceWithoutCreatedAt {
  if (!isBillingOnlyStatsMode(statsMode))
    return device

  return {
    ...device,
    os_version: '',
    install_source: undefined,
    default_channel: null,
    key_id: null,
    custom_id: undefined,
    country_code: undefined,
  }
}

export function sanitizeDeviceForLogging(device: DeviceWithoutCreatedAt, statsMode: StatsMode) {
  if (!isBillingOnlyStatsMode(statsMode))
    return device

  return {
    app_id: device.app_id,
    device_id: device.device_id,
    version_name: device.version_name,
    version_build: device.version_build,
    is_emulator: device.is_emulator,
    is_prod: device.is_prod,
  }
}
