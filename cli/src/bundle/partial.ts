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
import { appAddHintMessage, BROTLI_MIN_UPDATER_VERSION_V5, BROTLI_MIN_UPDATER_VERSION_V6, BROTLI_MIN_UPDATER_VERSION_V7, deltaManifestTooLargeMessage, findRoot, generateManifest, getContentType, getInstalledVersion, getLocalConfig, isAppNotFoundError, isDeprecatedPluginVersion, MAX_MANIFEST_ENTRIES, sendEvent, TUS_UPLOAD_RETRY_DELAYS } from '../utils'
import { getUploadReporter } from './reporter'

const log = {
  info: (message: string) => getUploadReporter().info(message),
  warn: (message: string) => getUploadReporter().warn(message),
  error: (message: string) => getUploadReporter().error(message),
}

// Check if file already exists on server (bypass cache and force storage lookup)
async function fileExists(localConfig: any, filename: string): Promise<boolean> {
  try {
    const url = new URL(`${localConfig.hostFilesApi}/files/read/attachments/${encodeURIComponent(filename)}`)
    url.searchParams.set('nocache', `${Date.now()}`)
    const response = await fetch(url.toString(), {
      method: 'GET',
headers: buildCliRequestHeaders({ range: 'bytes=0-0', 'cache-control': 'no-cache' }),
    })
    return response.ok
  }
  catch {
    return false
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
) {
  const spinner = getUploadReporter().spinner()
  spinner.start(encryptionMethod !== 'v2' ? 'Generating the update manifest' : `Generating the update manifest with ${supportsHexChecksum ? 'V3' : 'V2'} encryption`)
  const manifest = await generateManifest(path)

  if (encryptionMethod === 'v2') {
    for (const file of manifest) {
      // Use V3 for new plugin versions, V2 for old versions
      file.hash = supportsHexChecksum
        ? encryptChecksumV3(file.hash, finalKeyData)
        : encryptChecksum(file.hash, finalKeyData)
    }
  }

  spinner.stop('Manifest generated successfully')

  await sendEvent(apikey, {
    channel: 'partial-update',
    event: 'Generate manifest',
    icon: '📂',
    org_id: orgId,
    tracking_version: 2,
    tags: {
      'app-id': appid,
    },
    notify: false,
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

function encodePathSegments(path: string): string {
  return path.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

export function buildPartialUploadPath(orgId: string, appId: string, fileHash: string, filePathUnix: string, encryptionOptions?: { ivSessionKey: string }) {
  // Keep the storage prefix short while preserving the full hash in manifest verification.
  const filenameHash = createHash('sha256').update(fileHash).digest('hex')
  const filePathUnixSafe = encodePathSegments(filePathUnix)

  if (encryptionOptions) {
    const ivSessionKeyHex = Buffer.from(encryptionOptions.ivSessionKey).toString('hex')
    return `orgs/${orgId}/apps/${appId}/delta/${ivSessionKeyHex}/${filenameHash}_${filePathUnixSafe}`
  }

  return `orgs/${orgId}/apps/${appId}/delta/${filenameHash}_${filePathUnixSafe}`
}

interface PartialEncryptionOptions {
  sessionKey: Buffer
  ivSessionKey: string
}

export async function uploadPartial(
  apikey: string,
  manifest: manifestType,
  path: string,
  appId: string,
  orgId: string,
  encryptionOptions: PartialEncryptionOptions | undefined,
  options: OptionsUpload,
): Promise<any[] | null> {
  const spinner = getUploadReporter().spinner()
  spinner.start('Preparing partial update with TUS protocol')
  const startTime = performance.now()
  const localConfig = await getLocalConfig()

  // Determine if user explicitly requested delta updates
  const userRequestedDelta = !!(options.partial || options.delta || options.partialOnly || options.deltaOnly)

  // Check the updater version and Brotli support
  const { version, supportsBrotliV2 } = await getUpdaterVersion(options)

  // Check for incompatible options with older updater versions
  if (!supportsBrotliV2) {
    throw new Error(`Your project is using an older version of @capgo/capacitor-updater (${version || 'unknown'}). To use Delta updates, please upgrade to version ${BROTLI_MIN_UPDATER_VERSION_V5} (v5), ${BROTLI_MIN_UPDATER_VERSION_V6} (v6) or ${BROTLI_MIN_UPDATER_VERSION_V7} (v7) or higher.`)
  }
  else {
    // Only newer versions can use Brotli with .br extension
    if (options.disableBrotli) {
      log.info('Brotli compression disabled by user request')
    }
    else {
      if (options.noBrotliPatterns) {
        log.info(`Files matching patterns (${options.noBrotliPatterns}) will be excluded from brotli compression`)
      }
    }
  }

  // Check if any files have spaces in their names
  const filesWithSpaces = manifest.filter(file => file.file.includes(' '))

  if (filesWithSpaces.length > 0) {
    throw new Error(`Files with spaces in their names (${filesWithSpaces.map(f => f.file).join(', ')}). Please rename the files.`)
  }

  if (manifest.length > MAX_MANIFEST_ENTRIES)
    throw new Error(deltaManifestTooLargeMessage(manifest.length))

  let uploadedFiles = 0
  const totalFiles = manifest.length
  let brFilesCount = 0

  try {
    spinner.message(`Uploading ${totalFiles} files using TUS protocol`)

    // Helper function to upload a single file
    const uploadFile = async (file: manifestType[number]) => {
      const finalFilePath = join(path, file.file)
      const filePathUnix = convertToUnixPath(file.file)

      let fileBuffer: Buffer
      let isBrotli = false

      // For versions >= 7.0.37, allow user options
      if (options.disableBrotli) {
        // User explicitly disabled Brotli, don't compress at all
        fileBuffer = await readBuffer(createReadStream(finalFilePath))
        isBrotli = false
      }
      else {
        // Normal case: use Brotli when appropriate
        const result = await shouldUseBrotli(finalFilePath, filePathUnix, options)
        fileBuffer = result.buffer
        isBrotli = result.useBrotli
      }

      let finalBuffer = fileBuffer
      if (encryptionOptions) {
        finalBuffer = encryptSource(fileBuffer, encryptionOptions.sessionKey, encryptionOptions.ivSessionKey)
      }

      // Determine the upload path (with or without .br extension)
      let uploadPathUnix = filePathUnix
      // Only add .br extension if file was actually compressed with brotli
      if (isBrotli) {
        uploadPathUnix = `${filePathUnix}.br`
        brFilesCount++
      }

      const filename = buildPartialUploadPath(orgId, appId, file.hash, uploadPathUnix, encryptionOptions)

      // Check if file already exists on server
      // Skip reuse when encryption is enabled because the session key changes per upload
      // and reusing a file encrypted with a different session key would cause decryption to fail
      if (!encryptionOptions && await fileExists(localConfig, filename)) {
        uploadedFiles++
        return Promise.resolve({
          file_name: uploadPathUnix,
          s3_path: filename,
          file_hash: file.hash,
        })
      }

      return new Promise((resolve, reject) => {
        spinner.message(`Prepare upload partial file: ${filePathUnix}`)
        // Get the MIME type for this file (based on original filename, not the R2 path)
        const filetype = getContentType(uploadPathUnix)
        const upload = new tus.Upload(finalBuffer as any, {
          endpoint: `${localConfig.hostFilesApi}/files/upload/attachments/`,
          chunkSize: options.tusChunkSize,
          retryDelays: [...TUS_UPLOAD_RETRY_DELAYS],
          removeFingerprintOnSuccess: true,
          metadata: {
            filename,
            filetype,
          },
headers: buildCliRequestHeaders({ Authorization: apikey }),
          onError: (error) => {
            const errorMessage = error.toString()

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
            spinner.message(`Uploading partial update: ${percentage}%`)
          },
          onSuccess() {
            uploadedFiles++
            resolve({
              file_name: uploadPathUnix,
              s3_path: filename,
              file_hash: file.hash,
            })
          },
        })

        upload.start()
      })
    }

    // Process files in batches of 1000 to avoid overwhelming the server
    const BATCH_SIZE = 500
    const results: any[] = []

    for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
      const batch = manifest.slice(i, i + BATCH_SIZE)
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1
      const totalBatches = Math.ceil(manifest.length / BATCH_SIZE)

      if (totalBatches > 1) {
        spinner.message(`Processing batch ${batchNumber}/${totalBatches} (${batch.length} files)`)
      }

      const batchResults = await Promise.all(batch.map(file => uploadFile(file)))
      results.push(...batchResults)
    }
    const endTime = performance.now()
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
    spinner.stop(`Partial update uploaded successfully 💪 in (${uploadTime} seconds)`)

    if (brFilesCount > 0) {
      log.info(`${brFilesCount} of ${totalFiles} files were compressed with brotli and use .br extension`)
    }

    await sendEvent(apikey, {
      channel: 'app',
      event: `App Partial TUS done${brFilesCount > 0 ? ' with .br extension' : ''}`,
      icon: '⏫',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
      },
      notify: false,
    })
    await sendEvent(apikey, {
      channel: 'performance',
      event: 'Partial upload performance',
      icon: '🚄',
      org_id: orgId,
      tracking_version: 2,
      tags: {
        'app-id': appId,
        'time': uploadTime,
      },
      notify: false,
    })
    return results
  }
  catch (error) {
    const endTime = performance.now()
    const uploadTime = ((endTime - startTime) / 1000).toFixed(2)
    spinner.error(`Failed to upload Partial bundle (after ${uploadTime} seconds)`)

    if (userRequestedDelta) {
      // User explicitly requested delta/partial updates, so we should fail
      log.error(`Error uploading partial update: ${error}`)
      log.error(`Delta/partial upload was explicitly requested but failed. Upload aborted.`)
      throw error
    }
    else {
      // Delta was auto-enabled, treat as non-critical
      log.info(`Error uploading partial update: ${error}, This is not a critical error, the bundle has been uploaded without the partial files`)
      return null
    }
  }
}
