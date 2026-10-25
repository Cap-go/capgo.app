import type { Database } from '../../utils/supabase.types.ts'
import type { RequestBuildBody } from './request.ts'
import type { BuildStatusParams } from './status.ts'
import type { SupportLogsBody } from './support_logs.ts'
import {
  ALLOWED_HEADERS,
  ALLOWED_METHODS,
  EXPOSED_HEADERS,
  MAX_UPLOAD_LENGTH_BYTES,
  TUS_EXTENSIONS,
  TUS_VERSION,
} from '../../files/util.ts'
import { getBodyOrQuery, honoFactory } from '../../utils/hono.ts'
import { middlewareKey } from '../../utils/hono_middleware.ts'
import { aiAnalyzeDeprecated } from './ai_analyze.ts'
import { aiAnalyzeStreamBuild } from './ai_analyze_stream.ts'
import { cancelBuild } from './cancel.ts'
import { reportBuilderCapacity } from './capacity.ts'
import {
  createBuildCredentialsUploadUrl,
  deleteBuildCredentials,
  getBuildCredentialsStatus,
  putBuildCredentials,
  uploadBuildCredentialsWithToken,
} from './credentials.ts'
import { streamBuildLogs } from './logs.ts'
import { requestBuild } from './request.ts'
import { startBuild } from './start.ts'
import { getBuildStatus } from './status.ts'
import { uploadSupportLogs } from './support_logs.ts'
import { tusProxy } from './upload.ts'
import { getBuildUploadUrl } from './upload_url.ts'

export const app = honoFactory.createApp()

// POST /build/capacity - Builder pool-size report, acknowledged only (history lives in the admin dashboard). Auth: BUILDER_API_KEY.
app.post('/capacity', async (c) => {
  return reportBuilderCapacity(c)
})

const uploadWriteMiddleware = middlewareKey(['all', 'write'])

// POST /build/request - Request a new native build
app.post('/request', middlewareKey(['all', 'write']), async (c) => {
  const body = await getBodyOrQuery<RequestBuildBody>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return requestBuild(c, body, apikey)
})

