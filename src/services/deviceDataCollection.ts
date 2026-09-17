import {
  DEFAULT_DEVICE_DATA_COLLECTION,
  DEVICE_DATA_COLLECTION_KEYS,
  parseDeviceDataCollection,
} from '../../supabase/functions/_backend/utils/deviceDataCollection.ts'

export type {
  DeviceDataCollection,
  DeviceDataCollectionKey,
} from '../../supabase/functions/_backend/utils/deviceDataCollection.ts'

export {
  DEFAULT_DEVICE_DATA_COLLECTION,
  DEVICE_DATA_COLLECTION_KEYS,
  parseDeviceDataCollection,
}

export function parseAppRowDeviceDataCollection(row: unknown) {
  if (!row || typeof row !== 'object')
    return parseDeviceDataCollection(null)
  return parseDeviceDataCollection((row as { device_data_collection?: unknown }).device_data_collection)
}
