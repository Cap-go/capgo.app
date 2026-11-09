import { describe, expect, it } from 'vitest'
import { augmentInferredCapacitorCore } from '../supabase/functions/_backend/utils/app_native_packages.ts'

describe('augmentInferredCapacitorCore', () => {
  it('does not override an explicit @capacitor/core version', () => {
    const map = new Map([['@capacitor/core', '8.0.0'], ['@capacitor/camera', '7.0.0']])
    augmentInferredCapacitorCore(map)
    expect(map.get('@capacitor/core')).toBe('8.0.0')
  })

  it('infers @capacitor/core from the highest matching @capacitor plugin version', () => {
    const map = new Map([
      ['@capgo/capacitor-updater', '8.2.0'],
      ['@capacitor/camera', '8.0.1'],
      ['@capacitor/push-notifications', '8.1.0'],
    ])
    augmentInferredCapacitorCore(map)
    expect(map.get('@capacitor/core')).toBe('8.1.0')
  })

  it('prefers @capacitor/ios when present', () => {
    const map = new Map([['@capacitor/ios', '6.2.0'], ['@capacitor/camera', '8.0.0']])
    augmentInferredCapacitorCore(map)
    expect(map.get('@capacitor/core')).toBe('6.2.0')
  })
})
