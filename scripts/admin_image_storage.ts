import { S3Client } from '@bradenmacdonald/s3-lite-client'

// Admin-script access to avatars, org logos and app icons. They live in R2
// under the `images/` prefix of the main bucket (see
// supabase/functions/_backend/utils/image_storage.ts); Supabase Storage is no
// longer used for images.
export const IMAGE_KEY_PREFIX = 'images/'

export interface ImageStore {
  bucket: string
  exists: (path: string) => Promise<boolean>
  lastModified: (path: string) => Promise<Date | null>
  download: (path: string) => Promise<Blob | null>
  upload: (path: string, data: Blob | Uint8Array | ArrayBuffer, options?: { contentType?: string, upsert?: boolean }) => Promise<'ok' | 'conflict'>
  copy: (fromPath: string, toPath: string) => Promise<void>
  remove: (paths: string[]) => Promise<void>
}

function requireEnv(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  if (!value)
    throw new Error(`Missing ${key}`)
  return value
}

function isNotFound(error: unknown) {
  if (!error || typeof error !== 'object')
    return false
  const candidate = error as { code?: unknown, status?: unknown, statusCode?: unknown }
  return candidate.statusCode === 404 || candidate.status === 404 || candidate.code === 'NoSuchKey'
}

export function imageObjectKey(path: string) {
  return `${IMAGE_KEY_PREFIX}${path.replace(/^\/+/, '')}`
}

export function createImageStore(env: Record<string, string | undefined>): ImageStore {
  const rawEndpoint = requireEnv(env, 'S3_ENDPOINT')
  const protocol = env.S3_SSL === 'false' ? 'http' : 'https'
  const bucket = requireEnv(env, 'S3_BUCKET')
  const client = new S3Client({
    endPoint: rawEndpoint.includes('://') ? rawEndpoint : `${protocol}://${rawEndpoint}`,
    accessKey: requireEnv(env, 'S3_ACCESS_KEY_ID'),
    secretKey: requireEnv(env, 'S3_SECRET_ACCESS_KEY'),
    region: env.S3_REGION?.trim() || 'us-east-1',
    pathStyle: true,
    bucket,
  })

  async function upload(path: string, data: Blob | Uint8Array | ArrayBuffer, options: { contentType?: string, upsert?: boolean } = {}) {
    const key = imageObjectKey(path)
    if (!options.upsert && await client.exists(key))
      return 'conflict' as const
    let bytes: Uint8Array
    if (data instanceof Uint8Array)
      bytes = data
    else if (data instanceof ArrayBuffer)
      bytes = new Uint8Array(data)
    else
      bytes = new Uint8Array(await data.arrayBuffer())
    const contentType = options.contentType || (data instanceof Blob ? data.type : '') || 'application/octet-stream'
    await client.putObject(key, bytes, {
      size: bytes.byteLength,
      metadata: { 'Content-Type': contentType, 'Cache-Control': 'private, max-age=0' },
    })
    return 'ok' as const
  }

  return {
    bucket,
    exists: path => client.exists(imageObjectKey(path)),
    async lastModified(path) {
      try {
        return (await client.statObject(imageObjectKey(path))).lastModified
      }
      catch (error) {
        if (isNotFound(error))
          return null
        throw error
      }
    },
    async download(path) {
      try {
        const response = await client.getObject(imageObjectKey(path))
        return await response.blob()
      }
      catch (error) {
        if (isNotFound(error))
          return null
        throw error
      }
    },
    upload,
    async copy(fromPath, toPath) {
      await client.copyObject({ sourceKey: imageObjectKey(fromPath) }, imageObjectKey(toPath))
    },
    async remove(paths) {
      for (const path of paths) {
        try {
          await client.deleteObject(imageObjectKey(path))
        }
        catch (error) {
          if (!isNotFound(error))
            throw error
        }
      }
    },
  }
}
