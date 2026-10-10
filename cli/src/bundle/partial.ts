import type { manifestType } from '../utils'
import type { OptionsUpload } from './upload_interface'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { platform as osPlatform } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { cwd } from 'node:process'
import { buffer as readBuffer } from 'node:stream/consumers'
import { createBrotliCompress } from 'node:zlib'
import { parse } from '@std/semver'
// @ts-expect-error - No type definitions available for micromatch
import * as micromatch from 'micromatch'
import * as tus from 'tus-js-client'
import { buildCliRequestHeaders } from '../analytics/cli-headers'
import { encryptChecksum, encryptChecksumV3, encryptSource } from '../api/crypto'
import { CliUserError } from '../shared/cli-user-error'
import { isTransientNetworkError } from '../shared/network-error'
import { appAddHintMessage, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, deltaManifestTooLargeMessage, findRoot, formatVerboseError, generateManifest, getContentType, getInstalledVersion, isAppNotFoundError, isDeprecatedPluginVersion, MAX_MANIFEST_ENTRIES, sendEvent, TUS_UPLOAD_RETRY_DELAYS } from '../utils'
import type { ManifestUploadRequestEntry, ResolvedManifestUpload, ResolvedManifestUploadEntry } from './manifest-upload'
import { getUploadReporter } from './reporter'
import { getManifestUploadAbandonError, ManifestUploadAbandonController, ManifestUploadAbandonError, parseManifestUploadAbandonBody } from './upload-abandon-error'

const log = {
  info: (message: string) => getUploadReporter().info(message),
  warn: (message: string) => getUploadReporter().warn(message),
  error: (message: string) => getUploadReporter().error(message),
}

export async function fileExistsAtUploadTarget(existenceCheckUrlPrefix: string, filename: string): Promise<{ exists: boolean, receipt?: string }> {
  const url = new URL(`${existenceCheckUrlPrefix}${encodeURIComponent(filename)}`)
  const retryDelays = TUS_UPLOAD_RETRY_DELAYS.slice(0, 3)

  for (let attempt = 0; ; attempt++) {
    url.searchParams.set('nocache', `${Date.now()}`)
    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: buildCliRequestHeaders({ 'cache-control': 'no-cache' }),
      })
      if (response.status === 404)
        return { exists: false }
      if (!response.ok)
        throw new CliUserError(`Cannot check whether manifest file exists (HTTP ${response.status})`)
      return {
        exists: true,
        receipt: response.headers.get('X-Capgo-Manifest-Size-Receipt') ?? undefined,
      }
    }
    catch (error) {
      const retryDelay = retryDelays[attempt]
      if (!isTransientNetworkError(error) || retryDelay === undefined)
        throw error
      if (retryDelay > 0)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
    }
  }
}

// Minimum size for Brotli compression according to RFC
// Files smaller than this won't be compressed with Brotli
const BROTLI_MIN_SIZE = 8192

// Check if the updater version supports .br extension
async function getUpdaterVersion(uploadOptions: OptionsUpload): Promise<{ version: string | null, supportsBrotliV2: boolean }> {
  const root = findRoot(cwd())
  const updaterVersion = await getInstalledVersion('@capgo/capacitor-updater', root, uploadOptions.packageJson)
  let coerced
  try {
    coerced = updaterVersion ? parse(updaterVersion) : undefined
  }
  catch {
    coerced = undefined
  }

  if (!updaterVersion || !coerced)
    return { version: null, supportsBrotliV2: false }

  // Brotli is supported in updater versions >= 5.10.0 (v5), >= 6.25.0 (v6) or >= 7.0.35 (v7)
  const supportsBrotliV2 = !isDeprecatedPluginVersion(coerced, undefined, undefined, BROTLI_MIN_UPDATER_VERSION_V7)

  return { version: `${coerced.major}.${coerced.minor}.${coerced.patch}`, supportsBrotliV2 }
}

