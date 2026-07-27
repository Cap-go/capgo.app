import type { Context } from 'hono'
import type { ParsedPreviewSubdomain } from '../../shared/preview-subdomain.ts'
import type { MiddlewareKeyVariables } from '../utils/hono.ts'
import { Buffer } from 'node:buffer'
import { brotliDecompressSync } from 'node:zlib'
import { getRuntimeKey } from 'hono/adapter'
import { buildChannelPreviewSubdomain, buildPreviewSubdomain, parsePreviewHostname } from '../../shared/preview-subdomain.ts'
import { CacheHelper } from '../utils/cache.ts'
import { getBundleUrl } from '../utils/downloadUrl.ts'
import { simpleError } from '../utils/hono.ts'
import { cloudlog } from '../utils/logging.ts'
import { supabaseAdmin } from '../utils/supabase.ts'
import { backgroundTask, getEnv, isValidAppId } from '../utils/utils.ts'
import { DEFAULT_RETRY_PARAMS, RetryBucket } from './retry.ts'
// Cache settings
const PREVIEW_AUTH_CACHE_PATH = '/.preview-auth'
const PREVIEW_AUTH_CACHE_TTL_SECONDS = 60
const PREVIEW_PAYLOAD_FILE_PATH = '.capgo/preview.json'

interface PreviewAuthCache {
  actualAppId: string
  allowPreview: boolean
}

interface BundleInfoCache {
  hasManifest: boolean
  isEncrypted: boolean
}

export interface PreviewDownloadBundle {
  checksum: string | null
  external_url: string | null
  id: number
  manifest_count: number | null
  name: string
  r2_path: string | null
  session_key: string | null
}

export interface PreviewDownloadPayload {
  appId: string
  checksum?: string
  sessionKey?: string
  url: string
  version: string
}

// Check if request is from a preview subdomain (*.preview[.env].capgo.app)
export function isPreviewSubdomain(hostname: string): boolean {
  return /^[^.]+\.preview(?:\.[^.]+)?\.(?:capgo\.app|usecapgo\.com)$/.test(hostname)
}

// Cache helpers for app preview authorization
function buildPreviewAuthRequest(c: Context, appId: string) {
  const helper = new CacheHelper(c)
  if (!helper.available)
    return null
  return {
    helper,
    request: helper.buildRequest(PREVIEW_AUTH_CACHE_PATH, { app_id: appId }),
  }
}

async function getPreviewAuth(c: Context, appId: string): Promise<PreviewAuthCache | null> {
  const cacheEntry = buildPreviewAuthRequest(c, appId)
  if (!cacheEntry)
    return null
  return cacheEntry.helper.matchJson<PreviewAuthCache>(cacheEntry.request)
}

function setPreviewAuth(c: Context, appId: string, data: PreviewAuthCache) {
  return backgroundTask(c, async () => {
    const cacheEntry = buildPreviewAuthRequest(c, appId)
    if (!cacheEntry)
      return
    await cacheEntry.helper.putJson(cacheEntry.request, data, PREVIEW_AUTH_CACHE_TTL_SECONDS)
  })
}

// Cache helpers for bundle info
const BUNDLE_INFO_CACHE_PATH = '/.preview-bundle'

function buildBundleInfoRequest(c: Context, versionId: number) {
  const helper = new CacheHelper(c)
  if (!helper.available)
    return null
  return {
    helper,
    request: helper.buildRequest(BUNDLE_INFO_CACHE_PATH, { version_id: String(versionId) }),
  }
}

async function getBundleInfo(c: Context, versionId: number): Promise<BundleInfoCache | null> {
  const cacheEntry = buildBundleInfoRequest(c, versionId)
  if (!cacheEntry)
    return null
  return cacheEntry.helper.matchJson<BundleInfoCache>(cacheEntry.request)
}

