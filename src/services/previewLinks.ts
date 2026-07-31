export interface ChannelPreviewLink {
  type: 'channel'
  appId: string
  channelId?: number
  channelName: string
  payloadUrl?: string
}

export interface BundlePreviewLink {
  type: 'bundle'
  appId?: string
  versionId?: number
  payloadUrl?: string
}

export type PreviewDeepLink = ChannelPreviewLink | BundlePreviewLink

const CHANNEL_PREVIEW_PATH = '/preview/channel'
const BUNDLE_PREVIEW_PATH = '/preview/bundle'
const CHANNEL_PREVIEW_SCHEME_URL = 'capgo://preview/channel'
const BUNDLE_PREVIEW_SCHEME_URL = 'capgo://preview/bundle'
const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
export const NATIVE_CONFIRMED_PREVIEW_PARAM = 'nativeConfirmedPreview'

function parseUrl(value: string): URL | null {
  try {
    return new URL(value.trim())
  }
  catch {
    return null
  }
}

function isAllowedWebPreviewHost(hostname: string) {
  const normalizedHostname = hostname.toLowerCase()
  return LOCAL_PREVIEW_HOSTS.has(normalizedHostname)
    || normalizedHostname === 'web.capgo.app'
    || normalizedHostname === 'console.capgo.app'
    || /^console\.(?:dev|preprod|staging)\.capgo\.app$/.test(normalizedHostname)
}

function isPreviewLinkOriginAllowed(url: URL) {
  if (url.protocol === 'capgo:')
    return true

  if (url.protocol === 'https:')
    return isAllowedWebPreviewHost(url.hostname)

  if (url.protocol === 'http:')
    return LOCAL_PREVIEW_HOSTS.has(url.hostname.toLowerCase())

  return false
}

function getPreviewPath(url: URL) {
  if (url.protocol !== 'capgo:')
    return url.pathname

  const hostPath = url.hostname ? `/${url.hostname}${url.pathname}` : url.pathname
  return hostPath.replace(/\/+/g, '/')
}

function getTrimmedParam(url: URL, ...names: string[]) {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim()
    if (value)
      return value
  }
  return undefined
}

function parseSafeIntegerParam(url: URL, names: string[], options: { min: number }) {
  const value = getTrimmedParam(url, ...names)
  if (!value || !/^\d+$/.test(value))
    return undefined

  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < options.min)
    return undefined

  return parsed
}

function getHttpUrlParam(url: URL, ...names: string[]) {
  for (const name of names) {
    const value = url.searchParams.get(name)?.trim()
    const parsed = value ? parseUrl(value) : null
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:'))
      return parsed.toString()
  }
  return undefined
}

export function buildChannelPreviewDeepLink(options: {
  appId: string
  channelId?: number
  channelName: string
  payloadUrl?: string
  origin?: string
}) {
  const url = options.origin
    ? new URL(CHANNEL_PREVIEW_PATH, options.origin)
    : new URL(CHANNEL_PREVIEW_SCHEME_URL)
  url.searchParams.set('appId', options.appId)
  url.searchParams.set('channel', options.channelName)
  if (typeof options.channelId === 'number')
    url.searchParams.set('channelId', String(options.channelId))
  if (options.payloadUrl)
    url.searchParams.set('url', options.payloadUrl)
  return url.toString()
}

export function buildBundlePreviewDeepLink(options: {
  appId?: string
  versionId?: number
  payloadUrl?: string
  origin?: string
}) {
  const url = options.origin
    ? new URL(BUNDLE_PREVIEW_PATH, options.origin)
    : new URL(BUNDLE_PREVIEW_SCHEME_URL)
  if (options.payloadUrl)
    url.searchParams.set('url', options.payloadUrl)
  if (options.appId)
    url.searchParams.set('appId', options.appId)
  if (typeof options.versionId === 'number')
    url.searchParams.set('versionId', String(options.versionId))
  return url.toString()
}

