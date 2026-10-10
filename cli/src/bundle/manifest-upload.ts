import type { CapgoCliInvokeOptions } from '../utils'
import type { UploadSpinner } from './reporter'
import { CliUserError } from '../shared/cli-user-error'
import { formatCapgoCliInvokeError, invokeCapgoCliApi } from '../utils'
import { getUploadReporter } from './reporter'

export const MANIFEST_UPLOAD_PROTOCOL_VERSION = 1 as const

export type ManifestUploadAction = 'upload_if_doesnt_exist' | 'reuse' | 'upload'
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
  protocol_version: typeof MANIFEST_UPLOAD_PROTOCOL_VERSION
  version_id: number
  delta_encryption: { enabled: boolean }
  manifest_upload_auto_enabled: boolean
  file_hash_format: ManifestUploadFileHashFormat
  entries: ManifestUploadRequestEntry[]
}

interface ManifestUploadAuthorization {
  type: 'header'
  header_name: string
  token_prefix: string
  expires_at: number
}

export interface ManifestUploadTarget {
  id: string
  protocol: 'tus'
  upload_url: string
  existence_check_url_prefix: string
  authorization: ManifestUploadAuthorization
}

interface ManifestUploadResponseEntry {
  id: number
  action?: ManifestUploadAction
  upload_target?: string
  s3_path?: string
  s3_path_suffix?: string
  upload_token?: string
  file_size_receipt?: string
}

export interface ManifestUploadResponse {
  protocol_version: number
  version_id: number
  default_action: ManifestUploadAction
  default_s3_path_prefix?: string
  default_upload_target?: string
  upload_targets: ManifestUploadTarget[]
  entries: ManifestUploadResponseEntry[]
}

export interface ResolvedManifestUploadEntry {
  request: ManifestUploadRequestEntry
  action: ManifestUploadAction
  s3Path: string
  uploadTarget?: ManifestUploadTarget
  uploadAuthorization?: { headerName: string, value: string }
  fileSizeReceipt?: string
}

export interface ResolvedManifestUpload {
  response: ManifestUploadResponse
  entries: ResolvedManifestUploadEntry[]
}

export function manifestUploadFileHashFormat(encryptionEnabled: boolean, supportsHexChecksum: boolean): ManifestUploadFileHashFormat {
  return encryptionEnabled
    ? (supportsHexChecksum ? 'rsa_v3_hex' : 'rsa_v2_base64')
    : 'sha256_hex'
}

export function isManifestUploadAutoEnabled(userRequestedDelta: boolean, fullZipEnabled: boolean): boolean {
  return !userRequestedDelta && fullZipEnabled
}

type ManifestUploadInvoke = typeof invokeCapgoCliApi

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const ACTIONS = new Set<ManifestUploadAction>(['upload_if_doesnt_exist', 'reuse', 'upload'])
const MAX_S3_PATH_LENGTH = 2_048

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127)
      return true
  }
  return false
}

function hasInvalidHeaderValueCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 31 || code === 127 || code > 255)
      return true
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(detail: string): never {
  throw new CliUserError(`Invalid manifest upload authorization response: ${detail}`)
}

function validHttpUrl(value: unknown, field: string, requireTrailingSlash = false): string {
  if (typeof value !== 'string')
    invalidResponse(`${field} must be a URL`)
  let parsed: URL
  try {
    parsed = new URL(value)
  }
  catch {
    invalidResponse(`${field} must be a valid absolute URL`)
  }
  const isLoopbackHttp = parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]')
  if (parsed.protocol !== 'https:' && !isLoopbackHttp)
    invalidResponse(`${field} must use HTTPS`)
  if (parsed.username || parsed.password || parsed.hash)
    invalidResponse(`${field} contains unsupported URL components`)
  if (requireTrailingSlash && !value.endsWith('/'))
    invalidResponse(`${field} must end with /`)
  return value
}

function validS3Path(value: string): boolean {
  if (!value || value.length > MAX_S3_PATH_LENGTH || value.startsWith('/') || value.includes('\\') || hasControlCharacter(value))
    return false
  const segments = value.split('/')
  return segments.length >= 5
    && segments[0] === 'orgs'
    && !!segments[1]
    && segments[2] === 'apps'
    && !!segments[3]
    && segments.slice(4).every(segment => !!segment && segment !== '.' && segment !== '..')
}