// Check if a file should be excluded from brotli compression
function shouldExcludeFromBrotli(filePath: string, noBrotliPatterns?: string): boolean {
  if (!noBrotliPatterns) {
    return false
  }

  const patterns = noBrotliPatterns.split(',').map(p => p.trim()).filter(p => !!p)
  if (patterns.length === 0) {
    return false
  }

  return micromatch.isMatch(filePath, patterns)
}

// Function to determine if a file should use Brotli compression (for version >= 7.0.37)
async function shouldUseBrotli(
  filePath: string,
  filePathUnix: string,
  options: OptionsUpload,
): Promise<{ buffer: Buffer, useBrotli: boolean }> {
  const stats = statSync(filePath)
  const fileSize = stats.size
  const originalBuffer = await readBuffer(createReadStream(filePath))

  if (fileSize === 0) {
    // Empty files - just return the original content (which is empty)
    return { buffer: originalBuffer, useBrotli: false }
  }

  // Skip brotli if file matches exclusion patterns
  if (shouldExcludeFromBrotli(filePathUnix, options.noBrotliPatterns)) {
    // Don't compress excluded files - just return the original content
    return { buffer: originalBuffer, useBrotli: false }
  }

  // Skip brotli for files smaller than RFC minimum size
  if (fileSize < BROTLI_MIN_SIZE) {
    // Don't compress small files - just return the original content
    return { buffer: originalBuffer, useBrotli: false }
  }

  try {
    // Try Brotli compression
    const compressedBuffer = await readBuffer(createReadStream(filePath).pipe(createBrotliCompress({})))

    // If compression isn't effective, don't use Brotli and don't compress
    if (compressedBuffer.length >= fileSize - 10) {
      return { buffer: originalBuffer, useBrotli: false }
    }

    // Brotli compression worked well
    return { buffer: compressedBuffer, useBrotli: true }
  }
  catch (error) {
    log.warn(`Brotli compression failed for ${filePath}: ${error}, using original file`)
    return { buffer: originalBuffer, useBrotli: false }
  }
}

export async function prepareBundlePartialFiles(
  path: string,
  apikey: string,
  orgId: string,
  appid: string,
  encryptionMethod: 'none' | 'v2' | 'v1',
  finalKeyData: string,
  supportsHexChecksum: boolean = false,
  plainHashes?: Map<string, string>,
) {
  const spinner = getUploadReporter().spinner()
  spinner.start(encryptionMethod !== 'v2' ? 'Generating the update manifest' : `Generating the update manifest with ${supportsHexChecksum ? 'V3' : 'V2'} encryption`)
  const manifest = await generateManifest(path)

  // Keep the plain sha256 of every file keyed by the hash that ends up in the manifest
  // (encrypted or not) so the manifest signature can be built from the plain values.
  for (const file of manifest)
    plainHashes?.set(file.hash, file.hash)

  if (encryptionMethod === 'v2') {
    for (const file of manifest) {
      const plainHash = file.hash
      // Use V3 for new plugin versions, V2 for old versions
      file.hash = supportsHexChecksum
        ? encryptChecksumV3(file.hash, finalKeyData)
        : encryptChecksum(file.hash, finalKeyData)
      if (plainHashes) {
        plainHashes.delete(plainHash)
        plainHashes.set(file.hash, plainHash)
      }
    }
  }

  spinner.stop('Manifest generated successfully')

  await sendEvent(apikey, {
    channel: 'partial-update',
    event: 'Generate manifest',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appid,
    },
  })

  return manifest
}

function convertToUnixPath(windowsPath: string): string {
  if (osPlatform() !== 'win32') {
    return windowsPath
  }
  const normalizedPath = win32.normalize(windowsPath)
  return normalizedPath.split(win32.sep).join(posix.sep)
}

export interface PartialEncryptionOptions {
  sessionKey: Buffer
  ivSessionKey: string
}

interface PreparedPartialPayload {
  buffer: Buffer
  fileName: string
  compression: 'none' | 'brotli'
  uploadedBytesSha256: string
  uploadedBytesSize: number
}

export class PartialUploadValidationError extends CliUserError {
  constructor(message: string) {
    super(message)
    this.name = 'PartialUploadValidationError'
  }
}