function setBundleInfo(c: Context, versionId: number, data: BundleInfoCache) {
  return backgroundTask(c, async () => {
    const cacheEntry = buildBundleInfoRequest(c, versionId)
    if (!cacheEntry)
      return
    await cacheEntry.helper.putJson(cacheEntry.request, data, PREVIEW_AUTH_CACHE_TTL_SECONDS)
  })
}

// MIME type mapping for common file extensions
const MIME_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  mjs: 'application/javascript',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  eot: 'application/vnd.ms-fontobject',
  otf: 'font/otf',
  map: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
}

const BUNDLE_PREVIEW_CACHE_CONTROL = 'public, max-age=31536000, immutable'
const CHANNEL_PREVIEW_CACHE_CONTROL = 'no-store, no-cache, must-revalidate, max-age=0'

function getContentType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  return MIME_TYPES[ext] || 'application/octet-stream'
}

export function buildPreviewResponseHeaders(contentType: string, options: { disableCache?: boolean, httpEtag?: string } = {}): Headers {
  const headers = new Headers()
  headers.set('Content-Type', contentType)
  headers.set('X-Content-Type-Options', 'nosniff')

  if (options.disableCache) {
    headers.set('Cache-Control', CHANNEL_PREVIEW_CACHE_CONTROL)
    headers.set('Pragma', 'no-cache')
    headers.set('Expires', '0')
    return headers
  }

  if (options.httpEtag)
    headers.set('etag', options.httpEtag)
  headers.set('Cache-Control', BUNDLE_PREVIEW_CACHE_CONTROL)
  return headers
}

function buildPreviewPayloadResponseHeaders(): Headers {
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Cache-Control', CHANNEL_PREVIEW_CACHE_CONTROL)
  headers.set('Pragma', 'no-cache')
  headers.set('Expires', '0')
  headers.set('Access-Control-Allow-Origin', '*')
  return headers
}

export async function buildPreviewDownloadPayload(c: Context, appId: string, bundle: PreviewDownloadBundle): Promise<PreviewDownloadPayload> {
  // Capgo Preview cannot decrypt customer-encrypted zips. Never return a download
  // payload for encrypted bundles or clients will fail later with unzip errors.
  if (bundle.session_key)
    throw simpleError('bundle_encrypted', 'Encrypted bundles cannot be previewed. Upload an unencrypted bundle to use Capgo preview.')

  const downloadUrl = bundle.external_url || rewritePreviewDownloadUrl(c, await getBundleUrl(c, bundle.r2_path, 'preview', bundle.checksum ?? String(bundle.id)))
  if (!downloadUrl)
    throw simpleError('bundle_download_unavailable', 'Bundle download URL is not available', { versionId: bundle.id })

  return {
    appId,
    checksum: bundle.checksum ?? undefined,
    // Unencrypted bundles have a null session_key; keep the field for payload shape stability.
    sessionKey: bundle.session_key ?? undefined,
    url: downloadUrl,
    version: bundle.name || `preview-${bundle.id}`,
  }
}

function publicApiOriginForPreview(c: Context) {
  const configuredPublicUrl = getEnv(c, 'PUBLIC_URL')
  if (configuredPublicUrl)
    return new URL(configuredPublicUrl).origin

  const requestUrl = new URL(c.req.url)
  const apiHostname = requestUrl.hostname.replace(/^[^.]+\.preview(\.[^.]+)?\./, 'api$1.')
  return `${requestUrl.protocol}//${apiHostname}`
}

function rewritePreviewDownloadUrl(c: Context, downloadUrl: string | null) {
  if (!downloadUrl)
    return null

  const requestUrl = new URL(c.req.url)
  if (!isPreviewSubdomain(requestUrl.hostname))
    return downloadUrl

  const parsedDownloadUrl = new URL(downloadUrl)
  if (parsedDownloadUrl.origin !== requestUrl.origin || !parsedDownloadUrl.pathname.startsWith('/files/read/attachments/'))
    return downloadUrl

  const publicApiOrigin = new URL(publicApiOriginForPreview(c))
  parsedDownloadUrl.protocol = publicApiOrigin.protocol
  parsedDownloadUrl.host = publicApiOrigin.host
  return parsedDownloadUrl.toString()
}

