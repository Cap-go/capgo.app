import type { Context } from 'hono'
import { cloudlog } from '../utils/logging.ts'
import { getEnv } from '../utils/utils.ts'
import { parseUploadMetadata } from './parse.ts'
import { ALLOWED_HEADERS, ALLOWED_METHODS, EXPOSED_HEADERS, MAX_UPLOAD_LENGTH_BYTES, TUS_EXTENSIONS, TUS_VERSION } from './util.ts'

const BUCKET_NAME = 'capgo'
const SUPABASE_TIMEOUT = 1000 * 60 * 5 // 5 minutes for large uploads

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  return value?.split(',')[0]?.trim() || undefined
}

function normalizeHttpOrigin(value: string | undefined): string | undefined {
  if (!value)
    return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return undefined
    return url.origin
  }
  catch {
    return undefined
  }
}

function normalizeForwardedProto(value: string | undefined): 'http' | 'https' | undefined {
  const proto = firstForwardedHeaderValue(value)
  return proto === 'http' || proto === 'https' ? proto : undefined
}

function isLocalHost(host: string | undefined): boolean {
  return !!host && /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/i.test(host)
}

function isLocalSupabaseUrl(url: string): boolean {
  if (url.includes('kong:8000'))
    return true

  try {
    return isLocalHost(new URL(url).host)
  }
  catch {
    return false
  }
}

function buildLocalForwardedBaseUrl(c: Context): string | undefined {
  let forwardedHost = firstForwardedHeaderValue(c.req.header('X-Forwarded-Host'))
  const forwardedPort = firstForwardedHeaderValue(c.req.header('X-Forwarded-Port'))
  const hostHeader = firstForwardedHeaderValue(c.req.header('Host'))
  const forwardedProto = normalizeForwardedProto(c.req.header('X-Forwarded-Proto')) ?? 'http'

  if (forwardedHost && !forwardedHost.includes(':')) {
    const hostPort = hostHeader?.includes(':') ? hostHeader.split(':').pop() : undefined
    forwardedHost = `${forwardedHost}:${forwardedPort || hostPort || '54321'}`
  }

  if (forwardedHost)
    return normalizeHttpOrigin(`${forwardedProto}://${forwardedHost}`)

  if (hostHeader)
    return normalizeHttpOrigin(`${forwardedProto}://${hostHeader}`)

  return undefined
}

function resolveUploadLocationBaseUrl(c: Context, supabaseUrl: string): string {
  const normalizedSupabaseUrl = supabaseUrl.replace(/\/$/, '')
  const publicUrl = normalizeHttpOrigin(getEnv(c, 'PUBLIC_URL'))
  if (publicUrl)
    return publicUrl

  const requestOrigin = normalizeHttpOrigin(c.req.url)
  const isLocalDev = isLocalSupabaseUrl(normalizedSupabaseUrl)

  if (!isLocalDev)
    return requestOrigin || normalizeHttpOrigin(normalizedSupabaseUrl) || normalizedSupabaseUrl

  return buildLocalForwardedBaseUrl(c)
    || requestOrigin
    || normalizeHttpOrigin(normalizedSupabaseUrl)
    || normalizedSupabaseUrl
}

/**
 * UTF-8 safe base64 encoding
 * Uses TextEncoder to handle Unicode characters properly
 */
