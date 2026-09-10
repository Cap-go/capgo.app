import { describe, expect, it } from 'vitest'
import { parseLegacyAppsBundleKey } from '../scripts/r2_trash_utils.ts'

describe('parseLegacyAppsBundleKey', () => {
  it('parses legacy apps bundle keys', () => {
    expect(parseLegacyAppsBundleKey('apps/user-1/com.demo.app/channel/v1.2.3.zip')).toEqual({
      appId: 'com.demo.app',
      versionName: 'v1.2.3',
    })
  })

  it('returns null for non-apps keys', () => {
    expect(parseLegacyAppsBundleKey('orgs/a/apps/com.demo.app/v/1.zip')).toBeNull()
  })

  it('returns null when extra path segments are present', () => {
    expect(parseLegacyAppsBundleKey('apps/user-1/com.demo.app/channel/extra/v1.2.3.zip')).toBeNull()
  })
})
