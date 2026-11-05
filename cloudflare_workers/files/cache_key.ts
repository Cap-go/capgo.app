import { FILE_READ_TRACKING_QUERY_PARAMS } from '../../supabase/functions/_backend/files/file_read_cache.ts'
import { isPreviewRobotsTxtPath, isPreviewSubdomain } from '../../supabase/functions/_backend/files/preview.ts'

function getRequestHostname(request: Request): string {
  return request.headers.get('host') || new URL(request.url).hostname
}

function hasAttachmentReadPath(pathname: string): boolean {
  return pathname.startsWith('/files/read/attachments/') || pathname.startsWith('/private/files/read/attachments/')
}

function normalizeSearch(url: URL, ignoredParams: readonly string[] = []): string {
  const searchParams = new URLSearchParams(url.search)
  for (const param of ignoredParams) {
    searchParams.delete(param)
  }
  searchParams.sort()
  const search = searchParams.toString()
  return search ? `?${search}` : ''
}

function isCacheableAttachmentRead(request: Request): boolean {
  const url = new URL(request.url)
  // CLI existence checks must reach the exact-key receipt handler, including
  // its original-evidence inner cache, rather than the outer device cache.
  if (request.method !== 'GET' || request.headers.has('range')
    || url.searchParams.has('nocache') || request.headers.get('x-cli-version')?.trim()) {
    return false
  }

  return hasAttachmentReadPath(url.pathname)
}

function isCacheablePreviewRead(request: Request): boolean {
  if (request.method !== 'GET' || request.headers.has('range'))
    return false

  const hostname = getRequestHostname(request).toLowerCase()
  if (!isPreviewSubdomain(hostname))
    return false

  const url = new URL(request.url)
  const firstLabel = hostname.split('.', 1)[0]
  if (/^c\d+-/.test(firstLabel))
    return false

  return !isPreviewRobotsTxtPath(url.pathname) && url.pathname !== '/.capgo/preview.json'
}

export function buildWorkersCacheKey(request: Request): string | null {
  const url = new URL(request.url)
  if (isCacheableAttachmentRead(request))
    return `/files-cache${url.pathname}${normalizeSearch(url, FILE_READ_TRACKING_QUERY_PARAMS)}`

  if (isCacheablePreviewRead(request)) {
    const hostname = getRequestHostname(request).toLowerCase()
    return `/preview-cache/${hostname}${url.pathname}${normalizeSearch(url)}`
  }

  return null
}
