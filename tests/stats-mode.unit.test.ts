import { describe, expect, it } from 'vitest'
import {
  getStatsModeFromBody,
  isBillingOnlyStatsMode,
  normalizeStatsMode,
  sanitizeDeviceForLogging,
  sanitizeDeviceForPersistence,
} from '../supabase/functions/_backend/plugin_runtime/utils/stats_mode.ts'
import type { DeviceWithoutCreatedAt } from '../supabase/functions/_backend/plugin_runtime/utils/types.ts'

const sampleDevice: DeviceWithoutCreatedAt = {
  app_id: 'ee.forgr.demoapp',
  device_id: 'abc123',
  platform: 'ios',
  version_name: '1.0.0',
  version_build: '100',
  version_os: '17.0',
  plugin_version: '8.0.0',
  is_prod: true,
  is_emulator: false,
  custom_id: 'user-42',
  install_source: 'app_store',
  default_channel: 'production',
  key_id: 'key-1',
  country_code: 'US',
}

describe('stats_mode helpers', () => {
  it('normalizes unknown stats_mode values to all', () => {
    expect(normalizeStatsMode(undefined)).toBe('all')
    expect(normalizeStatsMode('invalid')).toBe('all')
    expect(normalizeStatsMode('updatesOnly')).toBe('updatesOnly')
    expect(normalizeStatsMode('billingOnly')).toBe('billingOnly')
  })

  it('reads stats_mode from request bodies', () => {
    expect(getStatsModeFromBody({ stats_mode: 'billingOnly' })).toBe('billingOnly')
    expect(getStatsModeFromBody({})).toBe('all')
  })

  it('strips sensitive device fields for billingOnly persistence', () => {
    const sanitized = sanitizeDeviceForPersistence(sampleDevice, 'billingOnly')

    expect(sanitized.platform).toBe('ios')
    expect(sanitized.os_version).toBe('')
    expect(sanitized.custom_id).toBeUndefined()
    expect(sanitized.install_source).toBeUndefined()
    expect(sanitized.default_channel).toBeNull()
    expect(sanitized.key_id).toBeNull()
    expect(sanitized.country_code).toBeUndefined()
  })

  it('keeps full device fields for all mode persistence', () => {
    expect(sanitizeDeviceForPersistence(sampleDevice, 'all')).toEqual(sampleDevice)
  })

  it('returns minimal device fields for billingOnly logging', () => {
    expect(sanitizeDeviceForLogging(sampleDevice, 'billingOnly')).toEqual({
      app_id: 'ee.forgr.demoapp',
      device_id: 'abc123',
      version_name: '1.0.0',
      version_build: '100',
      is_emulator: false,
      is_prod: true,
    })
    expect(isBillingOnlyStatsMode('billingOnly')).toBe(true)
  })

  it('keeps full device fields for all mode logging', () => {
    expect(sanitizeDeviceForLogging(sampleDevice, 'all')).toEqual(sampleDevice)
  })
})