function utf8ToBase64(str: string): string {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(str)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/**
 * Build the Supabase Storage TUS endpoint URL
 * Note: From inside the Docker container, Supabase is at kong:8000, not localhost:54321
 */
function buildSupabaseTusUrl(c: Context, uploadId?: string): string {
  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  if (uploadId) {
    return `${supabaseUrl}/storage/v1/upload/resumable/${uploadId}`
  }
  return `${supabaseUrl}/storage/v1/upload/resumable`
}

/**
 * Transform metadata to include Supabase-required bucketName and objectName
 * Preserves client-provided metadata like filetype for MIME type support
 */
function transformMetadataForSupabase(c: Context, objectName: string): string {
  const bucketNameB64 = utf8ToBase64(BUCKET_NAME)
  const objectNameB64 = utf8ToBase64(objectName)
  const filenameB64 = utf8ToBase64(objectName)

  let metadata = `bucketName ${bucketNameB64},objectName ${objectNameB64},filename ${filenameB64}`

  // Preserve filetype from original metadata if present
  const originalMetadata = parseUploadMetadata(c, c.req.raw.headers)
  if (originalMetadata.filetype) {
    const filetypeB64 = utf8ToBase64(originalMetadata.filetype)
    metadata += `,filetype ${filetypeB64}`
  }

  return metadata
}

/**
 * Rewrite Supabase Location header to Capgo API URL
 */
function rewriteLocationHeader(c: Context, supabaseLocation: string): string {
  const requestId = c.get('requestId')

  // Extract uploadId from Supabase URL in a robust way
  let uploadId: string | undefined
  try {
    const url = new URL(supabaseLocation)
    const pathSegments = url.pathname.split('/').filter(Boolean)
    uploadId = pathSegments[pathSegments.length - 1]
  }
  catch {
    const pathWithoutQuery = supabaseLocation.split('?')[0].split('#')[0]
    const pathSegments = pathWithoutQuery.split('/').filter(Boolean)
    uploadId = pathSegments[pathSegments.length - 1]
  }

  if (!uploadId) {
    cloudlog({ requestId, message: 'rewriteLocationHeader - failed to extract uploadId', supabaseLocation })
    throw new Error('Failed to extract uploadId from Supabase Location header')
  }

  const supabaseUrl = getEnv(c, 'SUPABASE_URL')
  const baseUrl = resolveUploadLocationBaseUrl(c, supabaseUrl)

  cloudlog({ requestId, message: 'rewriteLocationHeader result', baseUrl })
  return `${baseUrl}/functions/v1/files/upload/attachments/${uploadId}`
}

/**
 * Build common TUS response headers
 */
function buildTusResponseHeaders(): Headers {
  const headers = new Headers()
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS)
  headers.set('Access-Control-Allow-Headers', ALLOWED_HEADERS)
  headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS)
  headers.set('Tus-Resumable', TUS_VERSION)
  headers.set('Tus-Version', TUS_VERSION)
  headers.set('Tus-Max-Size', MAX_UPLOAD_LENGTH_BYTES.toString())
  headers.set('Tus-Extension', TUS_EXTENSIONS)
  return headers
}

/**
 * Build authorization headers for Supabase requests
 */
