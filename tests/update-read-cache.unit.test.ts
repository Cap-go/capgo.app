import { describe, expect, it } from 'vitest'
import { canServeUpToDateFromCache } from '../supabase/functions/_backend/plugin_runtime/utils/updateReadCache.ts'

const payload = {
  ownerOrg: 'org-1',
  allowDeviceCustomId: true,
  versionName: '1.2.3',
  keyId: null as string | null,
}

const body = {
  app_id: 'com.example.app',
  device_id: 'device-1',
  platform: 'ios',
  version_name: '1.2.3',
  version_build: '1.2.3',
  plugin_version: '7.40.0',
}

describe('update read cache', () => {
  it.concurrent('serves an up-to-date device without opening Postgres', () => {
    expect(canServeUpToDateFromCache(body, payload, false)).toBe(true)
  })

  it.concurrent('opens Postgres when the channel version changed', () => {
    expect(canServeUpToDateFromCache({ ...body, version_name: '1.2.2' }, payload, false)).toBe(false)
  })

  it.concurrent('opens Postgres for a legacy channel_self client', () => {
    expect(canServeUpToDateFromCache({ ...body, plugin_version: '5.10.0' }, payload, true)).toBe(false)
  })

  it.concurrent('opens Postgres when the native build is not semver', () => {
    expect(canServeUpToDateFromCache({ ...body, version_build: 'unknown' }, payload, false)).toBe(false)
  })

  it.concurrent('opens Postgres when the device encryption key does not match the bundle', () => {
    expect(canServeUpToDateFromCache(
      { ...body, plugin_version: '8.41.0', key_id: 'device-key' },
      { ...payload, keyId: 'bundle-key' },
      false,
    )).toBe(false)
  })

  it.concurrent('serves an older plugin when the encryption keys differ', () => {
    expect(canServeUpToDateFromCache(
      { ...body, plugin_version: '7.40.0', key_id: 'device-key' },
      { ...payload, keyId: 'bundle-key' },
      false,
    )).toBe(true)
  })

  it.concurrent('serves an up-to-date device when the encryption keys match', () => {
    expect(canServeUpToDateFromCache(
      { ...body, key_id: 'same-key' },
      { ...payload, keyId: 'same-key' },
      false,
    )).toBe(true)
  })
})
