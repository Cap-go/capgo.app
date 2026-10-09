import { describe, expect, it } from 'vitest'
import {
  buildBundlePreviewDeepLink,
  buildChannelPreviewDeepLink,
  buildChannelPreviewLatestOptions,
  buildDeferredPreviewInstallReferrerUrl,
  hasNativeConfirmedPreview,
  normalizeScannedPreviewValue,
  parseChannelPreviewDeepLink,
  parsePreviewDeepLink,
  previewLinkFromInstallReferrer,
} from '../src/services/previewLinks.ts'

describe('channel preview deep links', () => {
  it.concurrent('generates payload-backed capgo channel preview links', () => {
    const previewUrl = buildChannelPreviewDeepLink({
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: 'https://c42-com_u2eexample.preview.capgo.app/.capgo/preview.json',
    })

    expect(previewUrl).toBe('capgo://preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42&url=https%3A%2F%2Fc42-com_u2eexample.preview.capgo.app%2F.capgo%2Fpreview.json')
    expect(parseChannelPreviewDeepLink(previewUrl)).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: 'https://c42-com_u2eexample.preview.capgo.app/.capgo/preview.json',
    })
  })

  it.concurrent('keeps legacy channel links usable as updater payload fallback', () => {
    const previewUrl = buildChannelPreviewDeepLink({
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      origin: 'https://web.capgo.app',
    })

    const previewLink = parseChannelPreviewDeepLink(previewUrl)
    if (!previewLink)
      throw new Error('Expected generated preview link to parse')

    expect(previewLink).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: undefined,
    })
    expect(buildChannelPreviewLatestOptions(previewLink)).toEqual({
      appId: 'com.example.other-user-app',
      channel: 'preview',
      preview: true,
    })
  })

  it.concurrent('generates web channel preview links for app-link QR fallback', () => {
    const previewUrl = buildChannelPreviewDeepLink({
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      origin: 'https://console.capgo.app',
    })

    expect(previewUrl).toBe('https://console.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')
    expect(parseChannelPreviewDeepLink(previewUrl)).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: undefined,
    })
  })

  it.concurrent('only parses web preview routes from trusted Capgo or local hosts', () => {
    expect(parseChannelPreviewDeepLink('https://web.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: undefined,
    })
    expect(parseChannelPreviewDeepLink('http://localhost:5173/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: undefined,
    })
    expect(parseChannelPreviewDeepLink('https://evil.example/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')).toBeNull()
    expect(parseChannelPreviewDeepLink('http://web.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')).toBeNull()
  })

  it.concurrent('generates compact channel preview deep links for QR codes', () => {
    const previewUrl = buildChannelPreviewDeepLink({
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
    })

    expect(previewUrl).toBe('capgo://preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')
    expect(parseChannelPreviewDeepLink(previewUrl)).toEqual({
      type: 'channel',
      appId: 'com.example.other-user-app',
      channelId: 42,
      channelName: 'preview',
      payloadUrl: undefined,
    })
  })

  it.concurrent('parses scanned native preview links robustly', () => {
    expect(parseChannelPreviewDeepLink(' capgo://preview/channel?appId=app.capgo.capacitor.navigation&channel=production&channelId=36706 ')).toEqual({
      type: 'channel',
      appId: 'app.capgo.capacitor.navigation',
      channelId: 36706,
      channelName: 'production',
      payloadUrl: undefined,
    })
    expect(parseChannelPreviewDeepLink('capgo:/preview/channel?appId=app.capgo.capacitor.navigation&channel=production&channelId=36706')).toEqual({
      type: 'channel',
      appId: 'app.capgo.capacitor.navigation',
      channelId: 36706,
      channelName: 'production',
      payloadUrl: undefined,
    })
  })

  it.concurrent('generates bundle preview deep links with a payload URL', () => {
    const previewUrl = buildBundlePreviewDeepLink({
      appId: 'com.example.other-user-app',
      payloadUrl: 'https://42-com_u2eexample.preview.capgo.app/.capgo/preview.json',
      versionId: 42,
    })

    expect(parsePreviewDeepLink(previewUrl)).toEqual({
      type: 'bundle',
      appId: 'com.example.other-user-app',
      payloadUrl: 'https://42-com_u2eexample.preview.capgo.app/.capgo/preview.json',
      versionId: 42,
    })
  })

  it.concurrent('generates compact bundle preview deep links for QR codes', () => {
    const previewUrl = buildBundlePreviewDeepLink({
      appId: 'com.example.other-user-app',
      versionId: 42,
    })

    expect(previewUrl).toBe('capgo://preview/bundle?appId=com.example.other-user-app&versionId=42')
    expect(parsePreviewDeepLink(previewUrl)).toEqual({
      type: 'bundle',
      appId: 'com.example.other-user-app',
      payloadUrl: undefined,
      versionId: 42,
    })
  })

  it.concurrent('detects native-confirmed preview links without changing parsing', () => {
    const previewUrl = 'capgo://preview/bundle?appId=com.example.other-user-app&versionId=42&nativeConfirmedPreview=1'

    expect(hasNativeConfirmedPreview(previewUrl)).toBe(true)
    expect(hasNativeConfirmedPreview('capgo://preview/bundle?appId=com.example.other-user-app&versionId=42')).toBe(false)
    expect(parsePreviewDeepLink(previewUrl)).toEqual({
      type: 'bundle',
      appId: 'com.example.other-user-app',
      payloadUrl: undefined,
      versionId: 42,
    })
  })

  it.concurrent('generates web bundle preview links for app-link QR fallback', () => {
    const previewUrl = buildBundlePreviewDeepLink({
      appId: 'com.example.other-user-app',
      origin: 'https://console.capgo.app',
      versionId: 42,
    })

    expect(previewUrl).toBe('https://console.capgo.app/preview/bundle?appId=com.example.other-user-app&versionId=42')
    expect(parsePreviewDeepLink(previewUrl)).toEqual({
      type: 'bundle',
      appId: 'com.example.other-user-app',
      payloadUrl: undefined,
      versionId: 42,
    })
  })

  it.concurrent('extracts trusted preview links from Android install referrers', () => {
    const previewUrl = 'https://console.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42'
    const referrer = new URLSearchParams({
      capgo_preview: previewUrl,
      utm_source: 'qr-preview',
    }).toString()

    expect(previewLinkFromInstallReferrer(referrer)).toBe(previewUrl)
    expect(previewLinkFromInstallReferrer(encodeURIComponent(referrer))).toBe(previewUrl)
  })

  it.concurrent('strips preview payload URLs from Android install referrers', () => {
    expect(buildDeferredPreviewInstallReferrerUrl('https://console.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42&url=https%3A%2F%2Fpayload.example%2Fpreview.json')).toBe('https://console.capgo.app/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42')
    expect(buildDeferredPreviewInstallReferrerUrl('https://console.capgo.app/preview/bundle?appId=com.example.other-user-app&versionId=42&url=https%3A%2F%2Fpayload.example%2Fpreview.json')).toBe('https://console.capgo.app/preview/bundle?appId=com.example.other-user-app&versionId=42')
    expect(buildDeferredPreviewInstallReferrerUrl('https://console.capgo.app/preview/bundle?url=https%3A%2F%2Fpayload.example%2Fpreview.json')).toBeUndefined()
  })

  it.concurrent('rejects untrusted install referrer preview links', () => {
    const referrer = new URLSearchParams({
      capgo_preview: 'https://evil.example/preview/channel?appId=com.example.other-user-app&channel=preview&channelId=42',
    }).toString()

    expect(previewLinkFromInstallReferrer(referrer)).toBeUndefined()
  })

  it.concurrent('rejects malformed bundle preview identifiers', () => {
    expect(parsePreviewDeepLink('capgo://preview/bundle?appId=com.example.other-user-app&versionId=1.5')).toBeNull()
    expect(parsePreviewDeepLink('capgo://preview/bundle?appId=com.example.other-user-app&versionId=-1')).toBeNull()
    expect(parsePreviewDeepLink(`capgo://preview/bundle?appId=com.example.other-user-app&versionId=${Number.MAX_SAFE_INTEGER + 1}`)).toBeNull()
  })
})

