import { describe, expect, it } from 'vitest'
import {
  applyStatsModeToBody,
  applyStatsModeToDevice,
  applyStatsModeToLogDimensions,
  normalizeAppStatsMode,
  shouldAcceptStatsAction,
} from '../supabase/functions/_backend/plugin_runtime/utils/stats_mode.ts'

describe('stats_mode', () => {
  it('normalizes invalid values to all', () => {
    expect(normalizeAppStatsMode(null)).toBe('all')
    expect(normalizeAppStatsMode(undefined)).toBe('all')
    expect(normalizeAppStatsMode('invalid')).toBe('all')
    expect(normalizeAppStatsMode('updatesOnly')).toBe('updatesOnly')
    expect(normalizeAppStatsMode('billingOnly')).toBe('billingOnly')
  })

  it('filters actions per mode contract', () => {
    expect(shouldAcceptStatsAction('app_crash', 'all')).toBe(true)
    expect(shouldAcceptStatsAction('app_crash', 'updatesOnly')).toBe(false)
    expect(shouldAcceptStatsAction('download_fail', 'updatesOnly')).toBe(true)
    expect(shouldAcceptStatsAction('app_crash', 'billingOnly')).toBe(false)
    expect(shouldAcceptStatsAction('set', 'billingOnly')).toBe(true)
    expect(shouldAcceptStatsAction('download_complete', 'billingOnly')).toBe(true)
    expect(shouldAcceptStatsAction('get', 'updatesOnly')).toBe(false)
  })

  it('strips billing-only fields from stats body', () => {
    const body = applyStatsModeToBody({
      app_id: 'com.example.app',
      device_id: '00000000-0000-4000-8000-000000000001',
      platform: 'ios',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      plugin_version: '8.0.0',
      is_emulator: false,
      is_prod: true,
      defaultChannel: 'production',
      action: 'set',
      custom_id: 'user-1',
      metadata: { foo: 'bar' },
      install_source: 'app_store',
      key_id: 'key-1',
      old_version_name: '0.9.0',
    }, 'billingOnly')

    expect(body.custom_id).toBeUndefined()
    expect(body.metadata).toBeUndefined()
    expect(body.install_source).toBeUndefined()
    expect(body.defaultChannel).toBeUndefined()
    expect(body.key_id).toBeUndefined()
    expect(body.old_version_name).toBeUndefined()
    expect(body.version_name).toBe('1.0.0')
  })

  it('keeps full payload for updatesOnly', () => {
    const body = applyStatsModeToBody({
      app_id: 'com.example.app',
      device_id: '00000000-0000-4000-8000-000000000001',
      platform: 'ios',
      version_name: '1.0.0',
      version_build: '1.0.0',
      version_os: '17.0',
      plugin_version: '8.0.0',
      is_emulator: false,
      is_prod: true,
      defaultChannel: 'production',
      action: 'set',
      custom_id: 'user-1',
    }, 'updatesOnly')

    expect(body.custom_id).toBe('user-1')
    expect(body.defaultChannel).toBe('production')
  })

  it('strips country and custom fields from billing device rows', () => {
    const device = applyStatsModeToDevice({
      platform: 'ios',
      device_id: '00000000-0000-4000-8000-000000000001',
      app_id: 'com.example.app',
      plugin_version: '8.0.0',
      version_build: '1.0.0',
      os_version: '17.0',
      version_name: '1.0.0',
      is_emulator: false,
      is_prod: true,
      install_source: 'app_store',
      custom_id: 'user-1',
      updated_at: new Date().toISOString(),
      default_channel: 'production',
      key_id: 'key-1',
      country_code: 'US',
    }, 'billingOnly')

    expect(device.custom_id).toBeUndefined()
    expect(device.install_source).toBeUndefined()
    expect(device.default_channel).toBeNull()
    expect(device.key_id).toBeNull()
    expect(device.country_code).toBeUndefined()
  })

  it('drops country_code from billing log dimensions', () => {
    expect(applyStatsModeToLogDimensions({
      platform: 'ios',
      country_code: 'US',
      plugin_version: '8.0.0',
    }, 'billingOnly')).toEqual({
      platform: 'ios',
      country_code: null,
      plugin_version: '8.0.0',
    })
  })
})
