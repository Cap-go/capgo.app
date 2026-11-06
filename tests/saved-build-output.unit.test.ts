import { describe, expect, it } from 'vitest'
import { pickSavedOutput } from '../supabase/functions/_backend/public/build/outputs.ts'

describe('saved native build output', () => {
  const ipa = { kind: 'ios_ipa', downloadUrl: 'https://builder.example/ipa', expiresAt: 1_700_000_000_000, fileName: 'app.ipa' }
  const apk = { kind: 'android_apk', downloadUrl: 'https://builder.example/apk', expiresAt: 1_700_000_000_000, fileName: 'app.apk' }

  it('keeps the iOS package for an iOS build', () => {
    expect(pickSavedOutput([apk, ipa], 'ios')).toMatchObject({ url: ipa.downloadUrl, kind: 'ios_ipa' })
  })

  it('keeps the Android package for an Android build', () => {
    expect(pickSavedOutput([ipa, apk], 'android')).toMatchObject({ url: apk.downloadUrl, kind: 'android_apk' })
  })

  it('ignores a link that is not https', () => {
    expect(pickSavedOutput([{ ...ipa, downloadUrl: 'http://builder.example/ipa' }], 'ios')).toBeUndefined()
  })
})
