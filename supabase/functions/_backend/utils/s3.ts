import type { Context } from 'hono'
import type { Database } from '../utils/supabase.types.ts'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { getManifestStorageCandidateKeys } from './manifest_encoding.ts'
import { getEnv } from './utils.ts'

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  if (!value)
    return undefined
  return value.split(',')[0]?.trim() || undefined
}

function resolveEndpointProtocol(c: Context): 'http' | 'https' {
  const forwardedProto = firstForwardedHeaderValue(c.req.header('X-Forwarded-Proto'))
  if (forwardedProto === 'http' || forwardedProto === 'https')
    return forwardedProto
  try {
    const requestProtocol = new URL(c.req.url).protocol.replace(':', '')
    if (requestProtocol === 'http' || requestProtocol === 'https')
      return requestProtocol
  }
  catch {
    // Ignore URL parsing failures and use the storage config fallback below.
  }
  return getEnv(c, 'S3_SSL') === 'true' ? 'https' : 'http'
}

/**
 * `serverSide` is for requests this runtime sends itself rather than presigned
 * URLs handed to clients. It only changes the local Supabase Storage endpoint.
 */
export function resolveStorageEndpoint(c: Context, options: { serverSide?: boolean } = {}): string {
  const storageEndpoint = getEnv(c, 'S3_ENDPOINT')
  const protocol = resolveEndpointProtocol(c)
  const rawEndpoint = storageEndpoint.includes('://')
    ? storageEndpoint
    : `${protocol}://${storageEndpoint}`

  try {
    const endpointUrl = new URL(rawEndpoint)
    const looksLikeLocalStorage = endpointUrl.pathname.startsWith('/storage/v1/s3')
      && ['localhost', '127.0.0.1', 'kong'].includes(endpointUrl.hostname)
    const rewriteLocalEndpoint = getEnv(c, 'S3_REWRITE_LOCAL_ENDPOINT') !== 'false'

    if (!looksLikeLocalStorage || !rewriteLocalEndpoint)
      return endpointUrl.toString()

    const forwardedPort = firstForwardedHeaderValue(c.req.header('X-Forwarded-Port'))
    if (options.serverSide) {
      // Local Kong tells Storage its published port, and Storage checks the
      // signature against that host. The caller's host is not reachable from the
      // edge runtime container, so go back through the Docker host on that port.
      endpointUrl.protocol = `${protocol}:`
      endpointUrl.hostname = 'host.docker.internal'
      if (forwardedPort)
        endpointUrl.port = forwardedPort
      return endpointUrl.toString()
    }

    let forwardedHost = firstForwardedHeaderValue(c.req.header('X-Forwarded-Host'))
    const hostHeader = c.req.header('Host')

    if (forwardedHost && !forwardedHost.includes(':') && forwardedPort) {
      forwardedHost = `${forwardedHost}:${forwardedPort}`
    }

    endpointUrl.protocol = `${protocol}:`
    endpointUrl.host = forwardedHost || hostHeader || endpointUrl.host
    return endpointUrl.toString()
  }
  catch {
    return rawEndpoint
  }
}

export function initS3(c: Context, options: { serverSide?: boolean } = {}) {
  const access_key_id = getEnv(c, 'S3_ACCESS_KEY_ID')
  const access_key_secret = getEnv(c, 'S3_SECRET_ACCESS_KEY')
  const storageRegion = getEnv(c, 'S3_REGION') || 'us-east-1'
  const bucket = getEnv(c, 'S3_BUCKET')
  const client = new S3Client({
    endPoint: resolveStorageEndpoint(c, options),
    accessKey: access_key_id,
    pathStyle: true,
    secretKey: access_key_secret,
    region: storageRegion,
    bucket,
  })
  return client
}

const R2_TRASH_PREFIX = 'deleted-after-7-days/'

function getTrashPath(fileId: string) {
  return `${R2_TRASH_PREFIX}${fileId}`
}

export async function getPath(
  c: Context,
  record: Database['public']['Tables']['app_versions']['Row'],
) {
  if (!record.r2_path) {
    cloudlog({ requestId: c.get('requestId'), message: 'no r2_path' })
    return null
  }
  if (!record.r2_path && (!record.app_id || !record.user_id || !record.id)) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'no app_id or user_id or id',
    })
    return null
  }
  const exist = await checkIfExist(c, record.r2_path)
  if (!exist) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'not exist',
      vPath: record.r2_path,
    })
    return null
  }
  return record.r2_path
}

