import { encodeManifestPathSegment, encodeManifestPathSegments } from './manifest_encoding.ts'
import { MAX_FILE_HASH_LENGTH, MAX_FILE_NAME_LENGTH, MAX_MANIFEST_ENTRIES, MAX_S3_PATH_LENGTH } from './manifest_limits.ts'
import { createManifestUploadCapabilitySigner, MANIFEST_UPLOAD_CAPABILITY_HEADER, MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS } from './manifest_upload_capability.ts'

export const MAX_MANIFEST_UPLOAD_BODY_BYTES = 32 * 1024 * 1024

export type ManifestUploadFileHashFormat = 'sha256_hex' | 'rsa_v2_base64' | 'rsa_v3_hex'

export interface ManifestUploadRequestEntry {
  id: number
  file_name: string
  compression: 'none' | 'brotli'
  file_hash: string
  uploaded_bytes_sha256: string
  uploaded_bytes_size: number
}

export interface ManifestUploadRequest {
  protocol_version: 1
  version_id: number
  delta_encryption: { enabled: boolean }
  manifest_upload_auto_enabled: boolean
  file_hash_format: ManifestUploadFileHashFormat
  entries: ManifestUploadRequestEntry[]
}

export interface ManifestUploadResponse {
  protocol_version: 1
  version_id: number
  default_action: 'upload_if_doesnt_exist'
  default_s3_path_prefix: string
  default_upload_target: 'capgo_tus_v1'
  upload_targets: Array<{
    id: 'capgo_tus_v1'
    protocol: 'tus'
    upload_url: string
    existence_check_url_prefix: string
    authorization: {
      type: 'header'
      header_name: typeof MANIFEST_UPLOAD_CAPABILITY_HEADER
      token_prefix: string
      expires_at: number
    }
  }>
  entries: Array<{
    id: number
    s3_path_suffix: string
    upload_token: string
  }>
}

export interface ManifestUploadCapabilityOptions {
  ownerOrg: string
  appId: string
  sessionKey: string | null
  secret: string
  keyId: string
  publicBaseUrl: string
  nowUnix?: number
  concurrency?: number
}

const TOP_LEVEL_FIELDS = new Set([
  'protocol_version',
  'version_id',
  'delta_encryption',
  'manifest_upload_auto_enabled',
  'file_hash_format',
  'entries',
])
const DELTA_ENCRYPTION_FIELDS = new Set(['enabled'])
const ENTRY_FIELDS = new Set([
  'id',
  'file_name',
  'compression',
  'file_hash',
  'uploaded_bytes_sha256',
  'uploaded_bytes_size',
])
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/
const RSA_V3_HEX = /^[0-9a-f]{512}$/
const DEFAULT_CRYPTO_CONCURRENCY = 32
const encoder = new TextEncoder()

export class ManifestUploadRequestError extends Error {
  constructor(
    readonly status: 400 | 409 | 413 | 422 | 503,
    readonly code: string,
    message: string,
    readonly moreInfo: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function invalidRequest(field: string): never {
  throw new ManifestUploadRequestError(
    400,
    'error_manifest_upload_request_invalid',
    'Manifest upload request is invalid',
    { field },
  )
}

function manifestTooLarge(moreInfo: Record<string, unknown>): never {
  throw new ManifestUploadRequestError(
    413,
    'error_manifest_too_large',
    'Manifest upload request is too large',
    moreInfo,
  )
}

function signingUnavailable(): never {
  throw new ManifestUploadRequestError(
    503,
    'upload_authorization_unavailable',
    'Upload authorization is unavailable',
  )
}

function invalidEntry(index: number, field: keyof ManifestUploadRequestEntry): never {
  throw new ManifestUploadRequestError(
    422,
    'error_manifest_entry_invalid',
    'Manifest entry is invalid',
    { field: `entries[${index}].${field}`, index },
  )
}

function firstUnexpectedField(input: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(input).find(field => !allowed.has(field))
}

function isCanonicalRsaV2Base64(value: string): boolean {
  if (value.length !== 344)
    return false
  try {
    const decoded = atob(value)
    return decoded.length === 256 && btoa(decoded) === value
  }
  catch {
    return false
  }
}

function isValidFileName(value: string, compression: 'none' | 'brotli'): boolean {
  if (!value || value.length > MAX_FILE_NAME_LENGTH || value.startsWith('/') || value.includes('\\') || value.includes('\0'))
    return false
  const segments = value.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..'))
    return false
  if ((compression === 'brotli') !== value.endsWith('.br'))
    return false
  try {
    segments.forEach(segment => encodeManifestPathSegment(segment))
    return true
  }
  catch {
    return false
  }
}

function hasValidFileHash(value: string, format: ManifestUploadFileHashFormat): boolean {
  if (!value || value.length > MAX_FILE_HASH_LENGTH)
    return false
  if (format === 'sha256_hex')
    return LOWERCASE_SHA256.test(value)
  if (format === 'rsa_v2_base64')
    return isCanonicalRsaV2Base64(value)
  return RSA_V3_HEX.test(value)
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
}

function utf8ToHex(value: string): string {
  return Array.from(encoder.encode(value), byte => byte.toString(16).padStart(2, '0')).join('')
}

function normalizeBaseUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return ''
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  }
  catch {
    return ''
  }
}

