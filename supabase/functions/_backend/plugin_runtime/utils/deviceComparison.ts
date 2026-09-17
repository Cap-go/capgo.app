import type { DeviceWithoutCreatedAt } from './types.ts'

const normalizeOptionalString = (value: string | null | undefined) => (value === undefined || value === null || value === '' ? null : value)

function normalizeOptionalBool(value: boolean | number | null | undefined): boolean | null {
  if (value === undefined)
    return false
  if (value === null)
    return null
  return Boolean(value)
}

export function normalizeDeviceCountryCode(countryCode: string | null | undefined) {
  const normalized = normalizeOptionalString(countryCode)?.trim().toUpperCase()
  return normalized && /^[A-Z]{2}$/.test(normalized) ? normalized : null
}

export interface DeviceComparable {
  // version: number | null
  platform: DeviceWithoutCreatedAt['platform'] | null
  plugin_version: string // DB schema: NOT NULL
  os_version: string // DB schema: NOT NULL
  version_build: string // DB schema: DEFAULT 'builtin'
  custom_id: string // DB schema: DEFAULT '' NOT NULL
  version_name: string | null // DB schema: text (NULLABLE)
  is_prod: boolean | null
  is_emulator: boolean | null
  install_source?: string | null
  default_channel: string | null // DB schema: TEXT (NULLABLE)
  key_id: string | null
  country_code?: string | null
}

export type DeviceExistingRowLike = {
  // version?: number | null
  platform?: DeviceWithoutCreatedAt['platform'] | null
  plugin_version?: string | null
  os_version?: string | null
  version_build?: string | null
  custom_id?: string | null
  version_name?: string | null
  is_prod?: boolean | number | null
  is_emulator?: boolean | number | null
  install_source?: string | null
  default_channel?: string | null
  key_id?: string | null
  country_code?: string | null
} | null | undefined

export function toComparableDevice(device: DeviceWithoutCreatedAt): DeviceComparable {
  // Apply DB schema defaults/constraints to ensure consistency between writes and comparisons
  // Schema has NOT NULL constraints on many fields that require handling
  const normalizedVersionName = normalizeOptionalString(device.version_name)
  const normalizedCustomId = normalizeOptionalString(device.custom_id)
  const normalizedPluginVersion = normalizeOptionalString(device.plugin_version)
  const normalizedOsVersion = normalizeOptionalString(device.os_version)
  const normalizedDefaultChannel = normalizeOptionalString(device.default_channel)
  const normalizedVersionBuild = normalizeOptionalString(device.version_build)
  const normalizedKeyId = normalizeOptionalString(device.key_id)
  const normalizedInstallSource = normalizeOptionalString(device.install_source)
  const normalizedCountryCode = normalizeDeviceCountryCode(device.country_code)

  const comparable: DeviceComparable = {
    // version: device.version ?? null,
    platform: device.platform ?? null,
    // DB schema: plugin_version NOT NULL (must provide empty string)
    plugin_version: normalizedPluginVersion ?? '',
    // DB schema: os_version NOT NULL (must provide empty string)
    os_version: normalizedOsVersion ?? '',
    // DB schema: version_build DEFAULT 'builtin' (nullable)
    version_build: normalizedVersionBuild ?? 'builtin',
    // DB schema: custom_id DEFAULT '' NOT NULL
    custom_id: normalizedCustomId ?? '',
    // DB schema: version_name text (NULLABLE - allows NULL!)
    version_name: normalizedVersionName,
    is_prod: normalizeOptionalBool(device.is_prod),
    is_emulator: normalizeOptionalBool(device.is_emulator),
    // DB schema: default_channel TEXT (NULLABLE - allows NULL!)
    default_channel: normalizedDefaultChannel,
    key_id: normalizedKeyId,
  }
  if (normalizedInstallSource !== null)
    comparable.install_source = normalizedInstallSource
  if (normalizedCountryCode !== null)
    comparable.country_code = normalizedCountryCode
  return comparable
}