async function getUploadUrl(c: Context, fileId: string, expirySeconds = 1200) {
  const client = initS3(c)
  const url = await client.getPresignedUrl('PUT', fileId, {
    expirySeconds,
    parameters: {
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
      'x-id': 'PutObject',
    },
  })
  return url
}

async function deleteObject(c: Context, fileId: string) {
  const client = initS3(c)
  const url = await client.getPresignedUrl('DELETE', fileId)
  const response = await fetch(url, {
    method: 'DELETE',
  })
  return response.status >= 200 && response.status < 300
}

function isMissingObjectError(error: unknown): boolean {
  if (!error || typeof error !== 'object')
    return false

  const candidate = error as { code?: unknown, status?: unknown, statusCode?: unknown }
  return candidate.status === 404 || candidate.statusCode === 404 || candidate.code === 'NoSuchKey'
}

function shouldUseSizeRangeFallback(size: number, headError: unknown): boolean {
  return !size && !isMissingObjectError(headError)
}

type ObjectPresence = 'present' | 'absent' | 'unknown'

async function getObjectPresence(c: Context, fileId: string | null): Promise<ObjectPresence> {
  if (!fileId)
    return 'absent'

  try {
    const client = initS3(c)
    const url = await client.getPresignedUrl('HEAD', fileId)
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()

    if (response.status === 404)
      return 'absent'
    if (response.status === 200)
      return 'present'

    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getObjectPresence unexpected HEAD status',
      fileId,
      status: response.status,
      statusText: response.statusText,
    })
    return 'unknown'
  }
  catch (error) {
    if (isMissingObjectError(error))
      return 'absent'
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getObjectPresence failed',
      fileId,
      error: serializeStorageError(error),
    })
    return 'unknown'
  }
}

async function moveObjectToTrash(c: Context, fileId: string) {
  if (fileId.startsWith(R2_TRASH_PREFIX))
    return true

  // Only skip copy on a definitive absent object. Unknown HEAD must fail closed
  // so callers keep DB tracking until trash succeeds.
  const presence = await getObjectPresence(c, fileId)
  if (presence === 'absent') {
    cloudlog({ requestId: c.get('requestId'), message: 'R2 object missing before trash move, skip copy', fileId })
    return true
  }
  if (presence === 'unknown') {
    cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object presence unknown, refuse trash skip', fileId })
    return false
  }

  const client = initS3(c)
  const trashPath = getTrashPath(fileId)
  try {
    await client.copyObject({ sourceKey: fileId }, trashPath)
    await client.deleteObject(fileId)
    cloudlog({ requestId: c.get('requestId'), message: 'moved R2 object to trash', fileId, trashPath })
    return true
  }
  catch (error) {
    if (isMissingObjectError(error)) {
      cloudlog({ requestId: c.get('requestId'), message: 'R2 object disappeared during trash move', fileId, error: serializeStorageError(error) })
      return true
    }

    cloudlogErr({ requestId: c.get('requestId'), message: 'move R2 object to trash failed', fileId, trashPath, error: serializeStorageError(error) })
    return false
  }
}

async function deleteObjectsWithPrefix(c: Context, prefix: string): Promise<number> {
  const client = initS3(c)
  let deletedCount = 0

  for await (const object of client.listObjects({ prefix })) {
    try {
      await client.deleteObject(object.key)
      deletedCount += 1
    }
    catch (error) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'deleteObjectsWithPrefix item failed',
        prefix,
        key: object.key,
        error,
      })
    }
  }

  return deletedCount
}

async function checkIfExist(c: Context, fileId: string | null) {
  if (!fileId) {
    cloudlog({ requestId: c.get('requestId'), message: 'checkIfExist skipped empty fileId' })
    return false
  }

  const bucket = getEnv(c, 'S3_BUCKET')
  const endpoint = getEnv(c, 'S3_ENDPOINT')

  try {
    const client = initS3(c)
    const url = await client.getPresignedUrl('HEAD', fileId)
    const response = await fetch(url, {
      method: 'HEAD',
    })
    const contentLengthHeader = response.headers.get('content-length')
    const contentLength = Number.parseInt(contentLengthHeader || '0')
    const exists = response.status === 200 && contentLength > 0
    await response.body?.cancel()

    if (!exists) {
      cloudlog({
        requestId: c.get('requestId'),
        message: 'checkIfExist returned false',
        bucket,
        contentLength,
        contentLengthHeader,
        endpoint,
        fileId,
        status: response.status,
        statusText: response.statusText,
      })
    }

    return exists
  }
  catch (error) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'checkIfExist failed',
      bucket,
      endpoint,
      error: serializeStorageError(error),
      fileId,
    })
    return false
  }
}

