import type { DeviceWithoutCreatedAt } from './types.ts'

const normalizeOptionalString = (value: string | null | undefined) => (value === undefined || value === null || value === '' ? null : value)

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
  is_prod: boolean
  is_emulator: boolean
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
    is_prod: device.is_prod ?? false,
    is_emulator: device.is_emulator ?? false,
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
    is_prod: existing?.is_prod === undefined || existing?.is_prod === null ? false : Boolean(existing.is_prod),
    is_emulator: existing?.is_emulator === undefined || existing?.is_emulator === null ? false : Boolean(existing.is_emulator),
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

export { normalizeOptionalString as nullableString }