describe('scanned preview value normalization', () => {
  const deepLink = 'capgo://preview/channel?appId=com.example.app&channel=pr-12&channelId=7'

  it.concurrent.each([
    deepLink,
    `  ${deepLink}\n`,
    `"${deepLink}"`,
    `<${deepLink}>`,
    `Open on your phone: ${deepLink}.`,
    `[preview](${deepLink})`,
    `​${deepLink}﻿`,
  ])('extracts the preview link from %j', (scanned) => {
    const value = normalizeScannedPreviewValue(scanned)
    expect(value).toBe(deepLink)
    expect(parsePreviewDeepLink(value)).toMatchObject({ type: 'channel', channelName: 'pr-12', channelId: 7 })
  })

  it.concurrent('keeps https preview hosts intact', () => {
    expect(normalizeScannedPreviewValue(' https://c7-com_u2eexample.preview.capgo.app/ ')).toBe('https://c7-com_u2eexample.preview.capgo.app/')
  })

  it.concurrent('returns non-url text trimmed', () => {
    expect(normalizeScannedPreviewValue('  hello  ')).toBe('hello')
  })
})

describe('scanned preview value edge cases', () => {
  it.concurrent('keeps a clean payload verbatim, including a channel name ending in a dot', () => {
    const link = 'capgo://preview/channel?appId=com.example.app&channel=v1.&channelId=3'
    expect(normalizeScannedPreviewValue(link)).toBe(link)
    expect(normalizeScannedPreviewValue(`  ${link}\n`)).toBe(link)
  })

  it.concurrent('prefers a later capgo link over an earlier https URL', () => {
    const link = 'capgo://preview/channel?appId=io.demo&channel=main'
    expect(normalizeScannedPreviewValue(`See https://capgo.app for help, then: ${link}`)).toBe(link)
  })

  it.concurrent('keeps balanced parentheses inside the URL', () => {
    const link = 'capgo://preview/bundle?appId=x&versionId=7&url=https://example.com/foo(bar)'
    expect(normalizeScannedPreviewValue(link)).toBe(link)
    expect(normalizeScannedPreviewValue(`(open ${link})`)).toBe(link)
  })
})