async function getSignedUrl(c: Context, fileId: string, expirySeconds: number) {
  const client = initS3(c)
  const url = await client.getPresignedUrl('GET', fileId, {
    expirySeconds,
    parameters: {
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
      'x-id': 'PutObject',
    },
  })
  return url
}

function parseObjectSizeFromHeaders(contentRange: string | null, contentLength: string | null): number {
  if (contentRange?.includes('/')) {
    const total = Number.parseInt(contentRange.split('/').at(1) ?? '0', 10)
    if (Number.isFinite(total) && total > 0)
      return total
  }

  if (contentLength) {
    const len = Number.parseInt(contentLength, 10)
    if (Number.isFinite(len) && len > 0)
      return len
  }

  return 0
}

function serializeStorageError(error: unknown) {
  const serialized = serializeError(error)
  const status = error && typeof error === 'object'
    ? ((error as { status?: unknown, statusCode?: unknown, code?: unknown }).status
      ?? (error as { statusCode?: unknown }).statusCode
      ?? (error as { code?: unknown }).code)
    : undefined

  return {
    ...serialized,
    status,
  }
}

interface SizeRangeDiagnostic {
  contentLength?: string | null
  contentRange?: string | null
  error?: ReturnType<typeof serializeStorageError>
  reason: 'head_error' | 'missing_head_size'
  size: number
  status?: number
  statusText?: string
}

interface SizeKeyDiagnostic {
  fileId: string
  finalSize: number
  head: {
    error?: ReturnType<typeof serializeStorageError>
    rawSize?: unknown
    size: number
    success: boolean
  }
  range?: SizeRangeDiagnostic
  usedFallback: boolean
}

export interface StorageSizeDiagnostics {
  bucket: string
  candidateKeys: string[]
  candidates: SizeKeyDiagnostic[]
  endpoint: string
  fileId: string
  selectedCandidateKey: string | null
  size: number
}

async function getSizeFromRangeFallback(
  c: Context,
  client: ReturnType<typeof initS3>,
  fileId: string,
  reason: 'head_error' | 'missing_head_size',
): Promise<SizeRangeDiagnostic> {
  try {
    const url = await client.getPresignedUrl('GET', fileId, {
      parameters: { 'x-id': 'GetObject' },
    })
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Range': 'bytes=0-0', // minimal range; forces Content-Range with total length
        'Accept-Encoding': 'identity',
      },
    })

    const contentRange = res.headers.get('content-range') || res.headers.get('Content-Range')
    const contentLength = res.headers.get('content-length') || res.headers.get('Content-Length')
    if (!res.ok) {
      await res.body?.cancel()
      const diagnostic = { contentLength, contentRange, reason, size: 0, status: res.status, statusText: res.statusText }
      cloudlog({
        requestId: c.get('requestId'),
        message: 'getSize range fallback returned non-success response',
        fileId,
        ...diagnostic,
      })
      return diagnostic
    }

    const size = res.status === 206 && contentRange
      ? parseObjectSizeFromHeaders(contentRange, null)
      : res.status === 200
        ? parseObjectSizeFromHeaders(null, contentLength)
        : 0
    await res.body?.cancel()

    const diagnostic = { contentLength, contentRange, reason, size, status: res.status, statusText: res.statusText }
    cloudlog({
      requestId: c.get('requestId'),
      message: 'getSize range fallback result',
      fileId,
      ...diagnostic,
    })
    return diagnostic
  }
  catch (fallbackError) {
    const diagnostic = { error: serializeStorageError(fallbackError), reason, size: 0 }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getSize range fallback failed',
      fileId,
      ...diagnostic,
      bucket: getEnv(c, 'S3_BUCKET'),
      endpoint: getEnv(c, 'S3_ENDPOINT'),
    })
    return diagnostic
  }
}