export function parsePreviewDeepLink(value: string): PreviewDeepLink | null {
  const url = parseUrl(value)
  if (!url)
    return null

  if (!isPreviewLinkOriginAllowed(url))
    return null

  const previewPath = getPreviewPath(url)
  if (previewPath !== CHANNEL_PREVIEW_PATH && previewPath !== BUNDLE_PREVIEW_PATH)
    return null

  const payloadUrl = getHttpUrlParam(url, 'url', 'payloadUrl')
  if (previewPath === BUNDLE_PREVIEW_PATH) {
    const parsedVersionId = parseSafeIntegerParam(url, ['versionId', 'bundleId'], { min: 0 })
    const appId = getTrimmedParam(url, 'appId', 'app')
    if (!payloadUrl && (!appId || typeof parsedVersionId !== 'number'))
      return null

    return {
      type: 'bundle',
      appId,
      payloadUrl,
      versionId: parsedVersionId,
    }
  }

  const appId = getTrimmedParam(url, 'appId', 'app')
  const channelName = getTrimmedParam(url, 'channel', 'channelName')
  const channelId = parseSafeIntegerParam(url, ['channelId'], { min: 1 })

  if (!appId || !channelName)
    return null

  return {
    type: 'channel',
    appId,
    channelId,
    channelName,
    payloadUrl,
  }
}

export function hasNativeConfirmedPreview(value: string) {
  const url = parseUrl(value)
  return url?.searchParams.get(NATIVE_CONFIRMED_PREVIEW_PARAM) === '1'
}

export function buildDeferredPreviewInstallReferrerUrl(value: string) {
  const previewLink = parsePreviewDeepLink(value)
  const url = parseUrl(value)
  if (!previewLink || !url || (url.protocol !== 'https:' && url.protocol !== 'http:'))
    return undefined

  const referrerUrl = new URL(getPreviewPath(url), url.origin)
  if (previewLink.type === 'channel') {
    referrerUrl.searchParams.set('appId', previewLink.appId)
    referrerUrl.searchParams.set('channel', previewLink.channelName)
    if (typeof previewLink.channelId === 'number')
      referrerUrl.searchParams.set('channelId', String(previewLink.channelId))
    return referrerUrl.toString()
  }

  if (!previewLink.appId || typeof previewLink.versionId !== 'number')
    return undefined

  referrerUrl.searchParams.set('appId', previewLink.appId)
  referrerUrl.searchParams.set('versionId', String(previewLink.versionId))
  return referrerUrl.toString()
}

const DEFERRED_PREVIEW_REFERRER_KEYS = ['capgo_preview', 'preview']

function tryDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return undefined
  }
}

function getReferrerCandidates(referrer?: string) {
  const trimmedReferrer = referrer?.trim()
  if (!trimmedReferrer)
    return []

  const referrerCandidates = new Set<string>([trimmedReferrer])
  const decodedReferrer = tryDecodeURIComponent(trimmedReferrer)
  if (decodedReferrer)
    referrerCandidates.add(decodedReferrer)
  return [...referrerCandidates]
}

function validatedPreviewLink(value: string | null) {
  const trimmedValue = value?.trim()
  if (!trimmedValue)
    return undefined

  return [trimmedValue, tryDecodeURIComponent(trimmedValue)]
    .find((candidate): candidate is string => !!candidate && !!parsePreviewDeepLink(candidate))
}

function previewLinkFromReferrerParams(candidate: string) {
  const params = new URLSearchParams(candidate)
  for (const key of DEFERRED_PREVIEW_REFERRER_KEYS) {
    const previewLink = validatedPreviewLink(params.get(key))
    if (previewLink)
      return previewLink
  }

  return undefined
}

export function previewLinkFromInstallReferrer(referrer?: string) {
  for (const candidate of getReferrerCandidates(referrer)) {
    const previewLink = validatedPreviewLink(candidate) ?? previewLinkFromReferrerParams(candidate)
    if (previewLink)
      return previewLink
  }

  return undefined
}

export function parseChannelPreviewDeepLink(value: string): ChannelPreviewLink | null {
  const previewLink = parsePreviewDeepLink(value)
  return previewLink?.type === 'channel' ? previewLink : null
}

export function buildChannelPreviewLatestOptions(previewLink: ChannelPreviewLink) {
  return {
    appId: previewLink.appId,
    channel: previewLink.channelName,
    preview: true,
  }
}
