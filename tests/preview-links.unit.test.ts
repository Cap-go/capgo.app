import { describe, expect, it } from 'vitest'
import {
  buildBundlePreviewDeepLink,
  buildChannelPreviewDeepLink,
  buildChannelPreviewLatestOptions,
  buildDeferredPreviewInstallReferrerUrl,
  hasNativeConfirmedPreview,
  isNetworkReachabilityError,
  isReachableHttpUrl,
  normalizeManualPreviewUrl,
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

describe('manual preview url normalization', () => {
  it.concurrent('assumes https for scheme-less input', () => {
    expect(normalizeManualPreviewUrl('preview.capgo.app/x')).toBe('https://preview.capgo.app/x')
  })

  it.concurrent('keeps an explicit scheme as typed', () => {
    expect(normalizeManualPreviewUrl('http://localhost:1234/x')).toBe('http://localhost:1234/x')
    expect(normalizeManualPreviewUrl('capgo://preview/bundle?appId=com.example.app&versionId=1')).toBe('capgo://preview/bundle?appId=com.example.app&versionId=1')
  })

  it.concurrent('trims and returns empty for blank input', () => {
    expect(normalizeManualPreviewUrl('   ')).toBe('')
    expect(normalizeManualPreviewUrl('  preview.capgo.app  ')).toBe('https://preview.capgo.app')
  })
})

describe('reachable http url guard', () => {
  it.concurrent('rejects a hostname with no dot', () => {
    // "capago" -> "https://capago" parses fine but resolves to nothing, so the
    // native downloader fails with a raw platform DNS error. Reject it up front.
    expect(isReachableHttpUrl(normalizeManualPreviewUrl('capago'))).toBe(false)
    expect(isReachableHttpUrl('https://capago')).toBe(false)
  })

  it.concurrent('accepts dotted domains, IP literals, and local hosts', () => {
    expect(isReachableHttpUrl('https://preview.capgo.app/.capgo/preview.json')).toBe(true)
    expect(isReachableHttpUrl('http://127.0.0.1:54321/x')).toBe(true)
    expect(isReachableHttpUrl('http://localhost:1234/x')).toBe(true)
    expect(isReachableHttpUrl('http://[::1]:1234/x')).toBe(true)
  })

  it.concurrent('rejects non-http schemes', () => {
    expect(isReachableHttpUrl('capgo://preview/bundle?appId=com.example.app&versionId=1')).toBe(false)
    expect(isReachableHttpUrl('not a url')).toBe(false)
  })
})

describe('network reachability error detection', () => {
  it.concurrent('matches native and browser transport failures', () => {
    expect(isNetworkReachabilityError('A server with the specified hostname could not be found.')).toBe(true)
    expect(isNetworkReachabilityError('The Internet connection appears to be offline.')).toBe(true)
    expect(isNetworkReachabilityError('Failed to fetch')).toBe(true)
    expect(isNetworkReachabilityError('Load failed')).toBe(true)
  })

  it.concurrent('ignores unrelated errors', () => {
    expect(isNetworkReachabilityError('Preview payload is missing a version')).toBe(false)
    expect(isNetworkReachabilityError('Encrypted bundles cannot be previewed.')).toBe(false)
  })
})