async function getSizeForKey(c: Context, client: ReturnType<typeof initS3>, fileId: string): Promise<SizeKeyDiagnostic> {
  let size = 0
  let headError: unknown
  const diagnostic: SizeKeyDiagnostic = {
    fileId,
    finalSize: 0,
    head: { size: 0, success: false },
    usedFallback: false,
  }

  try {
    // Ask Cloudflare/R2 for the raw object (no brotli/gzip) so Content-Length is preserved.
    const file = await client.statObject(fileId, {
      headers: { 'Accept-Encoding': 'identity' },
    })
    size = Number.isFinite(file.size) ? file.size : 0
    diagnostic.head = { rawSize: file.size, size, success: true }
    cloudlog({
      requestId: c.get('requestId'),
      message: 'getSize head result',
      fileId,
      headSize: size,
      headRawSize: file.size,
      bucket: getEnv(c, 'S3_BUCKET'),
      endpoint: getEnv(c, 'S3_ENDPOINT'),
    })
  }
  catch (error) {
    headError = error
    diagnostic.head = { error: serializeStorageError(error), size: 0, success: false }
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'getSize head failed',
      fileId,
      error: diagnostic.head.error,
      bucket: getEnv(c, 'S3_BUCKET'),
      endpoint: getEnv(c, 'S3_ENDPOINT'),
    })
  }

  if (shouldUseSizeRangeFallback(size, headError)) {
    diagnostic.usedFallback = true
    diagnostic.range = await getSizeFromRangeFallback(c, client, fileId, headError ? 'head_error' : 'missing_head_size')
    size = diagnostic.range.size
  }

  diagnostic.finalSize = size
  cloudlog({
    requestId: c.get('requestId'),
    message: 'getSize final',
    fileId,
    bucket: getEnv(c, 'S3_BUCKET'),
    endpoint: getEnv(c, 'S3_ENDPOINT'),
    finalSize: size,
    usedFallback: diagnostic.usedFallback,
    head: diagnostic.head,
    range: diagnostic.range,
  })
  return diagnostic
}

async function getSizeDiagnostics(c: Context, fileId: string): Promise<StorageSizeDiagnostics> {
  const client = initS3(c)
  const candidateKeys = getManifestStorageCandidateKeys(fileId)
  const diagnostics: StorageSizeDiagnostics = {
    bucket: getEnv(c, 'S3_BUCKET'),
    candidateKeys,
    candidates: [],
    endpoint: getEnv(c, 'S3_ENDPOINT'),
    fileId,
    selectedCandidateKey: null,
    size: 0,
  }

  for (const candidateKey of candidateKeys) {
    const candidate = await getSizeForKey(c, client, candidateKey)
    diagnostics.candidates.push(candidate)
    if (candidate.finalSize > 0) {
      diagnostics.selectedCandidateKey = candidateKey
      diagnostics.size = candidate.finalSize
      if (candidateKey !== fileId) {
        cloudlog({
          requestId: c.get('requestId'),
          message: 'getSize recovered from manifest storage candidate',
          fileId,
          candidateKey,
          candidateKeys,
          size: candidate.finalSize,
        })
      }
      return diagnostics
    }
  }

  cloudlogErr({
    requestId: c.get('requestId'),
    message: 'getSize exhausted storage candidates',
    ...diagnostics,
  })

  return diagnostics
}

async function getSize(c: Context, fileId: string) {
  const diagnostics = await getSizeDiagnostics(c, fileId)
  return diagnostics.size
}

async function getObject(c: Context, fileId: string): Promise<Response | null> {
  const client = initS3(c)
  try {
    const url = await client.getPresignedUrl('GET', fileId, {
      expirySeconds: 60,
    })
    const response = await fetch(url)
    if (!response.ok) {
      cloudlog({ requestId: c.get('requestId'), message: 'getObject failed', fileId, status: response.status })
      return null
    }
    return response
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'getObject error', fileId, error })
    return null
  }
}

export interface ListedObject { key: string, lastModified: Date }

