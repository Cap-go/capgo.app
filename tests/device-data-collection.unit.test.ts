import { describe, expect, it } from 'vitest'
import { parseAppRowDeviceDataCollection, parseDeviceDataCollection as parseFrontendCollection } from '../src/services/deviceDataCollection'
import {
  applyDeviceDataCollectionToDevice,
  applyDeviceDataCollectionToLogDimensions,
  DEFAULT_DEVICE_DATA_COLLECTION,
  mauPlatformForCollection,
  mauVersionBuildForCollection,
  mergeDeviceDataCollection,
  parseDeviceDataCollection,
  sanitizeDeviceDataCollectionInput,
} from '../supabase/functions/_backend/utils/deviceDataCollection.ts'

const fullDevice = {
  app_id: 'com.example.app',
  device_id: '00000000-0000-4000-8000-000000000001',
  version_name: '1.2.3',
  platform: 'ios',
  plugin_version: '7.1.0',
  os_version: '18.1',
  version_build: '4.0.0',
  custom_id: '',
  is_prod: true,
  is_emulator: false,
  country_code: 'FR',
  install_source: 'app_store',
}

describe('device data collection', () => {
  it.concurrent('defaults every optional field to collected', () => {
    expect(parseDeviceDataCollection(null)).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
    expect(parseDeviceDataCollection(undefined)).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
    expect(parseDeviceDataCollection('nope')).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
    expect(parseFrontendCollection({})).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
    expect(parseAppRowDeviceDataCollection({ device_data_collection: { country: false } })).toEqual({
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
    })
    expect(parseAppRowDeviceDataCollection(null)).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
    expect(Object.values(DEFAULT_DEVICE_DATA_COLLECTION).every(Boolean)).toBe(true)
  })

  it.concurrent('keeps unknown keys out and only accepts booleans', () => {
    expect(parseDeviceDataCollection({
      country: false,
      platform: 'ios',
      extra: false,
    })).toEqual({
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
    })
  })

  it.concurrent('returns undefined when the public app PUT omits the field', () => {
    expect(sanitizeDeviceDataCollectionInput(undefined)).toBeUndefined()
    expect(sanitizeDeviceDataCollectionInput({ country: false })).toEqual({
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
    })
  })

  it.concurrent('merges CLI/API patches onto the current collection flags', () => {
    expect(mergeDeviceDataCollection(undefined, undefined)).toBeUndefined()
    expect(mergeDeviceDataCollection({ country: false, platform: false }, { country: true })).toEqual({
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: true,
      platform: false,
    })
    expect(mergeDeviceDataCollection({ country: false }, null)).toEqual(DEFAULT_DEVICE_DATA_COLLECTION)
  })

  it.concurrent('strips disabled fields before persist and keeps update-routing fields on the source object', () => {
    const source = { ...fullDevice }
    const stored = applyDeviceDataCollectionToDevice(source, {
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      country: false,
      platform: false,
      os_version: false,
      plugin_version: false,
      version_build: false,
      is_emulator: false,
      is_prod: false,
      install_source: false,
    })

    expect(stored).toMatchObject({
      app_id: 'com.example.app',
      device_id: '00000000-0000-4000-8000-000000000001',
      version_name: '1.2.3',
      country_code: null,
      platform: null,
      os_version: null,
      plugin_version: '',
      version_build: '',
      is_emulator: null,
      is_prod: null,
      install_source: null,
    })
    expect(source.platform).toBe('ios')
    expect(source.country_code).toBe('FR')
  })

  it.concurrent('clears log dimensions and MAU extras when those flags are off', () => {
    const dimensions = applyDeviceDataCollectionToLogDimensions({
      platform: 'android',
      country_code: 'US',
      plugin_version: '8.0.0',
    }, {
      ...DEFAULT_DEVICE_DATA_COLLECTION,
      platform: false,
      country: false,
      plugin_version: false,
    })

    expect(dimensions).toEqual({
      platform: null,
      country_code: null,
      plugin_version: null,
    })
    expect(mauPlatformForCollection('ios', { ...DEFAULT_DEVICE_DATA_COLLECTION, platform: false })).toBe('')
    expect(mauPlatformForCollection('ios', DEFAULT_DEVICE_DATA_COLLECTION)).toBe('ios')
    expect(mauVersionBuildForCollection('1.0.0', { ...DEFAULT_DEVICE_DATA_COLLECTION, version_build: false })).toBeNull()
    expect(mauVersionBuildForCollection('1.0.0', DEFAULT_DEVICE_DATA_COLLECTION)).toBe('1.0.0')
  })
})
