import type { Context } from 'hono'
import type { MiddlewareKeyVariables } from '../../utils/hono.ts'
import { quickError } from '../../utils/hono.ts'

export interface FetchStoreMetadataBody {
  url?: string
}

interface AppleLookupResult {
  trackName?: string
  artworkUrl512?: string
  artworkUrl100?: string
  bundleId?: string
  screenshotUrls?: string[]
}

const ALLOWED_STORE_HOSTS = new Set([
  'apps.apple.com',
  'itunes.apple.com',
  'play.google.com',
  'play-lh.googleusercontent.com',
  'play.googleusercontent.com',
])

function uint8ArrayToBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCodePoint(...chunk)
  }

  return btoa(binary)
}

async function fetchIconDataUrl(iconUrl: string | null) {
  if (!iconUrl)
    return null

  try {
    assertAllowedStoreUrl(iconUrl)
    const response = await fetch(iconUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; CapgoOnboardingBot/1.0)',
        'accept-language': 'en-US,en;q=0.9',
      },
    })

    if (!response.ok)
      return null

    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    const bytes = new Uint8Array(await response.arrayBuffer())
    return `data:${contentType};base64,${uint8ArrayToBase64(bytes)}`
  }
  catch {
    return null
  }
}

function assertAllowedStoreUrl(rawUrl: string) {
  const parsedUrl = new URL(rawUrl)

  if (parsedUrl.protocol !== 'https:' || !ALLOWED_STORE_HOSTS.has(parsedUrl.hostname.toLowerCase()))
    throw quickError(400, 'invalid_url', 'Only official App Store and Google Play URLs are allowed', { url: rawUrl })

  return parsedUrl
}

function extractAndroidAppId(url: URL) {
  const host = url.hostname.toLowerCase()
  if (host !== 'play.google.com') {
    return null
  }

  const appId = url.searchParams.get('id')?.trim()
  return appId || null
}

function extractAppleStoreId(url: URL) {
  const host = url.hostname.toLowerCase()
  if (host !== 'apps.apple.com') {
    return null
  }

  const match = /\/id(\d+)(?:[/?#]|$)/i.exec(url.pathname)
  return match?.[1] ?? null
}

async function fetchAppleLookupMetadata(storeId: string) {
  const lookupUrl = new URL('https://itunes.apple.com/lookup')
  lookupUrl.searchParams.set('id', storeId)

  const response = await fetch(lookupUrl.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; CapgoOnboardingBot/1.0)',
      'accept-language': 'en-US,en;q=0.9',
    },
  })

  if (!response.ok) {
    return null
  }

  const data = await response.json() as { results?: AppleLookupResult[] }
  return data.results?.[0] ?? null
}

function extractMetaTag(html: string, name: string) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${name}["']`, 'i'),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, 'i'),
  ]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1])
      return decodeHtml(match[1])
  }

  return ''
}

function extractTitle(html: string) {
  const titleMatch = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return titleMatch?.[1] ? decodeHtml(titleMatch[1]) : ''
}

function decodeHtml(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function normalizeStoreName(name: string, url: URL) {
  const trimmed = name.trim()
  const host = url.hostname.toLowerCase()

  if (host === 'play.google.com') {
    return trimmed
      .replace(/[-|:]\s*Apps on Google Play\s*$/gi, '')
      .replace(/[-|:]\s*Google Play\s*$/gi, '')
      .trim()
  }

  return trimmed
}

export async function fetchStoreMetadata(c: Context<MiddlewareKeyVariables>, body: FetchStoreMetadataBody): Promise<Response> {
  if (!body.url) {
    throw quickError(400, 'missing_url', 'Missing store URL')
  }

  let parsedUrl: URL
  try {
    parsedUrl = assertAllowedStoreUrl(body.url)
  }
  catch {
    throw quickError(400, 'invalid_url', 'Invalid store URL', { url: body.url })
  }

  const response = await fetch(parsedUrl.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; CapgoOnboardingBot/1.0)',
      'accept-language': 'en-US,en;q=0.9',
    },
  })

  if (!response.ok) {
    throw quickError(400, 'cannot_fetch_store_metadata', 'Unable to fetch store metadata', {
      status: response.status,
      url: parsedUrl.toString(),
    })
  }

  const html = await response.text()
  const scrapedName = extractMetaTag(html, 'og:title') || extractMetaTag(html, 'twitter:title') || extractTitle(html)
  const scrapedIconUrl = extractMetaTag(html, 'og:image') || extractMetaTag(html, 'twitter:image')
  const android_app_id = extractAndroidAppId(parsedUrl)
  const appleStoreId = extractAppleStoreId(parsedUrl)
  const appleLookup = appleStoreId ? await fetchAppleLookupMetadata(appleStoreId) : null
  const ios_bundle_id = appleLookup?.bundleId?.trim() || null
  const screenshot_url = appleLookup?.screenshotUrls?.[0]?.trim() || null
  const app_id = android_app_id || ios_bundle_id
  const name = appleLookup?.trackName?.trim() || normalizeStoreName(scrapedName, parsedUrl)
  const icon_url = appleLookup?.artworkUrl512?.trim() || appleLookup?.artworkUrl100?.trim() || scrapedIconUrl
  const icon_data_url = await fetchIconDataUrl(icon_url)

  return c.json({
    status: 'ok',
    name,
    icon_url,
    icon_data_url,
    screenshot_url,
    app_id,
    android_app_id,
    ios_bundle_id,
    url: parsedUrl.toString(),
  })
}