/** One listing page (at most 1,000 keys) plus the token for the next page. */
async function listObjectPage(c: Context, prefix: string, continuationToken: string | null, pageSize = 1_000) {
  const client = initS3(c)
  const iterator = client.listObjectsGrouped({ prefix, pageSize, maxResults: pageSize, continuationToken: continuationToken ?? undefined })
  const objects: ListedObject[] = []
  let result = await iterator.next()
  while (!result.done) {
    if (result.value.type === 'Object')
      objects.push({ key: result.value.key, lastModified: result.value.lastModified })
    result = await iterator.next()
  }
  return { objects, nextToken: result.value ?? null }
}

/** Server-side copy into the lifecycle trash; the source stays in place. */
async function copyObjectToTrash(c: Context, fileId: string) {
  if (fileId.startsWith(R2_TRASH_PREFIX))
    return true
  try {
    await initS3(c).copyObject({ sourceKey: fileId }, getTrashPath(fileId))
    return true
  }
  catch (error) {
    if (isMissingObjectError(error))
      return false
    cloudlogErr({ requestId: c.get('requestId'), message: 'copy R2 object to trash failed', fileId, error: serializeStorageError(error) })
    return false
  }
}

/** Bounded delete: the request is aborted after `timeoutMs`. */
/**
 * Restores `fileId` from its lifecycle-trash copy when it is definitely
 * missing. 'unknown' means presence could not be established; retry later.
 */
async function restoreFromTrashIfMissing(c: Context, fileId: string): Promise<'present' | 'restored' | 'unknown' | 'failed'> {
  const presence = await getObjectPresence(c, fileId)
  if (presence === 'present')
    return 'present'
  if (presence === 'unknown')
    return 'unknown'
  try {
    await initS3(c).copyObject({ sourceKey: getTrashPath(fileId) }, fileId)
    cloudlog({ requestId: c.get('requestId'), message: 'restored R2 object from trash after unsettled delete', fileId })
    return 'restored'
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'restore R2 object from trash failed', fileId, error: serializeStorageError(error) })
    return 'failed'
  }
}

async function deleteObjectKey(c: Context, fileId: string, timeoutMs = 10_000) {
  try {
    const url = await initS3(c).getPresignedUrl('DELETE', fileId)
    const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(timeoutMs) })
    await response.body?.cancel()
    if ((response.status >= 200 && response.status < 300) || response.status === 404)
      return true
    cloudlogErr({ requestId: c.get('requestId'), message: 'delete R2 object failed', fileId, status: response.status })
    return false
  }
  catch (error) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'delete R2 object failed', fileId, error: serializeStorageError(error) })
    return false
  }
}

export interface StoredObjectInfo {
  size: number
  etag: string | null
  lastModified: number | null
}

/** HEAD an object: null when absent, throws when the storage answer is not definitive. */
async function statObject(c: Context, fileId: string): Promise<StoredObjectInfo | null> {
  const client = initS3(c)
  const url = await client.getPresignedUrl('HEAD', fileId)
  const response = await fetch(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(15_000) })
  await response.body?.cancel()
  if (response.status === 404)
    return null
  if (response.status !== 200)
    throw new Error(`Storage HEAD returned ${response.status}`)
  const lastModified = Date.parse(response.headers.get('last-modified') ?? '')
  return {
    size: Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0,
    etag: response.headers.get('etag')?.replaceAll('"', '') || null,
    lastModified: Number.isFinite(lastModified) ? lastModified : null,
  }
}

async function putObject(c: Context, fileId: string, data: Uint8Array, contentType = 'application/octet-stream'): Promise<{ etag: string | null }> {
  const url = await initS3(c).getPresignedUrl('PUT', fileId, {
    expirySeconds: 300,
    parameters: { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'x-id': 'PutObject' },
  })
  const response = await fetch(url, {
    method: 'PUT',
    body: data as Uint8Array<ArrayBuffer>,
    headers: { 'Content-Type': contentType },
    signal: AbortSignal.timeout(60_000),
  })
  await response.body?.cancel()
  if (!response.ok)
    throw new Error(`Storage PUT returned ${response.status}`)
  return { etag: response.headers.get('etag')?.replaceAll('"', '') || null }
}

/** The object no longer has the ETag the caller pinned (it was overwritten). */
export class StorageObjectChangedError extends Error {
  constructor(readonly path: string) {
    super(`Storage object ${path} changed`)
  }
}

