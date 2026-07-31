import type { Database } from '../src/types/supabase.types'
import { describe, expect, it } from 'vitest'
import { useDeviceUpdateFormat } from '../src/composables/useDeviceUpdateFormat'
import { filterDeviceKeys, parseCustomIdFilter } from '../supabase/functions/_backend/public/device/get.ts'

type DeviceRow = Database['public']['Tables']['devices']['Row']

describe('device update format helpers', () => {
  it.concurrent('preserves the stored default channel and includes the override channel', () => {
    const { transformDeviceToUpdateRequest } = useDeviceUpdateFormat()
    const device: DeviceRow = {
      app_id: 'lgbt.vibes.application',
      country_code: null,
      custom_id: '',
      default_channel: 'insiders',
      device_id: '31de6a5e-80a9-4348-9af1-31e1e9562583',
      id: 1,
      install_source: null,
      is_emulator: false,
      is_prod: true,
      key_id: null,
      os_version: '16',
      platform: 'android',
      plugin_version: '7.42.3',
      updated_at: '2026-06-08T14:14:00.000Z',
      version: null,
      version_build: '3.1.0',
      version_name: '3.1.0-insiders.59',
    }

    expect(transformDeviceToUpdateRequest(device, 'lgbt.vibes.application', device.default_channel ?? '', 'dev')).toMatchObject({
      app_id: 'lgbt.vibes.application',
      device_id: '31de6a5e-80a9-4348-9af1-31e1e9562583',
      defaultChannel: 'insiders',
      channel: 'dev',
    })
  })

  it.concurrent('omits the override channel when no override is set', () => {
    const { transformDeviceToUpdateRequest } = useDeviceUpdateFormat()
    const device = {
      app_id: 'lgbt.vibes.application',
      country_code: null,
      custom_id: '',
      default_channel: 'insiders',
      device_id: '31de6a5e-80a9-4348-9af1-31e1e9562583',
      install_source: null,
      id: 1,
      is_emulator: false,
      is_prod: true,
      key_id: null,
      os_version: '16',
      platform: 'android',
      plugin_version: '7.42.3',
      updated_at: '2026-06-08T14:14:00.000Z',
      version: null,
      version_build: '3.1.0',
      version_name: '3.1.0-insiders.59',
    } satisfies DeviceRow

    expect(transformDeviceToUpdateRequest(device, 'lgbt.vibes.application', device.default_channel ?? '')).toMatchObject({
      defaultChannel: 'insiders',
    })
    expect(transformDeviceToUpdateRequest(device, 'lgbt.vibes.application', device.default_channel ?? '')).not.toHaveProperty('channel')
  })

  it.concurrent('keeps install_source and country_code in public device responses', () => {
    const [device] = filterDeviceKeys([{
      app_id: 'lgbt.vibes.application',
      country_code: 'FR',
      custom_id: '',
      default_channel: 'production',
      device_id: '31de6a5e-80a9-4348-9af1-31e1e9562583',
      id: 1,
      install_source: 'app_store',
      is_emulator: false,
      is_prod: true,
      key_id: null,
      os_version: '17',
      platform: 'ios',
      plugin_version: '8.0.0',
      updated_at: '2026-06-08T14:14:00.000Z',
      version: null,
      version_build: '3.1.0',
      version_name: '3.1.0',
    }])

    expect(device).toMatchObject({
      country_code: 'FR',
      device_id: '31de6a5e-80a9-4348-9af1-31e1e9562583',
      install_source: 'app_store',
    })
  })
})

describe('parseCustomIdFilter', () => {
  it.concurrent('treats undefined as omitted', () => {
    expect(parseCustomIdFilter(undefined)).toBeUndefined()
  })

  it.concurrent('rejects null custom_id', () => {
    expect(() => parseCustomIdFilter(null)).toThrowError(/custom_id must be a string|invalid_custom_id/)
  })

  it.concurrent('trims and returns a valid custom_id', () => {
    expect(parseCustomIdFilter('  user-123  ')).toBe('user-123')
  })
})