async function validatePartialUpload(manifest: manifestType, options: OptionsUpload) {
  const { version, supportsBrotliV2 } = await getUpdaterVersion(options)
  if (!supportsBrotliV2) {
    throw new PartialUploadValidationError(`Your project is using an older version of @capgo/capacitor-updater (${version || 'unknown'}). To use Delta updates, please upgrade to version ${BROTLI_MIN_UPDATER_VERSION_V5} (v5), ${BROTLI_MIN_UPDATER_VERSION_V6} (v6) or ${BROTLI_MIN_UPDATER_VERSION_V7} (v7) or higher.`)
  }

  if (options.disableBrotli) {
    log.info('Brotli compression disabled by user request')
  }
  else if (options.noBrotliPatterns) {
    log.info(`Files matching patterns (${options.noBrotliPatterns}) will be excluded from brotli compression`)
  }

  const filesWithSpaces = manifest.filter(file => file.file.includes(' '))
  if (filesWithSpaces.length > 0)
    throw new PartialUploadValidationError(`Files with spaces in their names (${filesWithSpaces.map(f => f.file).join(', ')}). Please rename the files.`)
  if (manifest.length > MAX_MANIFEST_ENTRIES)
    throw new PartialUploadValidationError(deltaManifestTooLargeMessage(manifest.length))
}

async function preparePartialPayload(
  file: manifestType[number],
  path: string,
  encryptionOptions: PartialEncryptionOptions | undefined,
  options: OptionsUpload,
): Promise<PreparedPartialPayload> {
  const finalFilePath = join(path, file.file)
  const filePathUnix = convertToUnixPath(file.file)
  const transformed = options.disableBrotli
    ? { buffer: await readBuffer(createReadStream(finalFilePath)), useBrotli: false }
    : await shouldUseBrotli(finalFilePath, filePathUnix, options)
  const buffer = encryptionOptions
    ? encryptSource(transformed.buffer, encryptionOptions.sessionKey, encryptionOptions.ivSessionKey)
    : transformed.buffer
  const fileName = transformed.useBrotli ? `${filePathUnix}.br` : filePathUnix
  return {
    buffer,
    fileName,
    compression: transformed.useBrotli ? 'brotli' : 'none',
    uploadedBytesSha256: createHash('sha256').update(buffer).digest('hex'),
    uploadedBytesSize: buffer.byteLength,
  }
}

export async function prepareManifestUploadEntries(
  manifest: manifestType,
  path: string,
  encryptionOptions: PartialEncryptionOptions | undefined,
  options: OptionsUpload,
): Promise<ManifestUploadRequestEntry[]> {
  await validatePartialUpload(manifest, options)
  if (manifest.length === 0)
    throw new CliUserError('Cannot request a manifest upload for an empty manifest')
  const entries: ManifestUploadRequestEntry[] = []
  for (const [id, file] of manifest.entries()) {
    const payload = await preparePartialPayload(file, path, encryptionOptions, options)
    entries.push({
      id,
      file_name: payload.fileName,
      compression: payload.compression,
      file_hash: file.hash,
      uploaded_bytes_sha256: payload.uploadedBytesSha256,
      uploaded_bytes_size: payload.uploadedBytesSize,
    })
  }
  return entries
}

function assertPreparedPayloadMatches(entry: ResolvedManifestUploadEntry, payload: PreparedPartialPayload) {
  if (
    entry.request.file_name !== payload.fileName
    || entry.request.compression !== payload.compression
    || entry.request.uploaded_bytes_sha256 !== payload.uploadedBytesSha256
    || entry.request.uploaded_bytes_size !== payload.uploadedBytesSize
  ) {
    throw new CliUserError(`Manifest file changed while preparing the upload: ${entry.request.file_name}`)
  }
}

export function buildPartialUploadHeaders(manifestUploadEntry: ResolvedManifestUploadEntry): Record<string, string> {
  return buildCliRequestHeaders({
    [manifestUploadEntry.uploadAuthorization!.headerName]: manifestUploadEntry.uploadAuthorization!.value,
  })
}