function normalizeEtag(value: string | null | undefined): string | null {
  return value?.replace(/^W\//, '').replaceAll('"', '') || null
}

/** Pin a read to one object version: send If-Match and verify the ETag that was served. */
function conditionalReadHeaders(ifMatch: string | null | undefined, headers: Record<string, string>) {
  return ifMatch ? { ...headers, 'If-Match': `"${ifMatch}"` } : headers
}

export function assertServedEtag(path: string, response: Response, ifMatch: string | null | undefined) {
  if (!ifMatch)
    return
  const served = normalizeEtag(response.headers.get('etag'))
  if (response.status === 412 || (served && served !== ifMatch))
    throw new StorageObjectChangedError(path)
}

async function getObjectRange(c: Context, fileId: string, offset: number, length: number, ifMatch?: string | null): Promise<Uint8Array> {
  const client = initS3(c)
  const url = await client.getPresignedUrl('GET', fileId, { expirySeconds: 60 })
  const response = await fetch(url, {
    headers: conditionalReadHeaders(ifMatch, { 'Range': `bytes=${offset}-${offset + length - 1}`, 'Accept-Encoding': 'identity' }),
    signal: AbortSignal.timeout(30_000),
  })
  if (response.status !== 206 && response.status !== 200) {
    await response.body?.cancel()
    assertServedEtag(fileId, response, ifMatch)
    throw new Error(`Storage range GET returned ${response.status}`)
  }
  try {
    assertServedEtag(fileId, response, ifMatch)
  }
  catch (error) {
    await response.body?.cancel()
    throw error
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  // A server ignoring Range returns the whole object; slice the requested window.
  return response.status === 200 ? bytes.subarray(offset, offset + length) : bytes
}

/** Full object stream for server-side processing; null when absent. */
async function readObjectStream(c: Context, fileId: string, ifMatch?: string | null): Promise<Response | null> {
  const url = await initS3(c).getPresignedUrl('GET', fileId, { expirySeconds: 300 })
  const response = await fetch(url, { headers: conditionalReadHeaders(ifMatch, { 'Accept-Encoding': 'identity' }) })
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  try {
    assertServedEtag(fileId, response, ifMatch)
  }
  catch (error) {
    await response.body?.cancel()
    throw error
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Storage GET returned ${response.status}`)
  }
  return response
}

/**
 * Server-side copy inside the bucket. With `ifMatch`, the copy only happens while the
 * source still has that ETag (x-amz-copy-source-if-match), so the destination is exactly
 * the object version the caller verified.
 */
async function copyObject(c: Context, sourceKey: string, destinationKey: string, ifMatch?: string | null): Promise<void> {
  const client = initS3(c)
  const bucket = getEnv(c, 'S3_BUCKET')
  const headers = new Headers()
  headers.set('x-amz-copy-source', `${bucket}/${sourceKey.split('/').map(part => encodeURIComponent(part)).join('/')}`)
  if (ifMatch)
    headers.set('x-amz-copy-source-if-match', `"${ifMatch}"`)
  let text: string
  try {
    const response = await client.makeRequest({ method: 'PUT', objectName: destinationKey, headers, returnBody: true })
    text = await response.text()
  }
  catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 412)
      throw new StorageObjectChangedError(sourceKey)
    throw error
  }
  // S3 can answer 200 with an error document when the copy fails mid-way.
  if (!text.includes('CopyObjectResult'))
    throw new Error(`Storage copy failed: ${text.slice(0, 200)}`)
}

async function removeObject(c: Context, fileId: string): Promise<void> {
  const url = await initS3(c).getPresignedUrl('DELETE', fileId)
  const response = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(15_000) })
  await response.body?.cancel()
  if (response.status >= 300 && response.status !== 404)
    throw new Error(`Storage DELETE returned ${response.status}`)
}

export const s3 = {
  copyObjectToTrash,
  restoreFromTrashIfMissing,
  deleteObjectKey,
  listObjectPage,
  getSize,
  deleteObject,
  statObject,
  putObject,
  getObjectRange,
  readObjectStream,
  copyObject,
  removeObject,
  getSizeDiagnostics,
  moveObjectToTrash,
  deleteObjectsWithPrefix,
  checkIfExist,
  getSignedUrl,
  getUploadUrl,
  getObject,
}

export const s3TestUtils = {
  shouldUseSizeRangeFallback,
}
