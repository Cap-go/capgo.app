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

  it('ignores unrelated errors', () => {
    expect(channelUpdatePackageErrorKey({ message: 'permission denied' })).toBeNull()
    expect(channelUpdatePackageErrorKey(null)).toBeNull()
  })
})