// POST /build/start/:jobId - Start a build after uploading bundle
app.post('/start/:jobId', middlewareKey(['all', 'write']), async (c) => {
  const jobId = c.req.param('jobId')
  const body = await getBodyOrQuery<{ app_id: string }>(c)
  if (!body.app_id) {
    throw new Error('app_id is required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return startBuild(c, jobId, body.app_id, apikey)
})

// GET /build/status - Get build status and record billing
app.get('/status', middlewareKey(['all', 'read']), async (c) => {
  const params = await getBodyOrQuery<BuildStatusParams>(c)
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return getBuildStatus(c, params, apikey)
})

// GET /build/logs/:jobId - Stream build logs (SSE, requires app_id query param)
app.get('/logs/:jobId', middlewareKey(['all', 'read']), async (c) => {
  const jobId = c.req.param('jobId')
  const appId = c.req.query('app_id')
  if (!appId) {
    throw new Error('app_id query parameter is required')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return streamBuildLogs(c, jobId, appId, apikey)
})

// POST /build/cancel/:jobId - Cancel a running build
app.post('/cancel/:jobId', middlewareKey(['all', 'write']), async (c) => {
  const jobId = c.req.param('jobId')
  const body = await getBodyOrQuery<{ app_id: string }>(c)
  if (!body.app_id) {
    throw new Error('app_id is required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return cancelBuild(c, jobId, body.app_id, apikey)
})

// POST /build/upload_url/:jobId - Signed single-PUT URL for the project archive (TUS-free clients, hosted MCP)
app.post('/upload_url/:jobId', middlewareKey(['all', 'write']), async (c) => {
  const jobId = c.req.param('jobId')
  const body = await getBodyOrQuery<{ app_id: string }>(c)
  if (!body.app_id) {
    throw new Error('app_id is required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return getBuildUploadUrl(c, jobId, body.app_id, apikey)
})

// Stored native build credentials (encrypted per app/platform). See credentials.ts.
// GET /build/credentials?app_id= - Non-secret summary per platform (app.build_native)
app.get('/credentials', middlewareKey(['all', 'write', 'read']), async (c) => {
  return getBuildCredentialsStatus(c)
})

// PUT /build/credentials - Validate, encrypt and save credentials (app.update_settings)
app.put('/credentials', middlewareKey(['all', 'write']), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return putBuildCredentials(c, apikey)
})

// DELETE /build/credentials - Delete one platform's stored credentials (app.update_settings)
app.delete('/credentials', middlewareKey(['all', 'write']), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return deleteBuildCredentials(c, apikey)
})

// POST /build/credentials/upload-url - 10 minute signed upload capability (app.update_settings)
app.post('/credentials/upload-url', middlewareKey(['all', 'write']), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return createBuildCredentialsUploadUrl(c, apikey)
})

// PUT /build/credentials/upload/:token - Raw credentials JSON. Auth: the signed token only;
// the minting API key's permission is re-checked at upload time.
app.put('/credentials/upload/:token', async (c) => {
  return uploadBuildCredentialsWithToken(c, c.req.param('token'))
})

// POST /build/ai_analyze - DEPRECATED (pre-streaming CLIs). Always 426 + upgrade message.
app.post('/ai_analyze', middlewareKey(['all', 'write']), async (c) => {
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return aiAnalyzeDeprecated(c, apikey)
})

// POST /build/ai_analyze_stream - Analyze a failed build's logs with AI (SSE streaming)
app.post('/ai_analyze_stream', middlewareKey(['all', 'write']), async (c) => {
  const body = await getBodyOrQuery<{ jobId: string, appId: string, logs: string }>(c)
  if (!body.jobId || !body.appId || typeof body.logs !== 'string') {
    throw new Error('jobId, appId, and logs are required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return aiAnalyzeStreamBuild(c, body.jobId, body.appId, apikey, body.logs)
})

// POST /build/support_logs - Upload gzipped support logs; returns a 30-day download link.
// Registered apps require app.build_native; unregistered onboarding apps require
// a current organization create-capability binding.
app.post('/support_logs', middlewareKey(['all', 'write']), async (c) => {
  const body = await getBodyOrQuery<SupportLogsBody>(c)
  if (!body || typeof body.gzB64 !== 'string' || body.gzB64.length === 0) {
    throw new Error('gzB64 is required in request body')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return uploadSupportLogs(c, apikey, body)
})

function tusOptionsResponse() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Expose-Headers': EXPOSED_HEADERS,
    'Tus-Resumable': TUS_VERSION,
    'Tus-Version': TUS_VERSION,
    'Tus-Max-Size': MAX_UPLOAD_LENGTH_BYTES.toString(),
    'Tus-Extension': TUS_EXTENSIONS,
  }
}

// TUS proxy endpoints - POST/HEAD/PATCH proxied to builder with API key injection
// POST /build/upload/:jobId - Create TUS upload (proxied to builder)
app.post('/upload/:jobId', middlewareKey(['all', 'write']), async (c) => {
  const jobId = c.req.param('jobId')
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return tusProxy(c, jobId, apikey)
})

async function proxyTusHead(c: Parameters<typeof tusProxy>[0]) {
  const jobId = c.req.param('jobId')
  if (!jobId) {
    throw new Error('jobId is required in request path')
  }
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return tusProxy(c, jobId, apikey, 'HEAD')
}

function isTusHeadProbe(c: Parameters<typeof tusProxy>[0]) {
  return c.req.method === 'HEAD' || !!c.req.header('Tus-Resumable')
}

// Hono serves HEAD through GET handlers on mounted routes.
// Accept real HEAD requests plus TUS-shaped GET probes and forward them upstream as HEAD.
app.get(
  '/upload/:jobId',
  async (c, next) => {
    if (!isTusHeadProbe(c)) {
      return c.notFound()
    }
    return next()
  },
  uploadWriteMiddleware,
  proxyTusHead,
)

app.get(
  '/upload/:jobId/*',
  async (c, next) => {
    if (!isTusHeadProbe(c)) {
      return c.notFound()
    }
    return next()
  },
  uploadWriteMiddleware,
  proxyTusHead,
)

// PATCH /build/upload/:jobId/* - Upload TUS chunk (proxied to builder)
app.patch('/upload/:jobId/*', middlewareKey(['all', 'write']), async (c) => {
  const jobId = c.req.param('jobId')
  const apikey = c.get('apikey') as Database['public']['Tables']['apikeys']['Row']
  return tusProxy(c, jobId, apikey)
})

// OPTIONS /build/upload/:jobId - TUS capabilities (no auth needed)
app.options('/upload/:jobId', (c) => {
  return c.newResponse(null, 204, tusOptionsResponse())
})

// OPTIONS /build/upload/:jobId/* - TUS capabilities (no auth needed)
app.options('/upload/:jobId/*', (c) => {
  return c.newResponse(null, 204, tusOptionsResponse())
})