export function toComparableExisting(existing: DeviceExistingRowLike): DeviceComparable {
  // Apply DB schema defaults/constraints to ensure consistency
  const normalizedVersionName = normalizeOptionalString(existing?.version_name as string | null | undefined)
  const normalizedCustomId = normalizeOptionalString(existing?.custom_id as string | null | undefined)
  const normalizedPluginVersion = normalizeOptionalString(existing?.plugin_version as string | null | undefined)
  const normalizedOsVersion = normalizeOptionalString(existing?.os_version as string | null | undefined)
  const normalizedDefaultChannel = normalizeOptionalString(existing?.default_channel as string | null | undefined)
  const normalizedVersionBuild = normalizeOptionalString(existing?.version_build as string | null | undefined)
  const normalizedKeyId = normalizeOptionalString(existing?.key_id as string | null | undefined)
  const normalizedInstallSource = normalizeOptionalString(existing?.install_source)
  const normalizedCountryCode = normalizeDeviceCountryCode(existing?.country_code)

  const comparable: DeviceComparable = {
    // version: existing?.version ?? null,
    platform: existing?.platform ?? null,
    // DB schema: plugin_version NOT NULL (no default, must provide empty string)
    plugin_version: normalizedPluginVersion ?? '',
    // DB schema: os_version NOT NULL (must provide empty string)
    os_version: normalizedOsVersion ?? '',
    // DB schema: version_build DEFAULT 'builtin' (nullable)
    version_build: normalizedVersionBuild ?? 'builtin',
    // DB schema: custom_id DEFAULT '' NOT NULL
    custom_id: normalizedCustomId ?? '',
    // DB schema: version_name text (NULLABLE - allows NULL!)
    version_name: normalizedVersionName,
    is_prod: normalizeOptionalBool(existing?.is_prod),
    is_emulator: normalizeOptionalBool(existing?.is_emulator),
    // DB schema: default_channel TEXT (NULLABLE - allows NULL!)
    default_channel: normalizedDefaultChannel,
    key_id: normalizedKeyId,
  }
  if (normalizedInstallSource !== null)
    comparable.install_source = normalizedInstallSource
  if (normalizedCountryCode !== null)
    comparable.country_code = normalizedCountryCode
  return comparable
}

export function hasComparableDeviceChanged(existing: DeviceExistingRowLike, device: DeviceWithoutCreatedAt) {
  const comparableExisting = toComparableExisting(existing)
  const comparableDevice = toComparableDevice(device)

  return Object.entries(comparableDevice).some(([key, value]) => {
    const existingValue = comparableExisting[key as keyof DeviceComparable]
    return existingValue !== value
  })
}
export function buildNormalizedDeviceForWrite(device: DeviceWithoutCreatedAt) {
  const comparableDevice = toComparableDevice(device)

  return {
    // version: comparableDevice.version,
    version_name: comparableDevice.version_name,
    platform: comparableDevice.platform,
    plugin_version: comparableDevice.plugin_version,
    os_version: comparableDevice.os_version,
    version_build: comparableDevice.version_build,
    custom_id: comparableDevice.custom_id,
    is_prod: comparableDevice.is_prod,
    is_emulator: comparableDevice.is_emulator,
    install_source: comparableDevice.install_source,
    key_id: comparableDevice.key_id,
    country_code: comparableDevice.country_code,
  }
}

/**
 * Max age of a per-colo "device unchanged" cache entry before trackDevicesCF
 * forces a fresh DEVICE_INFO write anyway.
 *
 * Analytics Engine keeps ~90 days of data and device lists / version counts read
 * the latest row per device, so an unchanged device must be re-written well
 * inside that window or it ages out. The colo cache can also hold a stale
 * version for a device that later moved (for example rolled back) while routed
 * through another colo; re-writing daily bounds that staleness to one day. One
 * day means at most one extra AE write per active, unchanged device per colo
 * per day.
 */
export const DEVICE_INFO_REFRESH_TTL_SECONDS = 86400

export interface DeviceInfoWriteCachePayload extends DeviceComparable {
  app_id: string
  device_id: string
  /** ISO timestamp of the last DEVICE_INFO write this entry represents. */
  cached_at: string
}

/**
 * True when the colo cache proves an identical DEVICE_INFO row was written
 * recently enough that this write can be skipped.
 */
export function canSkipDeviceInfoWrite(
  cached: DeviceInfoWriteCachePayload | null | undefined,
  device: DeviceWithoutCreatedAt,
  nowMs: number = Date.now(),
  refreshTtlSeconds: number = DEVICE_INFO_REFRESH_TTL_SECONDS,
) {
  if (!cached)
    return false
  const cachedAtMs = typeof cached.cached_at === 'string' ? Date.parse(cached.cached_at) : Number.NaN
  // Entries without a usable write timestamp force a refresh.
  if (!Number.isFinite(cachedAtMs))
    return false
  const ageMs = nowMs - cachedAtMs
  // A future timestamp (clock skew) is treated as stale rather than trusted.
  if (ageMs < 0 || ageMs >= refreshTtlSeconds * 1000)
    return false
  return !hasComparableDeviceChanged(cached, device)
}

export { normalizeOptionalString as nullableString }
