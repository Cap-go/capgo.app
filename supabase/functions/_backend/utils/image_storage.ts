import type { Context } from 'hono'
import { cloudlog, cloudlogErr, serializeError } from './logging.ts'
import { initS3 } from './s3.ts'
import { supabaseAdmin } from './supabase.ts'
import { getEnv } from './utils.ts'

// Avatars, org logos and app icons live in R2 under this prefix of the main
// bucket. The object path after the prefix is the value stored in
// users.image_url, orgs.logo and apps.icon_url (e.g. `org/{orgId}/{appId}/icon`).
export const IMAGE_KEY_PREFIX = 'images/'
// Same lifetime the Supabase signed URLs had; also the S3 presign maximum.
export const IMAGE_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7

const IMAGE_TOKEN_VERSION = 'v1'
// Long enough to keep image URLs stable across a working session; the console
// fetches a new one before it runs out.
export const IMAGE_TOKEN_TTL_SECONDS = 60 * 60 * 12
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const encoder = new TextEncoder()

export interface ImageFolderEntry {
  /** Name relative to the listed folder (no slashes). */
  name: string
  isFolder: boolean
}

// Every image operation is sent by this runtime; presigned GET URLs are the
// exception and keep the client-facing endpoint.
function imageClient(c: Context) {
  return initS3(c, { serverSide: true })
}

function trimSlashes(value: string, { start = true, end = false } = {}) {
  let from = 0
  let to = value.length
  while (start && from < to && value[from] === '/')
    from++
  while (end && to > from && value[to - 1] === '/')
    to--
  return value.slice(from, to)
}

export function imageObjectKey(path: string) {
  return `${IMAGE_KEY_PREFIX}${trimSlashes(path)}`
}

function folderKey(prefix: string) {
  const trimmed = trimSlashes(prefix, { end: true })
  return trimmed ? `${IMAGE_KEY_PREFIX}${trimmed}/` : IMAGE_KEY_PREFIX
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { code?: unknown, status?: unknown, statusCode?: unknown }
  return candidate.statusCode === 404 || candidate.status === 404 || candidate.code === 'NoSuchKey'
}

export function imageExists(c: Context, path: string): Promise<boolean> {
  return imageClient(c).exists(imageObjectKey(path))
}

/**
 * Store an image object. Without `upsert`, an existing object is left untouched
 * and `conflict` is returned, matching the Supabase Storage 409 behaviour.
 */