function parseTarget(raw: unknown, index: number): ManifestUploadTarget {
  if (!isRecord(raw))
    invalidResponse(`upload_targets[${index}] must be an object`)
  if (typeof raw.id !== 'string' || !raw.id || hasControlCharacter(raw.id))
    invalidResponse(`upload_targets[${index}].id must be a nonempty string`)
  if (raw.protocol !== 'tus')
    invalidResponse(`upload target ${raw.id} uses an unsupported protocol`)
  if (!isRecord(raw.authorization) || raw.authorization.type !== 'header')
    invalidResponse(`upload target ${raw.id} uses unsupported authorization`)
  const headerName = raw.authorization.header_name
  const tokenPrefix = raw.authorization.token_prefix
  const expiresAt = raw.authorization.expires_at
  if (typeof headerName !== 'string' || !HEADER_NAME.test(headerName))
    invalidResponse(`upload target ${raw.id} has an invalid authorization header name`)
  if (typeof tokenPrefix !== 'string' || hasInvalidHeaderValueCharacter(tokenPrefix))
    invalidResponse(`upload target ${raw.id} has an invalid authorization token prefix`)
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
    invalidResponse(`upload target ${raw.id} has an invalid expiration`)

  return {
    id: raw.id,
    protocol: 'tus',
    upload_url: validHttpUrl(raw.upload_url, `upload target ${raw.id} upload_url`),
    existence_check_url_prefix: validHttpUrl(raw.existence_check_url_prefix, `upload target ${raw.id} existence_check_url_prefix`, true),
    authorization: {
      type: 'header',
      header_name: headerName,
      token_prefix: tokenPrefix,
      expires_at: expiresAt,
    },
  }
}

