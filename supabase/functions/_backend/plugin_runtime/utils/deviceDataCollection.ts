export const DEVICE_DATA_COLLECTION_KEYS = [
  'country',
  'platform',
  'os_version',
  'plugin_version',
  'version_build',
  'is_emulator',
  'is_prod',
  'install_source',
] as const

export type DeviceDataCollectionKey = typeof DEVICE_DATA_COLLECTION_KEYS[number]
export type DeviceDataCollection = Record<DeviceDataCollectionKey, boolean>

export const DEFAULT_DEVICE_DATA_COLLECTION: DeviceDataCollection = {
  country: true,
  platform: true,
  os_version: true,
  plugin_version: true,
  version_build: true,
  is_emulator: true,
  is_prod: true,
  install_source: true,
}

export function parseDeviceDataCollection(raw: unknown): DeviceDataCollection {
  const parsed = { ...DEFAULT_DEVICE_DATA_COLLECTION }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return parsed

  const source = raw as Record<string, unknown>
  for (const key of DEVICE_DATA_COLLECTION_KEYS) {
    if (typeof source[key] === 'boolean')
      parsed[key] = source[key]
  }
  return parsed
}

export function sanitizeDeviceDataCollectionInput(raw: unknown): DeviceDataCollection | undefined {
  if (raw === undefined)
    return undefined
  return parseDeviceDataCollection(raw)
}

export function applyDeviceDataCollectionToDevice<T extends Record<string, unknown>>(
  device: T,
  collection: DeviceDataCollection,
): T {
  const next = { ...device }
  if (!collection.country)
    next.country_code = null
  if (!collection.platform)
    next.platform = null
  if (!collection.os_version)
    next.os_version = null
  if (!collection.plugin_version)
    next.plugin_version = ''
  if (!collection.version_build)
    next.version_build = ''
  if (!collection.is_emulator)
    next.is_emulator = null
  if (!collection.is_prod)
    next.is_prod = null
  if (!collection.install_source)
    next.install_source = null
  return next
}

export function applyDeviceDataCollectionToLogDimensions<T extends {
  platform?: string | null
  country_code?: string | null
  plugin_version?: string | null
}>(dimensions: T, collection: DeviceDataCollection): T {
  return {
    ...dimensions,
    platform: collection.platform ? dimensions.platform : null,
    country_code: collection.country ? dimensions.country_code : null,
    plugin_version: collection.plugin_version ? dimensions.plugin_version : null,
  }
}

export function mauPlatformForCollection(platform: string | null | undefined, collection: DeviceDataCollection) {
  return collection.platform ? (platform ?? '') : ''
}

export function mauVersionBuildForCollection(versionBuild: string | null | undefined, collection: DeviceDataCollection) {
  return collection.version_build ? versionBuild : null
}