export async function uploadPartial(
  apikey: string,
  manifest: manifestType,
  path: string,
  appId: string,
  orgId: string,
  encryptionOptions: PartialEncryptionOptions | undefined,
  options: OptionsUpload,
  manifestUpload: ResolvedManifestUpload,
): Promise<any[] | null> {
  const spinner = getUploadReporter().spinner()
  spinner.start('Preparing delta update with TUS protocol')
  const startTime = performance.now()
  // Determine if user explicitly requested delta updates. Read the flag captured
  // before `options.delta` was mutated by the instant-update auto-enable, so an
  // auto-enabled delta degrades to a full upload instead of aborting.
  const userRequestedDelta = !!options.userRequestedDelta

  if (manifestUpload.entries.length !== manifest.length)
    throw new CliUserError('Manifest upload authorization does not match the local manifest')

  let uploadedFiles = 0
  const totalFiles = manifest.length
  const brFilesCount = manifestUpload.entries.filter(entry => entry.request.compression === 'brotli').length
  const abandonController = new ManifestUploadAbandonController()

  try {
    spinner.message(`Uploading ${totalFiles} files using TUS protocol`)

    // Helper function to upload a single file
    const uploadFile = async (file: manifestType[number], index: number) => {
      abandonController.throwIfAbandoned()
      const filePathUnix = convertToUnixPath(file.file)
      const payload = await preparePartialPayload(file, path, encryptionOptions, options)
      const finalBuffer = payload.buffer
      abandonController.throwIfAbandoned()

      const manifestUploadEntry = manifestUpload.entries[index]!
      if (manifestUploadEntry.request.file_hash !== file.hash)
        throw new CliUserError(`Manifest upload authorization does not match the local manifest entry ${index}`)
      assertPreparedPayloadMatches(manifestUploadEntry, payload)

      const uploadPathUnix = payload.fileName
      const filename = manifestUploadEntry.s3Path

      if (manifestUploadEntry.action === 'reuse') {
        uploadedFiles++
        return {
          file_name: uploadPathUnix,
          s3_path: filename,
          file_hash: file.hash,
          file_size_receipt: manifestUploadEntry.fileSizeReceipt,
        }
      }

      // Follow the server-selected action and existence-check target.
      let existing: Awaited<ReturnType<typeof fileExistsAtUploadTarget>> = { exists: false }
      if (manifestUploadEntry.action === 'upload_if_doesnt_exist') {
        try {
          existing = await fileExistsAtUploadTarget(manifestUploadEntry.uploadTarget!.existence_check_url_prefix, filename)
        }
        catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          throw new Error(`Cannot check whether delta file exists: ${filePathUnix}: ${reason}`, { cause: error })
        }
      }
      abandonController.throwIfAbandoned()
      if (existing.exists) {
        uploadedFiles++
        return Promise.resolve({
          file_name: uploadPathUnix,
          s3_path: filename,
          file_hash: file.hash,
          file_size_receipt: existing.receipt,
        })
      }

      return new Promise((resolve, reject) => {
        spinner.message(`Prepare upload delta file: ${filePathUnix}`)
        // Get the MIME type for this file (based on original filename, not the R2 path)
        const filetype = getContentType(uploadPathUnix)
        const uploadHeaders = buildPartialUploadHeaders(manifestUploadEntry)
        const upload = new tus.Upload(finalBuffer as any, {
          endpoint: manifestUploadEntry.uploadTarget!.upload_url,
          chunkSize: options.tusChunkSize,
          retryDelays: [...TUS_UPLOAD_RETRY_DELAYS],
          removeFingerprintOnSuccess: true,
          metadata: {
            filename,
            filetype,
          },
          headers: uploadHeaders,
          onAfterResponse(_request, response) {
            const abandonError = parseManifestUploadAbandonBody(response.getBody())
            if (abandonError)
              return abandonController.abandon(abandonError)
          },
          onError: (error) => {
            const abandonError = getManifestUploadAbandonError(error)
            if (abandonError) {
              void abandonController.abandon(abandonError)
              return
            }

            abandonController.unregister(upload)
            const errorMessage = options.verbose ? formatVerboseError(error) : error.toString()

            // Turn the backend's `app_not_found` rejection into the actionable `app add`
            // hint. Without this the raw tus error object escapes as an unhandled
            // rejection instead of a clear user error.
            if (isAppNotFoundError(error)) {
              log.error(`Failed to upload ${filePathUnix}: ${errorMessage}`)
              reject(new Error(appAddHintMessage(appId)))
              return
            }

            // Try to extract requestId from error message
            let requestId: string | undefined
            try {
              // TUS errors often include response text in the format: "response text: {json}"
              const responseTextMatch = errorMessage.match(/response text: (\{.*?\})/)
              if (responseTextMatch && responseTextMatch[1]) {
                const errorResponse = JSON.parse(responseTextMatch[1])
                requestId = errorResponse.moreInfo?.requestId
              }
            }
            catch {
              // Ignore JSON parse errors
            }

            const requestIdSuffix = requestId ? ` [requestId: ${requestId}]` : ''
            log.error(`Failed to upload ${filePathUnix}: ${errorMessage}${requestIdSuffix}`)

            reject(error)
          },
          onProgress() {
            const percentage = ((uploadedFiles / totalFiles) * 100).toFixed(2)
            spinner.message(`Uploading delta update: ${percentage}%`)
          },
          onSuccess({ lastResponse }) {
            abandonController.unregister(upload)
            uploadedFiles++
            resolve({
              file_name: uploadPathUnix,
              s3_path: filename,
              file_hash: file.hash,
              file_size_receipt: lastResponse.getHeader('X-Capgo-Manifest-Size-Receipt') ?? undefined,
            })
          },
        })

        if (abandonController.register(upload, reject))
          upload.start()
      })
    }

    // Process files in bounded batches to avoid overwhelming the server
    const BATCH_SIZE = options.deltaUploadConcurrency ?? 50
    const results: any[] = []

    for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
      abandonController.throwIfAbandoned()
      const batch = manifest.slice(i, i + BATCH_SIZE)
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1
      const totalBatches = Math.ceil(manifest.length / BATCH_SIZE)

      if (totalBatches > 1) {
        spinner.message(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)`)
      }

      const batchResults = await Promise.all(batch.map((file, batchIndex) => uploadFile(file, i + batchIndex)))
      results.push(...batchResults)
    }
    if (results.some(entry => !entry.file_size_receipt))
      throw new CliUserError('Manifest upload did not return a size receipt for every file')
    const endTime = performance.now()
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
    spinner.stop(`Delta update uploaded successfully 💪 in (${uploadTime} seconds)`)

    if (brFilesCount > 0) {
      log.info(`${brFilesCount} of ${totalFiles} files were compressed with brotli and use .br extension`)
    }

    await sendEvent(apikey, {
      channel: 'app',
      event: `App Partial TUS done${brFilesCount > 0 ? ' with .br extension' : ''}`,
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
      },
    })
    await sendEvent(apikey, {
      channel: 'performance',
      event: 'Partial upload performance',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
        'time': uploadTime,
      },
    })
    return results
  }
  catch (error) {
    const endTime = performance.now()
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
    spinner.error(`Failed to upload delta update (after ${uploadTime} seconds)`)

    if (error instanceof ManifestUploadAbandonError)
      throw error

    const errorMessage = options.verbose ? formatVerboseError(error) : String(error)
    if (userRequestedDelta) {
      // User explicitly requested delta/partial updates, so we should fail
      log.error(`Error uploading delta update: ${errorMessage}`)
      log.error(`Delta upload was explicitly requested but failed. Upload aborted.`)
      throw error
    }
    else {
      // Delta was auto-enabled, treat as non-critical
      log.info(`Error uploading delta update: ${errorMessage}, This is not a critical error, the bundle has been uploaded without the delta files`)
      return null
    }
  }
}