export function resolveManifestUploadResponse(request: ManifestUploadRequest, input: unknown): ResolvedManifestUpload {
  if (!isRecord(input))
    invalidResponse('body must be an object')
  if (input.protocol_version !== request.protocol_version)
    invalidResponse('protocol_version does not match the request')
  if (input.version_id !== request.version_id)
    invalidResponse('version_id does not match the request')
  if (!ACTIONS.has(input.default_action as ManifestUploadAction))
    invalidResponse('default_action is invalid')
  if (input.default_s3_path_prefix !== undefined && typeof input.default_s3_path_prefix !== 'string')
    invalidResponse('default_s3_path_prefix must be a string')
  if (input.default_upload_target !== undefined && typeof input.default_upload_target !== 'string')
    invalidResponse('default_upload_target must be a string')
  if (!Array.isArray(input.upload_targets))
    invalidResponse('upload_targets must be an array')
  if (!Array.isArray(input.entries))
    invalidResponse('entries must be an array')

  const targets = new Map<string, ManifestUploadTarget>()
  for (const [index, rawTarget] of input.upload_targets.entries()) {
    const target = parseTarget(rawTarget, index)
    if (targets.has(target.id))
      invalidResponse(`upload target ${target.id} is duplicated`)
    targets.set(target.id, target)
  }
  if (typeof input.default_upload_target === 'string' && !targets.has(input.default_upload_target))
    invalidResponse('default_upload_target references an unknown upload target')

  const requestEntries = new Map(request.entries.map(entry => [entry.id, entry]))
  if (requestEntries.size !== request.entries.length)
    invalidResponse('request contains duplicate entry ids')
  const seenResponseIds = new Set<number>()
  const seenS3Paths = new Set<string>()
  const resolvedById = new Map<number, ResolvedManifestUploadEntry>()
  for (const [index, rawEntry] of input.entries.entries()) {
    if (!isRecord(rawEntry))
      invalidResponse(`entries[${index}] must be an object`)
    const id = rawEntry.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || !requestEntries.has(id))
      invalidResponse(`entries[${index}].id is unknown`)
    if (seenResponseIds.has(id))
      invalidResponse(`entry id ${id} is duplicated`)
    seenResponseIds.add(id)

    const action = (rawEntry.action ?? input.default_action) as ManifestUploadAction
    if (!ACTIONS.has(action))
      invalidResponse(`entry id ${id} has an invalid action`)
    if (rawEntry.s3_path !== undefined && typeof rawEntry.s3_path !== 'string')
      invalidResponse(`entry id ${id} has an invalid s3_path`)
    if (rawEntry.s3_path_suffix !== undefined && typeof rawEntry.s3_path_suffix !== 'string')
      invalidResponse(`entry id ${id} has an invalid s3_path_suffix`)
    const hasFullPath = typeof rawEntry.s3_path === 'string'
    const hasSuffix = typeof rawEntry.s3_path_suffix === 'string'
    if (hasFullPath === hasSuffix)
      invalidResponse(`entry id ${id} must contain exactly one path representation`)
    if (hasSuffix && typeof input.default_s3_path_prefix !== 'string')
      invalidResponse(`entry id ${id} requires default_s3_path_prefix`)
    const s3Path = hasFullPath
      ? rawEntry.s3_path as string
      : `${input.default_s3_path_prefix as string}${rawEntry.s3_path_suffix as string}`
    if (!validS3Path(s3Path))
      invalidResponse(`entry id ${id} has an invalid s3 path`)
    if (seenS3Paths.has(s3Path))
      invalidResponse(`entry id ${id} duplicates another s3 path`)
    seenS3Paths.add(s3Path)

    let uploadTarget: ManifestUploadTarget | undefined
    let uploadAuthorization: { headerName: string, value: string } | undefined
    if (rawEntry.upload_target !== undefined && (typeof rawEntry.upload_target !== 'string' || !targets.has(rawEntry.upload_target)))
      invalidResponse(`entry id ${id} references an unknown upload target`)
    if (action !== 'reuse') {
      const targetId = rawEntry.upload_target ?? input.default_upload_target
      if (typeof targetId !== 'string' || !(uploadTarget = targets.get(targetId)))
        invalidResponse(`entry id ${id} references an unknown upload target`)
      if (typeof rawEntry.upload_token !== 'string')
        invalidResponse(`entry id ${id} is missing upload_token`)
      const token = `${uploadTarget.authorization.token_prefix}${rawEntry.upload_token}`
      if (!token || hasInvalidHeaderValueCharacter(token))
        invalidResponse(`entry id ${id} has an invalid upload token`)
      uploadAuthorization = {
        headerName: uploadTarget.authorization.header_name,
        value: token,
      }
    }

    let fileSizeReceipt: string | undefined
    if (action === 'reuse') {
      if (typeof rawEntry.file_size_receipt !== 'string' || !rawEntry.file_size_receipt)
        invalidResponse(`entry id ${id} is missing file_size_receipt`)
      fileSizeReceipt = rawEntry.file_size_receipt
    }

    resolvedById.set(id, {
      request: requestEntries.get(id)!,
      action,
      s3Path,
      uploadTarget,
      uploadAuthorization,
      fileSizeReceipt,
    })
  }

  if (seenResponseIds.size !== request.entries.length)
    invalidResponse('response does not contain exactly one entry for every request entry')

  const response = {
    ...input,
    upload_targets: [...targets.values()],
    entries: input.entries,
  } as unknown as ManifestUploadResponse
  return {
    response,
    entries: request.entries.map(entry => resolvedById.get(entry.id)!),
  }
}

export async function requestManifestUpload(
  apikey: string,
  request: ManifestUploadRequest,
  options: Pick<CapgoCliInvokeOptions, 'apiHost'> = {},
  invoke: ManifestUploadInvoke = invokeCapgoCliApi,
): Promise<ResolvedManifestUpload> {
  let spinner: UploadSpinner | undefined
  const spinnerTimer = setTimeout(() => {
    spinner = getUploadReporter().spinner()
    spinner.start('Requesting delta upload authorization')
  }, 500)

  try {
    const { data, error } = await invoke<unknown>('private/request_manifest_upload', {
      apikey,
      body: request,
      apiHost: options.apiHost,
    })
    if (error)
      throw new CliUserError(`Cannot request manifest upload: ${await formatCapgoCliInvokeError(error)}`)
    const resolved = resolveManifestUploadResponse(request, data)
    spinner?.stop('Delta upload authorized')
    return resolved
  }
  catch (error) {
    spinner?.error('Cannot authorize delta upload')
    throw error
  }
  finally {
    clearTimeout(spinnerTimer)
  }
}
