import { describe, expect, it } from 'vitest'
import { convertQueryToBody, makeDevice } from '../supabase/functions/_backend/plugin_runtime/utils/plugin_parser.ts'

const query = {
  app_id: 'com.example.app',
  device_id: 'device-1',
  version_name: '1.0.0',
  version_build: '1.0.0',
  version_os: '17.0',
  platform: 'ios',
  plugin_version: '8.0.0',
} as const
const body = { ...query, defaultChannel: 'production', is_emulator: false }

describe('plugin parser install_source normalization', () => {
  it.concurrent.each([
    ['  TestFlight  ', 'testflight'],
    ['   ', undefined],
    [undefined, undefined],
  ])('normalizes reported install source %j to %j', (install_source, expected) => {
    expect(makeDevice({ ...body, install_source }).install_source).toBe(expected)
  })

  it.concurrent('keeps query install_source available for device creation', () => {
    const withSource = convertQueryToBody({ ...query, install_source: ' App_Store ' })
    expect(withSource.install_source).toBe(' App_Store ')
    expect(makeDevice(withSource).install_source).toBe('app_store')

    const withoutSource = convertQueryToBody(query)
    expect(withoutSource.install_source).toBeUndefined()
    expect(makeDevice(withoutSource).install_source).toBeUndefined()
  })
})
