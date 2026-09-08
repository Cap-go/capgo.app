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

export function isLocalDevHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  if (isLocalDevHost(hostname))
    return true

  const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!ipv4)
    return false

  const first = Number(ipv4[1])
  const second = Number(ipv4[2])
  return first === 0
    || first === 10
    || first === 127
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
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
