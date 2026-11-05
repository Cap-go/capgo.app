import createDOMPurify from 'dompurify'

// URL helpers live in urlSafety.ts so callers that only need them skip DOMPurify.
export { isLocalDevHost, isSafeImageFetchUrl, sanitizeHttpUrl } from './urlSafety'

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