export async function uploadImage(
  c: Context,
  path: string,
  data: Uint8Array,
  options: { contentType?: string, upsert?: boolean } = {},
): Promise<'ok' | 'conflict'> {
  const client = imageClient(c)
  const key = imageObjectKey(path)
  if (!options.upsert && await client.exists(key))
    return 'conflict'
  // Presigned PUT with an unsigned payload, like bundle uploads: the body and
  // its headers are not part of the signature, so proxies in front of the
  // bucket (local Kong) cannot invalidate it.
  const url = await client.getPresignedUrl('PUT', key, {
    expirySeconds: 300,
    parameters: { 'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD', 'x-id': 'PutObject' },
  })
  const response = await fetch(url, {
    method: 'PUT',
    body: data as Uint8Array<ArrayBuffer>,
    headers: {
      'Content-Type': options.contentType || 'application/octet-stream',
      'Cache-Control': 'private, max-age=0',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw Object.assign(new Error(`Image upload failed with status ${response.status}`), { statusCode: response.status, detail: detail.slice(0, 500) })
  }
  await response.body?.cancel()
  return 'ok'
}

/** Download an image object; null when it does not exist. */
export async function downloadImage(c: Context, path: string): Promise<Response | null> {
  try {
    return await imageClient(c).getObject(imageObjectKey(path))
  }
  catch (error) {
    if (isNotFound(error))
      return null
    throw error
  }
}

/** Delete image objects; a missing object is not an error. */
export async function removeImages(c: Context, paths: string[]) {
  const client = imageClient(c)
  await Promise.all(paths.map(path => client.deleteObject(imageObjectKey(path)).catch((error: unknown) => {
    if (!isNotFound(error))
      throw error
  })))
}

/** List one folder level, like Supabase Storage `list()`: files and sub-folders. */
export async function listImageFolder(c: Context, prefix: string, options: { limit?: number } = {}): Promise<ImageFolderEntry[]> {
  const base = folderKey(prefix)
  const entries: ImageFolderEntry[] = []
  for await (const entry of imageClient(c).listObjectsGrouped({ prefix: base, delimiter: '/', maxResults: options.limit })) {
    if (entry.type === 'CommonPrefix') {
      const name = entry.prefix.slice(base.length).replace(/\/$/, '')
      if (name)
        entries.push({ name, isFolder: true })
    }
    else {
      const name = entry.key.slice(base.length)
      if (name)
        entries.push({ name, isFolder: false })
    }
  }
  return entries
}

/**
 * Delete every image object under a folder, recursively. Returns how many were
 * removed. With a `deadline` (epoch ms) it stops starting deletes once that has
 * passed, leaving the rest of the folder for a later call.
 */
export async function removeImageFolder(c: Context, prefix: string, options: { deadline?: number } = {}) {
  // An empty or slash-only prefix would target every image object.
  if (!trimSlashes(prefix, { end: true }))
    throw new Error('removeImageFolder requires a non-empty folder')
  const client = imageClient(c)
  let deleted = 0
  for await (const object of client.listObjects({ prefix: folderKey(prefix) })) {
    if (options.deadline !== undefined && Date.now() >= options.deadline)
      break
    try {
      await client.deleteObject(object.key)
      deleted++
    }
    catch (error) {
      if (!isNotFound(error))
        throw error
    }
  }
  return deleted
}

/** Presigned R2 GET URL for an image object path. Callers must check ownership first. */
export function presignImageUrl(c: Context, path: string, expirySeconds = IMAGE_SIGNED_URL_TTL_SECONDS): Promise<string> {
  return initS3(c).getPresignedUrl('GET', imageObjectKey(path), {
    expirySeconds: Math.min(expirySeconds, IMAGE_SIGNED_URL_TTL_SECONDS),
  })
}

async function imageTokenKey(c: Context) {
  const secret = getEnv(c, 'S3_SECRET_ACCESS_KEY')
  if (!secret)
    return null
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`capgo-image-token:${IMAGE_TOKEN_VERSION}:${secret}`))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function imageTokenPayload(userId: string, expiresAt: number) {
  return encoder.encode(`${IMAGE_TOKEN_VERSION}\n${expiresAt}\n${userId}`)
}

function toBase64Url(bytes: ArrayBuffer) {
  return btoa(String.fromCodePoint(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromBase64Url(value: string) {
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'))
    return Uint8Array.from(binary, char => char.codePointAt(0) ?? 0)
  }
  catch {
    return null
  }
}

/**
 * Image token: `<userId>.<expiresAt>.<hmac>`. A JWT-like credential that can
 * only read images, so it may sit in `<img src>` URLs, which cannot send the
 * session bearer header. The read endpoint resolves the user from it and runs
 * the normal per-path permission check, so one token covers every image the
 * user may see and URLs stay stable (cacheable) for its lifetime.
 */
export async function createImageToken(c: Context, userId: string, expiresInSeconds = IMAGE_TOKEN_TTL_SECONDS) {
  const key = await imageTokenKey(c)
  if (!key || !UUID_REGEX.test(userId))
    return null
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(expiresInSeconds, IMAGE_TOKEN_TTL_SECONDS)
  const signature = await crypto.subtle.sign('HMAC', key, imageTokenPayload(userId, expiresAt))
  return { token: `${userId}.${expiresAt}.${toBase64Url(signature)}`, expiresAt }
}

/** The user an image token was issued to, or null when it is invalid or expired. */
export async function verifyImageToken(c: Context, token: string): Promise<string | null> {
  const [userId, expiresAtRaw, signatureRaw, ...rest] = token.split('.')
  if (rest.length > 0 || !userId || !UUID_REGEX.test(userId) || !expiresAtRaw || !/^\d{1,12}$/.test(expiresAtRaw) || !signatureRaw)
    return null
  const expiresAt = Number(expiresAtRaw)
  if (expiresAt < Math.floor(Date.now() / 1000))
    return null
  const signature = fromBase64Url(signatureRaw)
  const key = await imageTokenKey(c)
  if (!signature || !key)
    return null
  return await crypto.subtle.verify('HMAC', key, signature, imageTokenPayload(userId, expiresAt)) ? userId : null
}

/** Last-modified time of an image object, or null when it does not exist. */
export async function getImageLastModified(c: Context, path: string): Promise<Date | null> {
  try {
    return (await imageClient(c).statObject(imageObjectKey(path))).lastModified
  }
  catch (error) {
    if (isNotFound(error))
      return null
    throw error
  }
}

/**
 * CLI releases before 8.90.1 still upload icons straight to the Supabase
 * Storage `images` bucket. When a row is written with such a path, move that
 * legacy object into R2 and drop the Supabase copy, so every read, sign and
 * delete keeps going through R2 only. Returns whether a legacy object was moved.
 *
 * Only a Supabase copy newer than the R2 object is moved (`app set --icon`
 * re-uploads the same path). An older one is a leftover of the one-off
 * migration and is dropped, so it never overwrites a newer R2 upload.
 */
export async function importLegacySupabaseImage(c: Context, path: string): Promise<boolean> {
  const requestId = c.get('requestId')
  const storage = supabaseAdmin(c).storage.from('images')
  const slash = path.lastIndexOf('/')
  const folder = path.slice(0, slash)
  const name = path.slice(slash + 1)
  const { data: entries, error: listError } = await storage.list(folder, { search: name, limit: 100 })
  if (listError) {
    cloudlogErr({ requestId, message: 'Cannot look up legacy Supabase image', path, error: listError })
    return false
  }
  const legacy = entries?.find(entry => entry.id !== null && entry.name === name)
  if (!legacy)
    return false

  const legacyModifiedAt = Date.parse(legacy.updated_at ?? legacy.created_at ?? '')
  const r2ModifiedAt = await getImageLastModified(c, path)
  const legacyIsNewer = !r2ModifiedAt || (Number.isFinite(legacyModifiedAt) && legacyModifiedAt > r2ModifiedAt.getTime())

  if (legacyIsNewer) {
    const { data: blob, error } = await storage.download(path)
    if (error || !blob) {
      cloudlogErr({ requestId, message: 'Cannot download legacy Supabase image', path, error: error ? serializeError(error) : undefined })
      return false
    }
    await uploadImage(c, path, new Uint8Array(await blob.arrayBuffer()), { contentType: blob.type || undefined, upsert: true })
  }

  const { error: removeError } = await storage.remove([path])
  if (removeError)
    cloudlogErr({ requestId, message: 'Could not remove the legacy Supabase image', path, error: removeError })
  cloudlog({ requestId, message: legacyIsNewer ? 'Imported legacy Supabase image into R2' : 'Dropped stale legacy Supabase image older than R2', path })
  return legacyIsNewer
}
