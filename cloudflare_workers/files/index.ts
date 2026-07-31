import { WorkerEntrypoint } from 'cloudflare:workers'
import { app as files } from '../../supabase/functions/_backend/files/files.ts'
import { handlePreviewRequest, isPreviewSubdomain } from '../../supabase/functions/_backend/files/preview.ts'
import { app as download_link } from '../../supabase/functions/_backend/private/download_link.ts'
import { app as upload_link } from '../../supabase/functions/_backend/private/upload_link.ts'
import { app as ok } from '../../supabase/functions/_backend/public/ok.ts'
import { createAllCatch, createHono } from '../../supabase/functions/_backend/utils/hono.ts'
import { version } from '../../supabase/functions/_backend/utils/version.ts'

export { AttachmentUploadHandler, UploadHandler } from '../../supabase/functions/_backend/files/uploadHandler.ts'

const functionName = 'files'
const app = createHono(functionName, version)
const TRACKING_QUERY_PARAMS = ['device_id'] as const

type CachedFilesLoopback = {
  fetch: (request: Request, init?: { cf?: { cacheKey: string } }) => Promise<Response>
}

type FilesExecutionContext = ExecutionContext & {
  exports?: {
    CachedFiles?: CachedFilesLoopback
  }
}

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
  if (request.method !== 'GET' || request.headers.has('range'))
    return false

  return hasAttachmentReadPath(new URL(request.url).pathname)
}

function isCacheablePreviewRead(request: Request): boolean {
  if (request.method !== 'GET' || request.headers.has('range'))
    return false

  const hostname = getRequestHostname(request).toLowerCase()
  if (!isPreviewSubdomain(hostname))
    return false

  const firstLabel = hostname.split('.', 1)[0]
  if (/^c\d+-/.test(firstLabel))
    return false

  return new URL(request.url).pathname !== '/.capgo/preview.json'
}

function buildWorkersCacheKey(request: Request): string | null {
  const url = new URL(request.url)
  if (isCacheableAttachmentRead(request))
    return `/files-cache${url.pathname}${normalizeSearch(url, TRACKING_QUERY_PARAMS)}`

  if (isCacheablePreviewRead(request)) {
    const hostname = getRequestHostname(request).toLowerCase()
    return `/preview-cache/${hostname}${url.pathname}${normalizeSearch(url)}`
  }

  return null
}

// Middleware to route preview subdomain requests
app.use('/*', async (c, next) => {
  const hostname = c.req.header('host') || ''
  if (isPreviewSubdomain(hostname)) {
    // Handle preview requests directly within this context
    return handlePreviewRequest(c)
  }
  return next()
})

// Files API
app.route('/files', files)
app.route('/ok', ok)

// TODO: remove deprecated path when all users have been migrated
app.route('/private/download_link', download_link)
app.route('/private/upload_link', upload_link)
app.route('/private/files', files)
createAllCatch(app, functionName)

export class CachedFiles extends WorkerEntrypoint {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, this.env, this.ctx)
  }
}

export const filesWorkerCacheTestUtils = {
  buildWorkersCacheKey,
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: FilesExecutionContext): Promise<Response> {
    const cacheKey = buildWorkersCacheKey(request)
    const cachedFiles = ctx.exports?.CachedFiles
    if (cacheKey && cachedFiles)
      return cachedFiles.fetch(request, { cf: { cacheKey } })

    return app.fetch(request, env, ctx)
  },
}
