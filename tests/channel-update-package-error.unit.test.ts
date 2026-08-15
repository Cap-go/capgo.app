import { describe, expect, it } from 'vitest'
import { channelUpdatePackageErrorKey } from '../src/services/channelUpdatePackageError.ts'

describe('channelUpdatePackageErrorKey', () => {
  it('maps zip mismatch messages', () => {
    expect(channelUpdatePackageErrorKey({
      message: 'CHANNEL_ZIP_REQUIRED: Channel "production" requires a zip package, but bundle "1.2.3" has no zip.',
    })).toBe('update-package-zip-required')
  })

  it('maps delta mismatch messages', () => {
    expect(channelUpdatePackageErrorKey({
      message: 'CHANNEL_DELTA_REQUIRED: Channel "production" requires delta files, but bundle "1.0.0" has none.',
    })).toBe('update-package-delta-required')
  })

  it('maps API error codes', () => {
    expect(channelUpdatePackageErrorKey({
      error: 'channel_zip_required',
      message: 'This channel requires a zip package, but the bundle has no zip.',
    })).toBe('update-package-zip-required')
    expect(channelUpdatePackageErrorKey({
      error: 'channel_delta_required',
      message: 'This channel requires a delta package, but the bundle has no delta files.',
    })).toBe('update-package-delta-required')
  })

  it('ignores unrelated errors', () => {
    expect(channelUpdatePackageErrorKey({ message: 'permission denied' })).toBeNull()
    expect(channelUpdatePackageErrorKey(null)).toBeNull()
  })
})