function buildSupabaseAuthHeaders(c: Context): Headers {
  const serviceRoleKey = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${serviceRoleKey}`)
  headers.set('Tus-Resumable', TUS_VERSION)
  return headers
}

/**
 * Forward specific headers from client request to Supabase
 */
function forwardHeaders(c: Context, headers: Headers, headerNames: string[]): void {
  for (const header of headerNames) {
    const value = c.req.header(header)
    if (value)
      headers.set(header, value)
  }
}

/**
 * Copy specific headers from Supabase response to client response
 */
function copyResponseHeaders(from: Headers, to: Headers, headerNames: string[]): void {
  for (const header of headerNames) {
    const value = from.get(header)
    if (value)
      to.set(header, value)
  }
}

/**
 * Make a proxied request to Supabase with timeout and error handling
 */
async function proxyToSupabase(
  requestId: string,
  handlerName: string,
  url: string,
  options: RequestInit,
): Promise<Response | { error: true, response: Response }> {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(SUPABASE_TIMEOUT),
    })
  }
  catch (error) {
    cloudlog({ requestId, message: `${handlerName} fetch error`, error: error instanceof Error ? error.message : String(error) })
    return {
      error: true,
      response: new Response(JSON.stringify({ error: 'upstream_error', message: 'Failed to communicate with storage backend' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    }
  }
}

/**
 * Read error body from Supabase response for forwarding
 */
async function readErrorBody(response: Response): Promise<string | null> {
  if (response.ok)
    return null
  try {
    const text = await response.text()
    return text || null
  }
  catch {
    return null
  }
}

/**
 * Handle TUS POST request - create a new upload
 */
export async function supabaseTusCreateHandler(c: Context): Promise<Response> {
  const requestId = c.get('requestId')
  const rawFileId = c.get('fileId')

  if (typeof rawFileId !== 'string' || rawFileId.length === 0) {
    cloudlog({ requestId, message: 'supabaseTusCreateHandler missing or invalid fileId', fileId: rawFileId })
    return new Response(JSON.stringify({ error: 'internal_error', message: 'Internal server error: missing fileId' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  cloudlog({ requestId, message: 'supabaseTusCreateHandler', fileId: rawFileId })

  const supabaseUrl = buildSupabaseTusUrl(c)
  const headers = buildSupabaseAuthHeaders(c)
  forwardHeaders(c, headers, ['Upload-Length', 'Upload-Defer-Length', 'Content-Type', 'Content-Length', 'X-Upsert'])

  const transformedMetadata = transformMetadataForSupabase(c, rawFileId)
  headers.set('Upload-Metadata', transformedMetadata)

  cloudlog({ requestId, message: 'supabaseTusCreateHandler forwarding', supabaseUrl, transformedMetadata })

  const result = await proxyToSupabase(requestId, 'supabaseTusCreateHandler', supabaseUrl, {
    method: 'POST',
    headers,
    body: c.req.raw.body,
  })

  if ('error' in result)
    return result.response

  const response = result
  cloudlog({ requestId, message: 'supabaseTusCreateHandler response', status: response.status })

  const responseHeaders = buildTusResponseHeaders()
  copyResponseHeaders(response.headers, responseHeaders, ['Upload-Offset', 'Upload-Expires'])

  const location = response.headers.get('Location')
  if (location) {
    const rewrittenLocation = rewriteLocationHeader(c, location)
    responseHeaders.set('Location', rewrittenLocation)
    cloudlog({ requestId, message: 'supabaseTusCreateHandler location rewritten', original: location, rewritten: rewrittenLocation })
  }

  let responseBody: BodyInit | null = null
  if (response.status >= 400) {
    responseBody = await readErrorBody(response)
    if (responseBody) {
      const contentType = response.headers.get('Content-Type')
      if (contentType)
        responseHeaders.set('Content-Type', contentType)
    }
  }

  return new Response(responseBody, { status: response.status, headers: responseHeaders })
}

/**
 * Handle TUS PATCH request - upload chunk
 */
export async function supabaseTusPatchHandler(c: Context): Promise<Response> {
  const requestId = c.get('requestId')
  const uploadId = c.req.param('id')

  cloudlog({ requestId, message: 'supabaseTusPatchHandler', uploadId })

  const supabaseUrl = buildSupabaseTusUrl(c, uploadId)
  const headers = buildSupabaseAuthHeaders(c)
  forwardHeaders(c, headers, ['Upload-Offset', 'Content-Type', 'Content-Length', 'Upload-Length'])

  cloudlog({ requestId, message: 'supabaseTusPatchHandler forwarding', supabaseUrl })

  const result = await proxyToSupabase(requestId, 'supabaseTusPatchHandler', supabaseUrl, {
    method: 'PATCH',
    headers,
    body: c.req.raw.body,
  })

  if ('error' in result)
    return result.response

  const response = result
  cloudlog({ requestId, message: 'supabaseTusPatchHandler response', status: response.status })

  const responseHeaders = buildTusResponseHeaders()
  copyResponseHeaders(response.headers, responseHeaders, ['Upload-Offset', 'Upload-Expires'])

  const body = await readErrorBody(response)
  return new Response(body, { status: response.status, headers: responseHeaders })
}

/**
 * Handle TUS HEAD request - check upload progress
 */
export async function supabaseTusHeadHandler(c: Context): Promise<Response> {
  const requestId = c.get('requestId')
  const uploadId = c.req.param('id')

  cloudlog({ requestId, message: 'supabaseTusHeadHandler', uploadId })

  const supabaseUrl = buildSupabaseTusUrl(c, uploadId)
  const headers = buildSupabaseAuthHeaders(c)

  cloudlog({ requestId, message: 'supabaseTusHeadHandler forwarding', supabaseUrl })

  const result = await proxyToSupabase(requestId, 'supabaseTusHeadHandler', supabaseUrl, {
    method: 'HEAD',
    headers,
  })

  if ('error' in result)
    return result.response

  const response = result
  cloudlog({ requestId, message: 'supabaseTusHeadHandler response', status: response.status })

  const responseHeaders = buildTusResponseHeaders()
  responseHeaders.set('Cache-Control', 'no-store')
  copyResponseHeaders(response.headers, responseHeaders, ['Upload-Offset', 'Upload-Length', 'Upload-Expires'])

  const body = await readErrorBody(response)
  return new Response(body, { status: response.status, headers: responseHeaders })
}
