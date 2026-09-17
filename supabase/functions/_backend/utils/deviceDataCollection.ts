export {
  applyDeviceDataCollectionToDevice,
  applyDeviceDataCollectionToLogDimensions,
  DEFAULT_DEVICE_DATA_COLLECTION,
  DEVICE_DATA_COLLECTION_KEYS,
  mauPlatformForCollection,
  mauVersionBuildForCollection,
  parseDeviceDataCollection,
  sanitizeDeviceDataCollectionInput,
} from '../plugin_runtime/utils/deviceDataCollection.ts'

export type { DeviceDataCollection, DeviceDataCollectionKey } from '../plugin_runtime/utils/deviceDataCollection.ts'
