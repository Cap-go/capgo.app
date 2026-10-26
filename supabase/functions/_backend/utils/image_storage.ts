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

const READ_TOKEN_VERSION = 'v1'
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

export function imageObjectKey(path: string) {
  return `${IMAGE_KEY_PREFIX}${path.replace(/^\/+/, '')}`
}

function folderKey(prefix: string) {
  const trimmed = prefix.replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed ? `${IMAGE_KEY_PREFIX}${trimmed}/` : IMAGE_KEY_PREFIX
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { code?: unknown, status?: unknown, statusCode?: unknown }
  return candidate.statusCode === 404 || candidate.status === 404 || candidate.code === 'NoSuchKey'
}

export async function imageExists(c: Context, path: string) {
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
  for (const path of paths) {
    try {
      await client.deleteObject(imageObjectKey(path))
    }
    catch (error) {
      if (!isNotFound(error))
        throw error
    }
  }
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

/** Delete every image object under a folder, recursively. Returns how many were removed. */
export async function removeImageFolder(c: Context, prefix: string) {
  const client = imageClient(c)
  let deleted = 0
  for await (const object of client.listObjects({ prefix: folderKey(prefix) })) {
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
export async function presignImageUrl(c: Context, path: string, expirySeconds = IMAGE_SIGNED_URL_TTL_SECONDS) {
  return initS3(c).getPresignedUrl('GET', imageObjectKey(path), {
    expirySeconds: Math.min(expirySeconds, IMAGE_SIGNED_URL_TTL_SECONDS),
  })
}

async function readTokenKey(c: Context) {
  const secret = getEnv(c, 'S3_SECRET_ACCESS_KEY')
  if (!secret)
    return null
  const material = await crypto.subtle.digest('SHA-256', encoder.encode(`capgo-image-read:${READ_TOKEN_VERSION}:${secret}`))
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function readTokenPayload(path: string, expiresAt: number) {
  return encoder.encode(`${READ_TOKEN_VERSION}\n${expiresAt}\n${path}`)
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
 * Capability for the console image relay: `<expiresAt>.<hmac>` bound to one
 * object path. Image elements cannot send bearer headers, so the token is the
 * proof that an authorized caller asked for this path.
 */
export async function createImageReadToken(c: Context, path: string, expiresInSeconds: number) {
  const key = await readTokenKey(c)
  if (!key)
    return null
  const expiresAt = Math.floor(Date.now() / 1000) + Math.min(expiresInSeconds, IMAGE_SIGNED_URL_TTL_SECONDS)
  const signature = await crypto.subtle.sign('HMAC', key, readTokenPayload(path, expiresAt))
  return `${expiresAt}.${toBase64Url(signature)}`
}

export async function verifyImageReadToken(c: Context, path: string, token: string) {
  const [expiresAtRaw, signatureRaw, ...rest] = token.split('.')
  if (rest.length > 0 || !expiresAtRaw || !signatureRaw || !/^\d{1,12}$/.test(expiresAtRaw))
    return false
  const expiresAt = Number(expiresAtRaw)
  if (expiresAt < Math.floor(Date.now() / 1000))
    return false
  const signature = fromBase64Url(signatureRaw)
  const key = await readTokenKey(c)
  if (!signature || !key)
    return false
  return crypto.subtle.verify('HMAC', key, signature, readTokenPayload(path, expiresAt))
}

/**
 * CLI releases before 8.90.1 still upload icons straight to the Supabase
 * Storage `images` bucket. When a row is written with such a path, move that
 * legacy object into R2 (overwriting: `app set --icon` re-uploads the same
 * path) and drop the Supabase copy, so every read, sign and delete keeps going
 * through R2 only. Returns whether a legacy object was moved.
 */
export async function importLegacySupabaseImage(c: Context, path: string): Promise<boolean> {
  const requestId = c.get('requestId')
  const storage = supabaseAdmin(c).storage.from('images')
  const { data: blob, error } = await storage.download(path)
  if (error || !blob) {
    cloudlog({ requestId, message: 'No legacy Supabase image to import', path, error: error ? serializeError(error) : undefined })
    return false
  }

  await uploadImage(c, path, new Uint8Array(await blob.arrayBuffer()), { contentType: blob.type || undefined, upsert: true })
  const { error: removeError } = await storage.remove([path])
  if (removeError)
    cloudlogErr({ requestId, message: 'Imported legacy image but could not remove the Supabase copy', path, error: removeError })
  cloudlog({ requestId, message: 'Imported legacy Supabase image into R2', path })
  return true
}
