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
