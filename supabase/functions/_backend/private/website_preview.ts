import { createHono, parseBody, quickError, useCors } from '../utils/hono.ts'
import { middlewareAuth } from '../utils/hono_jwt.ts'
import { fetchPublicUrl, getPublicHostnameValidationError as getPublicHostnameValidationErrorBase } from '../utils/publicUrl.ts'
import { version } from '../utils/version.ts'

const MAX_ICON_BYTES = 512 * 1024
const MAX_HTML_BYTES = 1024 * 1024
const MAX_REDIRECTS = 5
const WEBSITE_URL_VALIDATION_MESSAGES = {
  invalidUrl: 'Website must be a valid URL',
  publicHost: 'Website must point to a public host',
  ipLiteral: 'Website must point to a public host',
  https: 'Website must use HTTPS',
  dnsResolution: 'Could not resolve website host',
  fetchFailed: 'Could not fetch website',
  tooManyRedirects: 'Too many redirects',
}

export const app = createHono('', version)

app.use('/', useCors)

function normalizeWebsiteUrl(input: string) {
  const trimmed = input.trim()
  if (!trimmed)
    return ''

  try {
    const normalized = new URL(/^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (normalized.username || normalized.password)
      return ''
    return normalized.toString()
  }
  catch {
    return ''
  }
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: '&',
    apos: '\'',
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16)
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint)
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10)
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint)
    }

    return namedEntities[entity.toLowerCase()] ?? match
  }).trim()
}

function deriveNameFromHostname(hostname: string) {
  const segment = hostname.replace(/^www\./, '').split('.').filter(Boolean)[0] ?? ''
  return segment
    .split(/[-_]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeCandidateName(value: string, hostname: string, options?: { preferLeadingSegment?: boolean }) {
  const trimmed = decodeHtmlEntities(value).trim()
  if (!trimmed)
    return ''

  const withoutProtocol = trimmed.replace(/^https?:\/\//i, '').replace(/^www\./i, '')
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(withoutProtocol) && !withoutProtocol.includes(' ')) {
    return deriveNameFromHostname(withoutProtocol)
  }

  const parts = options?.preferLeadingSegment
    ? trimmed.split(/\s[|·•:–—-]\s|[|·•:–—]/).map(part => part.trim()).filter(Boolean)
    : [trimmed]

  const candidate = parts[0] ?? trimmed
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate) && !candidate.includes(' ')) {
    return deriveNameFromHostname(candidate)
  }

  return candidate
}

const META_PATTERNS = {
  'application-name': [
    /<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']application-name["'][^>]*>/i,
  ],
  'og:site_name': [
    /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["'][^>]*>/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["'][^>]*>/i,
  ],
} as const

function findMetaContent(html: string, key: keyof typeof META_PATTERNS) {
  const patterns = META_PATTERNS[key]

  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match?.[1])
      return decodeHtmlEntities(match[1])
  }

  return ''
}

function findTitle(html: string) {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html)
  return match?.[1] ? decodeHtmlEntities(match[1]) : ''
}

function findIconHref(html: string) {
  const linkRegex = /<link\b[^>]*>/gi
  const candidates: Array<{ priority: number, href: string }> = []

  for (const tag of html.match(linkRegex) ?? []) {
    const rel = /rel=["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
    if (!href || !rel.includes('icon'))
      continue

    const priority = rel.includes('apple-touch-icon')
      ? 3
      : rel.includes('shortcut')
        ? 2
        : 1

    candidates.push({ priority, href })
  }

  return candidates.sort((a, b) => b.priority - a.priority)[0]?.href ?? ''
}

async function getWebsitePublicHostnameValidationError(urlString: string) {
  return await getPublicHostnameValidationErrorBase(urlString, {
    messages: WEBSITE_URL_VALIDATION_MESSAGES,
    requireDnsResolution: true,
  })
}

async function readResponseTextWithLimit(response: Response, limit: number) {
  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > limit)
    return null

  if (!response.body)
    return await response.text()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done)
      break

    if (!value)
      continue

    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

async function fetchValidatedUrl(
  urlString: string,
  init?: RequestInit,
) {
  return await fetchPublicUrl(urlString, init, {
    messages: WEBSITE_URL_VALIDATION_MESSAGES,
    requireDnsResolution: true,
    maxRedirects: MAX_REDIRECTS,
  })
}

async function fetchIconDataUrl(iconUrl: string) {
  const { error, response } = await fetchValidatedUrl(iconUrl)
  if (error || !response)
    return null

  if (!response.ok)
    return null

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!contentType.startsWith('image/'))
    return null

  const contentLength = Number.parseInt(response.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(contentLength) && contentLength > MAX_ICON_BYTES)
    return null

  const arrayBuffer = await response.arrayBuffer()
  if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_ICON_BYTES)
    return null

  const bytes = new Uint8Array(arrayBuffer)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize)
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))

  return `data:${contentType};base64,${btoa(binary)}`
}

app.post('/', middlewareAuth, async (c) => {
  const body = await parseBody<{ website?: string }>(c)
  const rawWebsite = body.website
  if (typeof rawWebsite !== 'string' || rawWebsite.trim() === '')
    return quickError(400, 'invalid_website', 'Website must be a valid URL')

  const website = normalizeWebsiteUrl(rawWebsite.trim())
  if (!website)
    return quickError(400, 'invalid_website', 'Website must be a valid URL')

  const websiteValidationError = await getWebsitePublicHostnameValidationError(website)
  if (websiteValidationError)
    return quickError(400, 'invalid_website', websiteValidationError)

  const { error: fetchError, response, finalUrl } = await fetchValidatedUrl(website, {
    headers: {
      'User-Agent': 'CapgoWebsitePreview/1.0',
      'Accept': 'text/html,application/xhtml+xml',
    },
  })
  if (fetchError || !response)
    return quickError(400, 'invalid_website', fetchError ?? 'Could not fetch website')

  if (!response.ok)
    return quickError(400, 'website_fetch_failed', 'Could not fetch website')

  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!contentType.includes('html'))
    return quickError(400, 'website_not_html', 'Website did not return HTML')

  const html = await readResponseTextWithLimit(response, MAX_HTML_BYTES)
  if (!html)
    return quickError(400, 'website_too_large', 'Website response is too large')
  const finalUrlParsed = new URL(finalUrl ?? response.url)
  const hostname = finalUrlParsed.hostname.replace(/^www\./, '')

  const name = normalizeCandidateName(findMetaContent(html, 'og:site_name'), hostname)
    || normalizeCandidateName(findMetaContent(html, 'application-name'), hostname)
    || normalizeCandidateName(findTitle(html), hostname, { preferLeadingSegment: true })
    || deriveNameFromHostname(hostname)

  const iconHref = findIconHref(html)
  const iconUrl = iconHref ? new URL(iconHref, finalUrlParsed).toString() : ''
  const icon = iconUrl ? await fetchIconDataUrl(iconUrl) : null

  return c.json({
    website: finalUrlParsed.toString(),
    hostname,
    name,
    icon,
  })
})
