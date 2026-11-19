import { describe, expect, it } from 'vitest'
import { pickSavedOutput } from '../supabase/functions/_backend/public/build/outputs.ts'

describe('saved native build output', () => {
  const expiresAt = Date.parse('2099-01-01T00:00:00.000Z')
  const ipa = { kind: 'ios_ipa', downloadUrl: 'https://builder.example/ipa', expiresAt, fileName: 'app.ipa' }
  const apk = { kind: 'android_apk', downloadUrl: 'https://builder.example/apk', expiresAt, fileName: 'app.apk' }

  it('keeps the iOS package for an iOS build', () => {
    expect(pickSavedOutput([apk, ipa], 'ios')).toMatchObject({ url: ipa.downloadUrl, kind: 'ios_ipa', expires_at: '2099-01-01T00:00:00.000Z' })
  })

  it('keeps the Android package for an Android build', () => {
    expect(pickSavedOutput([ipa, apk], 'android')).toMatchObject({ url: apk.downloadUrl, kind: 'android_apk', expires_at: '2099-01-01T00:00:00.000Z' })
  })

  it('drops a package whose download has expired', () => {
    expect(pickSavedOutput([{ ...ipa, expiresAt: Date.parse('2020-01-01T00:00:00.000Z') }], 'ios')).toBeUndefined()
  })

  it('ignores a link that is not https', () => {
    expect(pickSavedOutput([{ ...ipa, downloadUrl: 'http://builder.example/ipa' }], 'ios')).toBeUndefined()
  })
})