async function mapWithConcurrency<T, U>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<U>): Promise<U[]> {
  const output = new Array<U>(values.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++
      output[index] = await mapper(values[index]!, index)
    }
  })
  await Promise.all(workers)
  return output
}

export function resolveManifestUploadPublicBaseUrl(requestUrl: string, configuredPublicUrl: string): string {
  const configured = normalizeBaseUrl(configuredPublicUrl)
  if (configured)
    return configured

  const request = new URL(requestUrl)
  const functionsPrefix = request.pathname.includes('/functions/v1/') ? '/functions/v1' : ''
  return `${request.origin}${functionsPrefix}`
}

export async function createManifestUploadResponse(
  request: ManifestUploadRequest,
  options: ManifestUploadCapabilityOptions,
): Promise<ManifestUploadResponse> {
  const publicBaseUrl = normalizeBaseUrl(options.publicBaseUrl)
  if (!publicBaseUrl)
    signingUnavailable()

  const sessionKeyPath = request.delta_encryption.enabled
    ? options.sessionKey && utf8ToHex(options.sessionKey)
    : ''
  if (request.delta_encryption.enabled && !sessionKeyPath) {
    throw new ManifestUploadRequestError(
      409,
      'error_delta_encryption_invalid',
      'Delta encryption configuration is invalid',
      { field: 'delta_encryption.enabled' },
    )
  }

  const defaultS3PathPrefix = `orgs/${options.ownerOrg}/apps/${options.appId}/delta/${sessionKeyPath ? `${sessionKeyPath}/` : ''}`
  if (defaultS3PathPrefix.length > MAX_S3_PATH_LENGTH)
    signingUnavailable()

  const encodedFileNames = request.entries.map((entry, index) => {
    const encodedFileName = encodeManifestPathSegments(entry.file_name)
    if (defaultS3PathPrefix.length + 64 + 1 + encodedFileName.length > MAX_S3_PATH_LENGTH)
      invalidEntry(index, 'file_name')
    return encodedFileName
  })

  const nowUnix = options.nowUnix ?? Math.floor(Date.now() / 1000)
  const expiresAt = nowUnix + MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS
  const capabilitySigner = await createManifestUploadCapabilitySigner({
    expiresAt,
    keyId: options.keyId,
    manifestUploadAutoEnabled: request.manifest_upload_auto_enabled,
    secret: options.secret,
    versionId: request.version_id,
  }, nowUnix).catch(() => signingUnavailable())
  const seenPaths = new Set<string>()

  const entries = await mapWithConcurrency(
    request.entries,
    Math.max(1, Math.min(options.concurrency ?? DEFAULT_CRYPTO_CONCURRENCY, DEFAULT_CRYPTO_CONCURRENCY)),
    async (entry, index) => {
      const filenameHash = bytesToHex(await crypto.subtle.digest('SHA-256', encoder.encode(entry.file_hash)))
      const encodedFileName = encodedFileNames[index]!
      const s3PathSuffix = `${filenameHash}_${encodedFileName}`
      const normalizedS3Path = `${defaultS3PathPrefix}${s3PathSuffix}`
      if (seenPaths.has(normalizedS3Path))
        invalidEntry(index, 'file_name')
      seenPaths.add(normalizedS3Path)

      const capability = await capabilitySigner.create(normalizedS3Path)
      return {
        id: entry.id,
        s3_path_suffix: s3PathSuffix,
        upload_token: capability.uploadToken,
      }
    },
  )

  return {
    protocol_version: 1,
    version_id: request.version_id,
    default_action: 'upload_if_doesnt_exist',
    default_s3_path_prefix: defaultS3PathPrefix,
    default_upload_target: 'capgo_tus_v1',
    upload_targets: [{
      id: 'capgo_tus_v1',
      protocol: 'tus',
      upload_url: `${publicBaseUrl}/files/upload/attachments/`,
      existence_check_url_prefix: `${publicBaseUrl}/files/read/attachments/`,
      authorization: {
        type: 'header',
        header_name: MANIFEST_UPLOAD_CAPABILITY_HEADER,
        token_prefix: capabilitySigner.tokenPrefix,
        expires_at: expiresAt,
      },
    }],
    entries,
  }
}

