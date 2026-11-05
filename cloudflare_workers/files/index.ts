import { WorkerEntrypoint } from 'cloudflare:workers'
import { getAttachmentFileIdFromReadPath, hasDeletedFileMarker } from '../../supabase/functions/_backend/files/file_read_cache.ts'
import { app as files } from '../../supabase/functions/_backend/files/files.ts'
import { handlePreviewSubdomain, isPreviewSubdomain, withPreviewHostHeaders } from '../../supabase/functions/_backend/files/preview.ts'
import { app as download_link } from '../../supabase/functions/_backend/private/download_link.ts'
import { app as upload_link } from '../../supabase/functions/_backend/private/upload_link.ts'
import { app as ok } from '../../supabase/functions/_backend/public/ok.ts'
import { createAllCatch, createHono } from '../../supabase/functions/_backend/utils/hono.ts'
import { version } from '../../supabase/functions/_backend/utils/version.ts'
import { buildWorkersCacheKey } from './cache_key.ts'

// Upload handlers issue size receipts consumed by manifest finalization.
export { AttachmentUploadHandler, UploadHandler } from '../../supabase/functions/_backend/files/uploadHandler.ts'

const functionName = 'files'
const app = createHono(functionName, version)

interface CachedFilesLoopback {
  fetch: (request: Request, init?: { cf?: { cacheKey: string } }) => Promise<Response>
}

type FilesExecutionContext = ExecutionContext & {
  exports?: {
    CachedFiles?: CachedFilesLoopback
  }
}

// Middleware to route preview subdomain requests
app.use('/*', async (c, next) => {
  const hostname = c.req.header('host') || ''
  if (isPreviewSubdomain(hostname)) {
    // Handle preview requests directly within this context
    return handlePreviewSubdomain(c)
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
    const rawFileId = getAttachmentFileIdFromReadPath(new URL(request.url).pathname)
    let fileId: string | null = rawFileId
    if (rawFileId) {
      try {
        fileId = decodeURIComponent(rawFileId)
      }
      catch {
        // Let the files handler return its invalid-path response.
      }
    }
    if (fileId && await hasDeletedFileMarker(fileId)) {
      return withPreviewHostHeaders(request, new Response(JSON.stringify({ error: 'not_found', message: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }))
    }

    const cacheKey = buildWorkersCacheKey(request)
    const cachedFiles = ctx.exports?.CachedFiles
    if (cacheKey && cachedFiles)
      return withPreviewHostHeaders(request, await cachedFiles.fetch(request, { cf: { cacheKey } }))

    return withPreviewHostHeaders(request, await app.fetch(request, env, ctx))
  },
}
