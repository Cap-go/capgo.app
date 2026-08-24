import { describe, expect, it } from 'vitest'
import { buildChannelPreviewSubdomain, buildPreviewSubdomain, encodePreviewAppId, parsePreviewHostname } from '../shared/preview-subdomain.ts'

describe('preview subdomain encoding', () => {
  it.concurrent('round-trips app IDs with reserved hostname characters', () => {
    const appId = 'Com.Example_app-name'
    const versionId = 123456
    const subdomain = buildPreviewSubdomain(appId, versionId)

    expect(subdomain).not.toMatch(/[.A-Z]/)
    expect(parsePreviewHostname(`${subdomain}.preview.capgo.app`)).toEqual({ appId, versionId })
  })

  it.concurrent('keeps dotted and double-underscore app IDs in separate preview namespaces', () => {
    const dottedAppId = 'com.pal0x.preview.cross.1774322988'
    const underscoredAppId = 'com.pal0x__preview.cross.1774322988'
    const dottedSubdomain = buildPreviewSubdomain(dottedAppId, 77014920)
    const underscoredSubdomain = buildPreviewSubdomain(underscoredAppId, 77015428)

    expect(dottedSubdomain).not.toBe(underscoredSubdomain)
    expect(parsePreviewHostname(`${dottedSubdomain}.preview.capgo.app`)).toEqual({
      appId: dottedAppId,
      versionId: 77014920,
    })
    expect(parsePreviewHostname(`${underscoredSubdomain}.preview.capgo.app`)).toEqual({
      appId: underscoredAppId,
      versionId: 77015428,
    })
  })

  it.concurrent('rejects legacy double-underscore hostnames and collision pairs', () => {
    // Legacy encoding mapped dots to `__`, so com.example.app and com.example__app
    // both became com__example__app and could share one public preview hostname.
    const legacyHostname = 'com__example__app-42.preview.capgo.app'
    expect(parsePreviewHostname(legacyHostname)).toBeNull()
    expect(parsePreviewHostname(legacyHostname)).not.toEqual({
      appId: 'com.example.app',
      versionId: 42,
    })
    expect(parsePreviewHostname(legacyHostname)).not.toEqual({
      appId: 'com.example__app',
      versionId: 42,
    })
    expect(buildPreviewSubdomain('com.example.app', 42)).not.toBe('com__example__app-42')
    expect(buildPreviewSubdomain('com.example__app', 42)).not.toBe('com__example__app-42')
  })

  it.concurrent('round-trips stable channel preview hostnames', () => {
    const appId = 'Com.Example_app-name'
    const channelId = 123456
    const subdomain = buildChannelPreviewSubdomain(appId, channelId)

    expect(subdomain).not.toMatch(/[.A-Z]/)
    expect(parsePreviewHostname(`${subdomain}.preview.capgo.app`)).toEqual({ appId, channelId })
  })

  it.concurrent('returns null for malformed hostnames', () => {
    expect(parsePreviewHostname('invalid.domain.com')).toBeNull()
    expect(parsePreviewHostname('')).toBeNull()
  })

  it.concurrent('supports version zero in the new reversible format', () => {
    const appId = 'com.example'
    const versionId = 0
    const subdomain = buildPreviewSubdomain(appId, versionId)

    expect(parsePreviewHostname(`${subdomain}.preview.capgo.app`)).toEqual({ appId, versionId })
  })

  it.concurrent('rejects legacy double-hyphen hostnames that used ambiguous decoding', () => {
    expect(parsePreviewHostname('com--example__app-42.preview.capgo.app')).toBeNull()
  })

  it.concurrent('keeps long lowercase preview labels within the DNS label limit', () => {
    const appId = 'com.organizationname.myapplicationproductionreleasex'
    const versionId = 12345678
    const subdomain = buildPreviewSubdomain(appId, versionId)

    expect(subdomain.length).toBeLessThanOrEqual(63)
    expect(parsePreviewHostname(`${subdomain}.preview.capgo.app`)).toEqual({ appId, versionId })
  })

  it.concurrent('escapes underscores instead of collapsing them into dots', () => {
    expect(encodePreviewAppId('com.example_app')).toContain('_')
  })

  it.concurrent('rejects preview labels longer than the DNS label limit', () => {
    expect(() => buildPreviewSubdomain('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDE', 1)).toThrow(
      'Preview subdomain exceeds DNS label limit: "1--a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-a-b-c-d-e" (64 characters)',
    )
  })

  it.concurrent('rejects invalid preview version ids before building labels', () => {
    expect(() => buildPreviewSubdomain('com.example', -1)).toThrow('Invalid preview version id: -1')
    expect(() => buildPreviewSubdomain('com.example', 1.5)).toThrow('Invalid preview version id: 1.5')
    expect(() => buildPreviewSubdomain('com.example', Number.MAX_SAFE_INTEGER + 1)).toThrow(
      `Invalid preview version id: ${Number.MAX_SAFE_INTEGER + 1}`,
    )
  })

  it.concurrent('rejects invalid preview channel ids before building labels', () => {
    expect(() => buildChannelPreviewSubdomain('com.example', 0)).toThrow('Invalid preview channel id: 0')
    expect(() => buildChannelPreviewSubdomain('com.example', 1.5)).toThrow('Invalid preview channel id: 1.5')
    expect(() => buildChannelPreviewSubdomain('com.example', Number.MAX_SAFE_INTEGER + 1)).toThrow(
      `Invalid preview channel id: ${Number.MAX_SAFE_INTEGER + 1}`,
    )
  })

  it.concurrent('rejects preview hostnames whose version id exceeds the safe integer range', () => {
    expect(parsePreviewHostname('9007199254740992-com-0example.preview.capgo.app')).toBeNull()
  })

  it.concurrent('rejects preview hostnames whose channel id is not a positive safe integer', () => {
    expect(parsePreviewHostname('c0-com-0example.preview.capgo.app')).toBeNull()
    expect(parsePreviewHostname('c9007199254740992-com-0example.preview.capgo.app')).toBeNull()
  })
})