export async function parseManifestUploadRequestBody(request: Request): Promise<{ body: unknown, byteLength: number }> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_UPLOAD_BODY_BYTES) {
    manifestTooLarge({
      field: 'body',
      max_bytes: MAX_MANIFEST_UPLOAD_BODY_BYTES,
      declared_bytes: declaredLength,
    })
  }

  // Consume the original body deliberately: global error reporting must never
  // copy a submitted 10,000-entry manifest into logs or alert payloads. Read it
  // incrementally so a chunked request cannot bypass the in-memory byte cap.
  const chunks: Uint8Array[] = []
  const reader = request.body?.getReader()
  let byteLength = 0
  if (reader) {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      byteLength += value.byteLength
      if (byteLength > MAX_MANIFEST_UPLOAD_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        manifestTooLarge({
          field: 'body',
          max_bytes: MAX_MANIFEST_UPLOAD_BODY_BYTES,
          actual_bytes: byteLength,
        })
      }
      chunks.push(value)
    }
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return {
      body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      byteLength,
    }
  }
  catch {
    invalidRequest('body')
  }
}

export function validateManifestUploadRequest(input: unknown): ManifestUploadRequest {
  if (!isRecord(input))
    invalidRequest('body')

  const unexpectedField = firstUnexpectedField(input, TOP_LEVEL_FIELDS)
  if (unexpectedField) {
    invalidRequest(unexpectedField)
  }

  if (input.protocol_version !== 1)
    invalidRequest('protocol_version')
  if (typeof input.version_id !== 'number' || !Number.isSafeInteger(input.version_id) || input.version_id <= 0)
    invalidRequest('version_id')
  if (!isRecord(input.delta_encryption))
    invalidRequest('delta_encryption')
  const unexpectedEncryptionField = firstUnexpectedField(input.delta_encryption, DELTA_ENCRYPTION_FIELDS)
  if (unexpectedEncryptionField)
    invalidRequest(`delta_encryption.${unexpectedEncryptionField}`)
  if (typeof input.delta_encryption.enabled !== 'boolean')
    invalidRequest('delta_encryption')
  if (typeof input.manifest_upload_auto_enabled !== 'boolean')
    invalidRequest('manifest_upload_auto_enabled')
  if (!['sha256_hex', 'rsa_v2_base64', 'rsa_v3_hex'].includes(input.file_hash_format as string))
    invalidRequest('file_hash_format')
  if (!Array.isArray(input.entries) || input.entries.length === 0)
    invalidRequest('entries')
  if (input.entries.length > MAX_MANIFEST_ENTRIES) {
    manifestTooLarge({ field: 'entries', max: MAX_MANIFEST_ENTRIES, count: input.entries.length })
  }

  const encryptionEnabled = input.delta_encryption.enabled
  const fileHashFormat = input.file_hash_format as ManifestUploadFileHashFormat
  if ((encryptionEnabled && fileHashFormat === 'sha256_hex') || (!encryptionEnabled && fileHashFormat !== 'sha256_hex')) {
    throw new ManifestUploadRequestError(
      409,
      'error_delta_encryption_invalid',
      'Delta encryption configuration is invalid',
      { field: 'file_hash_format' },
    )
  }

  const ids = new Set<number>()
  const fileNames = new Set<string>()
  for (const [index, rawEntry] of input.entries.entries()) {
    if (!isRecord(rawEntry))
      invalidEntry(index, 'id')
    const unexpectedEntryField = firstUnexpectedField(rawEntry, ENTRY_FIELDS)
    if (unexpectedEntryField)
      invalidRequest(`entries[${index}].${unexpectedEntryField}`)

    if (typeof rawEntry.id !== 'number' || !Number.isSafeInteger(rawEntry.id))
      invalidEntry(index, 'id')
    if (ids.has(rawEntry.id))
      invalidRequest(`entries[${index}].id`)
    ids.add(rawEntry.id)

    if (rawEntry.compression !== 'none' && rawEntry.compression !== 'brotli')
      invalidEntry(index, 'compression')
    if (typeof rawEntry.file_name !== 'string' || !isValidFileName(rawEntry.file_name, rawEntry.compression))
      invalidEntry(index, 'file_name')
    if (fileNames.has(rawEntry.file_name))
      invalidEntry(index, 'file_name')
    fileNames.add(rawEntry.file_name)

    if (typeof rawEntry.file_hash !== 'string' || !hasValidFileHash(rawEntry.file_hash, fileHashFormat))
      invalidEntry(index, 'file_hash')
    if (typeof rawEntry.uploaded_bytes_sha256 !== 'string' || !LOWERCASE_SHA256.test(rawEntry.uploaded_bytes_sha256))
      invalidEntry(index, 'uploaded_bytes_sha256')
    if (typeof rawEntry.uploaded_bytes_size !== 'number' || !Number.isSafeInteger(rawEntry.uploaded_bytes_size) || rawEntry.uploaded_bytes_size < 0)
      invalidEntry(index, 'uploaded_bytes_size')
  }

  return input as unknown as ManifestUploadRequest
}
