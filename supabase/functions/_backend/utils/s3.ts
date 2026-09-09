import type { Context } from 'hono'
import type { Database } from '../utils/supabase.types.ts'
import { S3Client } from '@bradenmacdonald/s3-lite-client'
import type { RawS3LiteClient } from './r2_trash_shared.ts'
import { conditionalDeleteSource, encodeS3LiteCopySourceKey, isObjectNotFoundError } from './r2_trash_shared.ts'
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

export function resolveStorageEndpoint(c: Context): string {
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

    let forwardedHost = firstForwardedHeaderValue(c.req.header('X-Forwarded-Host'))
    const forwardedPort = firstForwardedHeaderValue(c.req.header('X-Forwarded-Port'))
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

function initS3(c: Context) {
  const access_key_id = getEnv(c, 'S3_ACCESS_KEY_ID')
  const access_key_secret = getEnv(c, 'S3_SECRET_ACCESS_KEY')
  const storageRegion = getEnv(c, 'S3_REGION') || 'us-east-1'
  const bucket = getEnv(c, 'S3_BUCKET')
  const client = new S3Client({
    endPoint: resolveStorageEndpoint(c),
    accessKey: access_key_id,
    pathStyle: true,
    secretKey: access_key_secret,
    region: storageRegion,
    bucket,
  })
  return client
}

export const R2_TRASH_PREFIX = 'deleted-after-7-days/'
const PREFIX_TRASH_CONCURRENCY = 10

export class TrashMoveError extends Error {
  readonly failedKeys: string[]
  readonly prefix: string

  constructor(prefix: string, failedKeys: string[]) {
    super(`Failed to move ${failedKeys.length} object(s) to trash for prefix ${prefix}`)
    this.name = 'TrashMoveError'
    this.prefix = prefix
    this.failedKeys = failedKeys
  }
}

function getTrashPath(fileId: string) {
  return `${R2_TRASH_PREFIX}${fileId}`
}

function isPermanentR2DeleteAllowed(c: Context): boolean {
  return getEnv(c, 'ALLOW_PERMANENT_R2_DELETE') === 'true'
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

async function moveObjectToTrash(c: Context, fileId: string) {
  if (fileId.startsWith(R2_TRASH_PREFIX))
    return true

  const client = initS3(c)
  const trashPath = getTrashPath(fileId)

  let sourceEtag: string | undefined
  try {
    const stat = await client.statObject(fileId)
    sourceEtag = stat.etag
  }
  catch (error) {
    if (isMissingObjectError(error) || isObjectNotFoundError(error)) {
      cloudlog({ requestId: c.get('requestId'), message: 'R2 object missing before trash move, skip copy', fileId })
      return true
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object stat failed before trash move', fileId, error: serializeStorageError(error) })
    return false
  }

  if (!sourceEtag) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object missing ETag before trash move, source retained', fileId })
    return false
  }

  try {
    await client.copyObject({ sourceKey: encodeS3LiteCopySourceKey(fileId) }, trashPath)
  }
  catch (error) {
    if (isMissingObjectError(error) || isObjectNotFoundError(error)) {
      cloudlog({ requestId: c.get('requestId'), message: 'R2 object disappeared during trash copy', fileId, error: serializeStorageError(error) })
      return true
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'move R2 object to trash copy failed', fileId, trashPath, error: serializeStorageError(error) })
    return false
  }

  let afterCopyEtag: string | undefined
  try {
    const afterCopy = await client.statObject(fileId)
    afterCopyEtag = afterCopy.etag
  }
  catch (error) {
    if (isMissingObjectError(error) || isObjectNotFoundError(error)) {
      cloudlog({ requestId: c.get('requestId'), message: 'R2 object absent after trash copy', fileId })
      return true
    }
    cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object stat failed after trash copy', fileId, error: serializeStorageError(error) })
    return false
  }

  if (afterCopyEtag !== sourceEtag) {
    cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object changed after trash copy, source retained', fileId })
    return false
  }

  const deleteResult = await conditionalDeleteSource(client as RawS3LiteClient, fileId, afterCopyEtag)
  if (deleteResult === 'deleted') {
    cloudlog({ requestId: c.get('requestId'), message: 'moved R2 object to trash', fileId, trashPath })
    return true
  }
  if (deleteResult === 'skipped_missing') {
    cloudlog({ requestId: c.get('requestId'), message: 'R2 object absent before conditional delete', fileId })
    return true
  }

  cloudlogErr({ requestId: c.get('requestId'), message: 'R2 object changed before conditional delete, source retained', fileId })
  return false
}

async function deleteObjectsWithPrefix(c: Context, prefix: string): Promise<number> {
  if (!isPermanentR2DeleteAllowed(c)) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'deleteObjectsWithPrefix blocked — permanent R2 delete is ops-only',
      prefix,
    })
    throw new Error('deleteObjectsWithPrefix requires ALLOW_PERMANENT_R2_DELETE=true; use moveObjectsWithPrefixToTrash for product deletes')
  }

  const client = initS3(c)
  let deletedCount = 0

  for await (const object of client.listObjects({ prefix })) {
    try {
      await client.deleteObject(object.key)
      deletedCount += 1
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'deleteObjectsWithPrefix item failed',
        prefix,
        key: object.key,
        error,
      })
      throw error
    }
  }

  return deletedCount
}

async function moveObjectsWithPrefixToTrash(c: Context, prefix: string): Promise<number> {
  const client = initS3(c)
  const failedKeys: string[] = []
  let movedCount = 0
  let batch: string[] = []

  async function moveKey(key: string) {
    try {
      const moved = await moveObjectToTrash(c, key)
      if (!moved) {
        failedKeys.push(key)
        return
      }
      movedCount += 1
    }
    catch (error) {
      cloudlogErr({
        requestId: c.get('requestId'),
        message: 'moveObjectsWithPrefixToTrash item failed',
        prefix,
        key,
        error,
      })
      failedKeys.push(key)
    }
  }

  async function flushBatch() {
    if (batch.length === 0)
      return

    const currentBatch = batch
    batch = []
    await Promise.all(currentBatch.map(moveKey))
  }

  const keys: string[] = []
  for await (const object of client.listObjects({ prefix })) {
    if (!object.key.startsWith(R2_TRASH_PREFIX))
      keys.push(object.key)
  }

  try {
    for (const key of keys) {
      batch.push(key)
      if (batch.length >= PREFIX_TRASH_CONCURRENCY)
        await flushBatch()
    }
  }
  finally {
    await flushBatch()
  }

  if (failedKeys.length > 0) {
    cloudlogErr({
      requestId: c.get('requestId'),
      message: 'moveObjectsWithPrefixToTrash failed closed',
      prefix,
      failedCount: failedKeys.length,
      movedCount,
      failedKeys,
    })
    throw new TrashMoveError(prefix, failedKeys)
  }

  return movedCount
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

export const s3 = {
  getSize,
  deleteObject,
  getSizeDiagnostics,
  moveObjectToTrash,
  moveObjectsWithPrefixToTrash,
  deleteObjectsWithPrefix,
  checkIfExist,
  getSignedUrl,
  getUploadUrl,
  getObject,
}

export const s3TestUtils = {
  shouldUseSizeRangeFallback,
}
