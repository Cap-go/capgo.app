import type { Database } from '../supabase/functions/_backend/utils/supabase.types.ts'
import { describe, expect, it, vi } from 'vitest'
import { isOnBuiltinVersion, resolveChannelUpdatePackage, resToVersion } from '../supabase/functions/_backend/plugin_runtime/utils/update.ts'

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/org_email_notifications.ts', () => ({
  sendNotifToOrgMembersCached: vi.fn(() => Promise.resolve()),
}))

const appVersion = {
  name: '1.2.3',
  session_key: 'session-key',
  checksum: 'checksum',
  link: 'https://capgo.app/changelog/1.2.3',
  comment: 'Release notes',
} as Database['public']['Tables']['app_versions']['Row']

const manifest = [{
  file_name: 'assets/app.js',
  file_hash: 'hash',
  s3_path: 'apps/com.test.app/1.2.3/assets/app.js',
  download_url: 'https://files.capgo.app/assets/app.js',
}]

describe('update response shaping', () => {
  it.concurrent('uses simple plugin versions for manifest and metadata thresholds', () => {
    expect(resToVersion('8.34.9', 'https://bundle.zip', appVersion, manifest, true)).toMatchObject({
      manifest,
    })
    expect(resToVersion('8.34.9', 'https://bundle.zip', appVersion, manifest, true)).not.toHaveProperty('link')

    expect(resToVersion('8.35.0', 'https://bundle.zip', appVersion, manifest, true)).toMatchObject({
      manifest,
      link: appVersion.link,
      comment: appVersion.comment,
    })
  })

  it.concurrent('falls back to semver parsing for prerelease plugin versions', () => {
    const response = resToVersion('8.35.0-beta.1', 'https://bundle.zip', appVersion, manifest, true)

    expect(response).toMatchObject({ manifest })
    expect(response).not.toHaveProperty('link')
    expect(response).not.toHaveProperty('comment')
  })
})

describe('channel update package resolution', () => {
  it.concurrent('keeps both zip and delta by default', () => {
    expect(resolveChannelUpdatePackage('all', false)).toBe('all')
    expect(resolveChannelUpdatePackage('all', true)).toBe('all')
    expect(resolveChannelUpdatePackage(undefined, true)).toBe('all')
  })

  it.concurrent('forces zip or delta for every device', () => {
    expect(resolveChannelUpdatePackage('zip', false)).toBe('zip')
    expect(resolveChannelUpdatePackage('zip', true)).toBe('zip')
    expect(resolveChannelUpdatePackage('delta', false)).toBe('delta')
    expect(resolveChannelUpdatePackage('delta', true)).toBe('delta')
  })

  it.concurrent('applies builtin-only modes only on the store binary', () => {
    expect(resolveChannelUpdatePackage('zip_from_builtin', true)).toBe('zip')
    expect(resolveChannelUpdatePackage('zip_from_builtin', false)).toBe('all')
    expect(resolveChannelUpdatePackage('delta_from_builtin', true)).toBe('delta')
    expect(resolveChannelUpdatePackage('delta_from_builtin', false)).toBe('all')
    expect(isOnBuiltinVersion('1.0.0', '1.0.0')).toBe(true)
    expect(isOnBuiltinVersion('builtin', '1.0.0')).toBe(true)
    expect(isOnBuiltinVersion('1.0.1', '1.0.0')).toBe(false)
  })
})

describe('signed bundle metadata', () => {
  const signature = 'a'.repeat(512)
  const manifestSignature = 'b'.repeat(512)
  const signedVersion = { ...appVersion, signature, manifest_signature: manifestSignature } as Database['public']['Tables']['app_versions']['Row']

  it.concurrent('returns signature and manifest_signature to plugin v8.53.0+', () => {
    expect(resToVersion('8.53.0', 'https://bundle.zip', signedVersion, manifest, false)).toMatchObject({
      signature,
      manifest_signature: manifestSignature,
    })
    expect(resToVersion('8.60.1', 'https://bundle.zip', signedVersion, manifest, false)).toMatchObject({
      signature,
      manifest_signature: manifestSignature,
    })
  })

  it.concurrent('returns the fields to any major above 8', () => {
    expect(resToVersion('9.0.0', 'https://bundle.zip', signedVersion, manifest, false)).toMatchObject({
      signature,
      manifest_signature: manifestSignature,
    })
  })

  it.concurrent('omits the fields for older v8 and for every plugin below v8', () => {
    for (const pluginVersion of ['8.52.9', '8.35.0', '8.53.0-beta.1', '7.99.0', '6.99.0', '5.99.0', '4.99.0', '1.0.0']) {
      const response = resToVersion(pluginVersion, 'https://bundle.zip', signedVersion, manifest, true)
      expect(response, pluginVersion).not.toHaveProperty('signature')
      expect(response, pluginVersion).not.toHaveProperty('manifest_signature')
    }
  })

  it.concurrent('omits the fields when the bundle was not signed', () => {
    const unsigned = { ...appVersion, signature: null, manifest_signature: null } as Database['public']['Tables']['app_versions']['Row']
    const response = resToVersion('8.53.0', 'https://bundle.zip', unsigned, manifest, false)
    expect(response).not.toHaveProperty('signature')
    expect(response).not.toHaveProperty('manifest_signature')
    expect(Object.keys(response).sort()).toEqual(['checksum', 'manifest', 'session_key', 'url', 'version'])
  })

  it.concurrent('includes only the signature that exists (zip-only upload)', () => {
    const zipOnly = { ...appVersion, signature, manifest_signature: null } as Database['public']['Tables']['app_versions']['Row']
    const response = resToVersion('8.53.0', 'https://bundle.zip', zipOnly, [], false)
    expect(response).toMatchObject({ signature })
    expect(response).not.toHaveProperty('manifest_signature')
  })
})
