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