function parsePreviewSubdomain(hostname: string): ParsedPreviewSubdomain | null {
  const parsed = parsePreviewHostname(hostname)
  if (!parsed || !isValidAppId(parsed.appId))
    return null

  return parsed
}

async function getChannelPreviewVersionId(c: Context<MiddlewareKeyVariables>, appId: string, channelId: number): Promise<number> {
  const supabase = supabaseAdmin(c)
  const { data: channel, error } = await supabase
    .from('channels')
    .select('version')
    .eq('app_id', appId)
    .eq('id', channelId)
    .single()

  if (error || !channel) {
    throw simpleError('channel_not_found', 'Channel not found', { channelId })
  }

  const versionId = channel.version
  if (!Number.isSafeInteger(versionId) || versionId === null || versionId <= 0) {
    throw simpleError('bundle_not_found', 'Bundle not found', { channelId })
  }

  return versionId
}

// Export the handler directly for use in the main app
// This preserves the context (requestId, env bindings, etc.) from the parent app
export async function handlePreviewRequest(c: Context<MiddlewareKeyVariables>): Promise<Response> {
  const hostname = c.req.header('host') || ''
  const parsed = parsePreviewSubdomain(hostname)

  if (!parsed) {
    cloudlog({ requestId: c.get('requestId'), message: 'invalid preview subdomain', hostname })
    throw simpleError('invalid_subdomain', 'Invalid preview subdomain format. Expected: {version_id}-{preview_app_id}.preview.capgo.app or c{channel_id}-{preview_app_id}.preview.capgo.app')
  }

  const { appId } = parsed
  const isChannelPreview = 'channelId' in parsed

  // Get the file path from the request path - default to index.html
  let filePath = c.req.path.slice(1) || 'index.html' // Remove leading slash
  filePath = decodeURIComponent(filePath)
  // Remove query string if present
  if (filePath.includes('?'))
    filePath = filePath.split('?')[0]

  cloudlog({
    requestId: c.get('requestId'),
    message: 'preview subdomain request',
    hostname,
    appId,
    channelId: isChannelPreview ? parsed.channelId : undefined,
    versionId: 'versionId' in parsed ? parsed.versionId : undefined,
    filePath,
  })

  // Check cache for app preview authorization first
  let actualAppId: string
  const cachedAuth = await getPreviewAuth(c, appId)

  if (cachedAuth) {
    if (!cachedAuth.allowPreview) {
      throw simpleError('preview_disabled', 'Preview is disabled for this app')
    }
    actualAppId = cachedAuth.actualAppId
  }
  else {
    // Use admin client - preview is public when allow_preview is enabled
    const supabase = supabaseAdmin(c)

    // Get app settings to check if preview is enabled.
    // Try exact match first (prevents wildcard collisions), then fallback to
    // case-insensitive match for preview URLs that were lowercased.
    const exactLookup = await supabase
      .from('apps')
      .select('app_id, allow_preview')
      .eq('app_id', appId)
      .maybeSingle()

    let appData = exactLookup.data
    let appError = exactLookup.error

    if (!appData && !appError) {
      const escapedAppId = appId
        .toLowerCase()
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')

      const fallbackLookup = await supabase
        .from('apps')
        .select('app_id, allow_preview')
        .ilike('app_id', escapedAppId)
        .limit(1)
        .maybeSingle()

      appData = fallbackLookup.data
      appError = fallbackLookup.error
    }

    if (appError || !appData) {
      throw simpleError('app_not_found', 'App not found', { appId })
    }

    // Cache the app auth result
    setPreviewAuth(c, appId, {
      actualAppId: appData.app_id,
      allowPreview: appData.allow_preview ?? false,
    })

    if (!appData.allow_preview) {
      throw simpleError('preview_disabled', 'Preview is disabled for this app')
    }

    actualAppId = appData.app_id
  }

  const previewVersionId = isChannelPreview
    ? await getChannelPreviewVersionId(c, actualAppId, parsed.channelId)
    : parsed.versionId

  const isPayloadRequest = filePath === PREVIEW_PAYLOAD_FILE_PATH

  // Check cache for bundle info
  let bundleInfo = await getBundleInfo(c, previewVersionId)
  let payloadBundle: PreviewDownloadBundle | null = null

  if (isPayloadRequest || !bundleInfo) {
    const supabase = supabaseAdmin(c)

    const bundleLookup = isPayloadRequest
      ? await supabase
          .from('app_versions')
          .select('id,name,checksum,session_key,manifest_count,r2_path,external_url')
          .eq('app_id', actualAppId)
          .eq('id', previewVersionId)
          .single()
      : await supabase
          .from('app_versions')
          .select('id,session_key,manifest_count')
          .eq('app_id', actualAppId)
          .eq('id', previewVersionId)
          .single()

    const { data: bundle, error: bundleError } = bundleLookup

    if (bundleError || !bundle) {
      throw simpleError('bundle_not_found', 'Bundle not found', { versionId: previewVersionId })
    }

    if (isPayloadRequest)
      payloadBundle = bundle as unknown as PreviewDownloadBundle

    bundleInfo = {
      hasManifest: (bundle.manifest_count ?? 0) > 0,
      isEncrypted: !!bundle.session_key,
    }

    // Cache the bundle info
    setBundleInfo(c, previewVersionId, bundleInfo)
  }

  // Capgo Preview cannot decrypt customer-encrypted bundles: the decryption
  // private material lives only in the customer's app, not in Capgo's preview
  // client. Reject early for both payload and file preview so QR/native flow
  // does not download an encrypted zip and fail with a cryptic unzip error.
  if (bundleInfo.isEncrypted) {
    throw simpleError('bundle_encrypted', 'Encrypted bundles cannot be previewed. Upload an unencrypted bundle to use Capgo preview.')
  }

  if (isPayloadRequest) {
    if (!payloadBundle)
      throw simpleError('bundle_not_found', 'Bundle not found', { versionId: previewVersionId })

    const payload = await buildPreviewDownloadPayload(c, actualAppId, payloadBundle)
    cloudlog({
      requestId: c.get('requestId'),
      message: 'serving preview payload',
      appId: actualAppId,
      hasExternalUrl: !!payloadBundle.external_url,
      version: payload.version,
      versionId: previewVersionId,
    })

    return new Response(JSON.stringify(payload), {
      headers: buildPreviewPayloadResponseHeaders(),
    })
  }

  // Check if bundle has manifest
  if (!bundleInfo.hasManifest) {
    throw simpleError('no_manifest', 'Bundle has no manifest and cannot be previewed')
  }

  // Preview only works on Cloudflare Workers where the R2 bucket is available.
  if (getRuntimeKey() !== 'workerd') {
    cloudlog({ requestId: c.get('requestId'), message: 'preview not supported on Supabase Edge Functions' })
    throw simpleError('preview_not_supported', 'Preview is not supported on Supabase Edge Functions. This feature requires Cloudflare Workers with R2 bucket access.')
  }

  const bucket = c.env.ATTACHMENT_BUCKET
  if (!bucket) {
    cloudlog({ requestId: c.get('requestId'), message: 'preview bucket is null' })
    throw simpleError('bucket_not_configured', 'Storage bucket not configured')
  }

  // Look up file in manifest using a single query with OR conditions for all possible paths
  // This handles deep paths like /folder1/folder2/folder3/.../file.js
  // Also check for .br (brotli) compressed variants since bundles may store compressed files
  const supabase = supabaseAdmin(c)
  const basePaths = [
    filePath,
    `www/${filePath}`,
    `public/${filePath}`,
    `dist/${filePath}`,
  ]
  // Add .br variants for all paths (brotli compressed files)
  const possiblePaths = [
    ...basePaths,
    ...basePaths.map(p => `${p}.br`),
  ]

  const { data: manifestEntries, error: manifestError } = await supabase
    .from('manifest')
    .select('s3_path, file_name')
    .eq('app_version_id', previewVersionId)
    .in('file_name', possiblePaths)
    .limit(1)

  if (manifestError || !manifestEntries || manifestEntries.length === 0) {
    cloudlog({ requestId: c.get('requestId'), message: 'file not found in manifest', filePath, versionId: previewVersionId, possiblePaths })
    throw simpleError('file_not_found', 'File not found in bundle', { filePath })
  }

  const manifestEntry = manifestEntries[0]
  const isBrotli = manifestEntry.file_name.endsWith('.br')
  // For MIME type detection, use the original filename without .br extension
  const actualFileName = isBrotli ? manifestEntry.file_name.slice(0, -3) : manifestEntry.file_name

  if (manifestEntry.file_name !== filePath) {
    cloudlog({ requestId: c.get('requestId'), message: 'found file with prefix', originalPath: filePath, foundPath: manifestEntry.file_name, isBrotli })
  }

  try {
    const object = await new RetryBucket(bucket, DEFAULT_RETRY_PARAMS).get(manifestEntry.s3_path)
    if (!object) {
      cloudlog({ requestId: c.get('requestId'), message: 'file not found in R2', s3_path: manifestEntry.s3_path })
      throw simpleError('file_not_found', 'File not found in storage', { filePath })
    }

    // Use our own MIME type detection - R2 rewrites text/html to text/plain without custom domains
    const contentType = getContentType(actualFileName)
    const headers = buildPreviewResponseHeaders(contentType, {
      disableCache: isChannelPreview,
      httpEtag: object.httpEtag,
    })

    cloudlog({
      requestId: c.get('requestId'),
      message: 'serving preview file from R2 (subdomain)',
      filePath: manifestEntry.file_name,
      contentType,
      isBrotli,
      cacheMode: isChannelPreview ? 'no-store' : 'immutable',
    })

    // If the file is brotli compressed, decompress it before serving
    // CLI compresses with node:zlib createBrotliCompress(), we decompress with brotliDecompressSync
    // Cloudflare Workers strip Content-Encoding: br header so we must decompress server-side
    if (isBrotli && object.body) {
      const compressedData = await object.arrayBuffer()
      const decompressed = brotliDecompressSync(Buffer.from(compressedData))
      return new Response(decompressed, { headers })
    }

    return new Response(object.body, { headers })
  }
  catch (error) {
    cloudlog({ requestId: c.get('requestId'), message: 'failed to serve preview file', error, s3_path: manifestEntry.s3_path })
    throw simpleError('preview_failed', 'Failed to serve preview file')
  }
}

// Export helper for generating preview URLs
export function generatePreviewUrl(appId: string, versionId: number, env: 'prod' | 'preprod' | 'dev' = 'prod'): string | null {
  const envPrefix = env === 'prod' ? '' : `.${env}`
  try {
    return `https://${buildPreviewSubdomain(appId, versionId)}.preview${envPrefix}.capgo.app`
  }
  catch {
    return null
  }
}

export function generateChannelPreviewUrl(appId: string, channelId: number, env: 'prod' | 'preprod' | 'dev' = 'prod'): string | null {
  const envPrefix = env === 'prod' ? '' : `.${env}`
  try {
    return `https://${buildChannelPreviewSubdomain(appId, channelId)}.preview${envPrefix}.capgo.app`
  }
  catch {
    return null
  }
}
