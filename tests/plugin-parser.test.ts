import { describe, expect, it } from 'vitest'
import { convertQueryToBody, makeDevice } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_parser.ts'

describe('plugin parser install_source normalization', () => {
  it.concurrent('trims and lowercases reported install sources', () => {
    const device = makeDevice({
      app_id: 'com.example.app',
      device_id: 'device-1',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      platform: 'ios',
      plugin_version: '8.0.0',
      defaultChannel: 'production',
      is_emulator: false,
      install_source: '  TestFlight  ',
    })

    expect(device.install_source).toBe('testflight')
  })

  it.concurrent('drops blank or omitted install sources', () => {
    expect(makeDevice({
      app_id: 'com.example.app',
      device_id: 'device-1',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      platform: 'ios',
      plugin_version: '8.0.0',
      defaultChannel: 'production',
      is_emulator: false,
      install_source: '   ',
    }).install_source).toBeUndefined()

    expect(makeDevice({
      app_id: 'com.example.app',
      device_id: 'device-2',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      platform: 'ios',
      plugin_version: '8.0.0',
      defaultChannel: 'production',
      is_prod: true,
    }).install_source).toBeUndefined()
  })

  it.concurrent('keeps query install_source available for device creation', () => {
    const body = convertQueryToBody({
      app_id: 'com.example.app',
      device_id: 'DEVICE-1',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      platform: 'ios',
      plugin_version: '8.0.0',
      install_source: ' App_Store ',
    })

    expect(body.install_source).toBe(' App_Store ')
    expect(makeDevice(body).install_source).toBe('app_store')

    const bodyWithoutSource = convertQueryToBody({
      app_id: 'com.example.app',
      device_id: 'DEVICE-2',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      platform: 'ios',
      plugin_version: '8.0.0',
    })

    expect(bodyWithoutSource.install_source).toBeUndefined()
    expect(makeDevice(bodyWithoutSource).install_source).toBeUndefined()
  })
})
