import createDOMPurify from 'dompurify'

const HTML_ALLOWED_TAGS = [
  'a',
  'b',
  'br',
  'code',
  'em',
  'i',
  'p',
  'span',
  'strong',
  'ul',
  'ol',
  'li',
]

const HTML_ALLOWED_ATTR = ['class', 'href', 'rel', 'target', 'title']

function escapeHtmlForSsr(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/\.$/, '').toLowerCase()
}

export function isLocalDevHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
}

function parseIpv6Literal(hostname: string): string | null {
  const host = normalizeHostname(hostname)
  if (host.startsWith('[') && host.endsWith(']'))
    return host.slice(1, -1)
  if (host.includes(':') && !host.includes('.'))
    return host
  return null
}

function isPrivateIpv4(first: number, second: number): boolean {
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = normalizeHostname(hostname)
  if (isLocalDevHost(host))
    return true

  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (ipv4)
    return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]))

  const ipv6 = parseIpv6Literal(host)
  if (!ipv6)
    return false

  const lower = ipv6.toLowerCase()
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1')
    return true
  if (lower.startsWith('fe80:'))
    return true
  if (lower.startsWith('fc') || lower.startsWith('fd'))
    return true

  // User-supplied icon URLs must use DNS hostnames, not raw IPv6 literals.
  return true
}

export function sanitizeHtml(value: unknown): string {
  if (value == null)
    return ''
  const text = String(value)
  if (!text)
    return ''

  if (typeof window === 'undefined')
    return escapeHtmlForSsr(text)

  return createDOMPurify(window).sanitize(text, {
    ALLOWED_TAGS: HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: HTML_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}

/**
 * Restricts user-supplied http(s) URLs used in links or fetches.
 */
export function sanitizeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string')
    return null

  const trimmed = value.trim()
  if (!trimmed)
    return null

  let url: URL
  try {
    url = new URL(trimmed)
  }
  catch {
    return null
  }

  const allowsLocalHttp = isLocalDevHost(url.hostname) && url.protocol === 'http:'
  const allowsHttps = url.protocol === 'https:'

  if (!allowsHttps && !allowsLocalHttp)
    return null

  return url.toString()
}

export function isSafeImageFetchUrl(value: unknown): boolean {
  const sanitized = sanitizeHttpUrl(value)
  if (!sanitized)
    return false

  try {
    const url = new URL(sanitized)
    if (url.protocol !== 'https:')
      return false
    return !isPrivateOrLoopbackHost(url.hostname)
  }
  catch {
    return false
  }
}
