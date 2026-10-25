import type { Context } from 'hono'
import type { StoredObjectInfo } from './s3.ts'
import { getRuntimeKey } from 'hono/adapter'
import { s3 } from './s3.ts'
import { getEnv } from './utils.ts'

// Server-side object access for bundle upload sessions. R2 (and any real S3) goes through
// the S3 API. When the S3 endpoint is Supabase Storage's S3 gateway (local stacks), the
// Supabase runtime uses the Storage REST API instead, like files.ts: the S3 endpoint
// advertised to clients is not reachable from inside the functions container.

function useSupabaseStorage(c: Context) {
  return getRuntimeKey() !== 'workerd' && getEnv(c, 'S3_ENDPOINT').includes('/storage/v1/s3')
}

function storageObjectUrl(c: Context, path: string, authenticated: boolean) {
  const base = getEnv(c, 'SUPABASE_URL').replace(/\/+$/, '')
  const bucket = getEnv(c, 'S3_BUCKET') || 'capgo'
  const encodedPath = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/${authenticated ? 'authenticated/' : ''}${bucket}/${encodedPath}`
}

function serviceHeaders(c: Context, extra: Record<string, string> = {}) {
  const key = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  return { Authorization: `Bearer ${key}`, apikey: key, ...extra }
}

function isMissing(status: number) {
  // Supabase Storage answers 400 with an "object not found" body for missing objects.
  return status === 404 || status === 400
}

async function statObject(c: Context, path: string): Promise<StoredObjectInfo | null> {
  if (!useSupabaseStorage(c))
    return s3.statObject(c, path)
  const response = await fetch(storageObjectUrl(c, path, true), { method: 'HEAD', headers: serviceHeaders(c) })
  await response.body?.cancel()
  if (isMissing(response.status))
    return null
  if (!response.ok)
    throw new Error(`Storage HEAD returned ${response.status}`)
  const lastModified = Date.parse(response.headers.get('last-modified') ?? '')
  return {
    size: Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0,
    etag: response.headers.get('etag')?.replaceAll('"', '') || null,
    lastModified: Number.isFinite(lastModified) ? lastModified : null,
  }
}

async function getObjectRange(c: Context, path: string, offset: number, length: number): Promise<Uint8Array> {
  if (!useSupabaseStorage(c))
    return s3.getObjectRange(c, path, offset, length)
  const response = await fetch(storageObjectUrl(c, path, true), { headers: serviceHeaders(c, { Range: `bytes=${offset}-${offset + length - 1}` }) })
  if (response.status !== 206 && response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`Storage range GET returned ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  return response.status === 200 ? bytes.subarray(offset, offset + length) : bytes
}

async function readObjectStream(c: Context, path: string): Promise<Response | null> {
  if (!useSupabaseStorage(c))
    return s3.readObjectStream(c, path)
  const response = await fetch(storageObjectUrl(c, path, true), { headers: serviceHeaders(c) })
  if (isMissing(response.status)) {
    await response.body?.cancel()
    return null
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Storage GET returned ${response.status}`)
  }
  return response
}

async function putObject(c: Context, path: string, data: Uint8Array, contentType = 'application/octet-stream'): Promise<{ etag: string | null }> {
  if (!useSupabaseStorage(c))
    return s3.putObject(c, path, data, contentType)
  const response = await fetch(storageObjectUrl(c, path, false), {
    method: 'POST',
    body: data as Uint8Array<ArrayBuffer>,
    headers: serviceHeaders(c, { 'Content-Type': contentType, 'x-upsert': 'true' }),
  })
  await response.body?.cancel()
  if (!response.ok)
    throw new Error(`Storage upload returned ${response.status}`)
  return { etag: response.headers.get('etag')?.replaceAll('"', '') || null }
}

async function removeObject(c: Context, path: string): Promise<void> {
  if (!useSupabaseStorage(c))
    return s3.removeObject(c, path)
  const response = await fetch(storageObjectUrl(c, path, false), { method: 'DELETE', headers: serviceHeaders(c) })
  await response.body?.cancel()
  if (!response.ok && !isMissing(response.status))
    throw new Error(`Storage DELETE returned ${response.status}`)
}

export const bundleStorage = {
  statObject,
  getObjectRange,
  readObjectStream,
  putObject,
  removeObject,
}
