import type { Context } from 'hono'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlog } from '../utils/logging.ts'
import { getDatabaseURL, getPgClient } from '../utils/pg.ts'

export const FILE_READ_TRACKING_QUERY_PARAMS = ['device_id'] as const
export const DELETED_FILE_CACHE_HEADER = 'x-capgo-file-deleted'
const DELETED_FILE_MARKER_ORIGIN = 'https://capgo-files-cache.internal'
const FILE_READ_CACHE_NAME = 'capgo-file-read-cache'
const FILE_READ_CACHE_ORIGINS = ['https://api.capgo.app'] as const
const FILE_READ_PATH_PREFIXES = [
  '/files/read/attachments/',
  '/private/files/read/attachments/',
  '/read/attachments/',
] as const

export function isVersionDeleted(row: { deleted?: boolean | null, deleted_at?: string | Date | null } | null | undefined): boolean {
  if (!row)
    return false
  return row.deleted === true || row.deleted_at != null
}

export function getAttachmentFileIdFromReadPath(pathname: string): string | null {
  for (const prefix of FILE_READ_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) {
      const fileId = pathname.slice(prefix.length)
      return fileId || null
    }
  }
  return null
}

export function buildFileReadCacheRequest(request: Request): Request {
  const cacheUrl = new URL(request.url)
  for (const queryParam of FILE_READ_TRACKING_QUERY_PARAMS) {
    cacheUrl.searchParams.delete(queryParam)
  }
  cacheUrl.searchParams.set('range', request.headers.get('range') || '')
  cacheUrl.searchParams.sort()
  return new Request(cacheUrl, request)
}

export function buildDeletedFileMarkerRequest(fileId: string): Request {
  return new Request(`${DELETED_FILE_MARKER_ORIGIN}/deleted/${encodeURIComponent(fileId)}`)
}

function normalizeSearch(url: URL, ignoredParams: readonly string[] = []): string {
  const searchParams = new URLSearchParams(url.search)
  for (const param of ignoredParams) {
    searchParams.delete(param)
  }
  searchParams.sort()
  const search = searchParams.toString()
  return search ? `?${search}` : ''
}

export function buildWorkersFileCacheKey(pathname: string, search = ''): string {
  const url = new URL(`https://capgo-files-cache.internal${pathname}${search}`)
  return `/files-cache${pathname}${normalizeSearch(url, FILE_READ_TRACKING_QUERY_PARAMS)}`
}

type CacheLike = Cache & {
  default?: Cache
  open?: (cacheName: string) => Promise<Cache>
}

let fileReadCachePromise: Promise<Cache | null> | null = null

async function resolveFileReadCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined')
    return null

  const cacheStorage = caches as unknown as CacheLike
  if (getRuntimeKey() === 'workerd' && cacheStorage.default)
    return cacheStorage.default

  if (typeof cacheStorage.open === 'function') {
    try {
      return await cacheStorage.open(FILE_READ_CACHE_NAME)
    }
    catch {
      return null
    }
  }

  return null
}

export async function getFileReadCache(): Promise<Cache | null> {
  fileReadCachePromise ??= resolveFileReadCache()
  return fileReadCachePromise
}

export async function hasDeletedFileMarker(fileId: string): Promise<boolean> {
  const cache = await getFileReadCache()
  if (!cache?.match)
    return false

  try {
    const cached = await cache.match(buildDeletedFileMarkerRequest(fileId))
    return cached != null
  }
  catch {
    return false
  }
}

export async function markFileDeletedInCache(fileId: string): Promise<void> {
  const cache = await getFileReadCache()
  if (!cache?.put)
    return

  await cache.put(buildDeletedFileMarkerRequest(fileId), new Response('deleted', {
    status: 404,
    headers: {
      'Cache-Control': 'public, max-age=31536000',
      [DELETED_FILE_CACHE_HEADER]: '1',
    },
  }))
}

let sharedDeletedLookupPool: ReturnType<typeof getPgClient> | null = null
let sharedDeletedLookupPoolUrl: string | null = null

function getDeletedLookupPgClient(c: Context): ReturnType<typeof getPgClient> {
  const dbUrl = getDatabaseURL(c, false)
  if (!sharedDeletedLookupPool || sharedDeletedLookupPoolUrl !== dbUrl) {
    sharedDeletedLookupPool = getPgClient(c, false)
    sharedDeletedLookupPoolUrl = dbUrl
  }
  return sharedDeletedLookupPool
}

function buildFileReadCacheRequestsForPath(fileId: string, checksum?: string | null): Request[] {
  const identityParamSets: Array<Record<string, string>> = [{}]
  if (checksum)
    identityParamSets.push({ key: checksum })

  return FILE_READ_CACHE_ORIGINS.flatMap(origin =>
    FILE_READ_PATH_PREFIXES.flatMap((prefix) => {
      return identityParamSets.map((identityParams) => {
        const url = new URL(`${prefix}${fileId}`, origin)
        for (const [key, value] of Object.entries(identityParams))
          url.searchParams.set(key, value)
        url.searchParams.set('range', '')
        url.searchParams.sort()
        return new Request(url)
      })
    }),
  )
}

function buildWorkersFileCacheRequests(fileId: string, checksum?: string | null): Request[] {
  const searchVariants = ['']
  if (checksum)
    searchVariants.push(`?key=${encodeURIComponent(checksum)}`)

  return FILE_READ_PATH_PREFIXES
    .filter(prefix => prefix.startsWith('/files/') || prefix.startsWith('/private/'))
    .flatMap(prefix =>
      searchVariants.map(search =>
        new Request(`${DELETED_FILE_MARKER_ORIGIN}${buildWorkersFileCacheKey(`${prefix}${fileId}`, search)}`),
      ),
    )
}

// Checksum is required so key=checksum cache variants are purged alongside path-only entries.
export async function purgeFileReadCache(fileId: string, checksum?: string | null): Promise<void> {
  await markFileDeletedInCache(fileId)

  const cache = await getFileReadCache()
  if (!cache || typeof cache.delete !== 'function')
    return

  const requests = [
    ...buildFileReadCacheRequestsForPath(fileId, checksum),
    ...buildWorkersFileCacheRequests(fileId, checksum),
  ]
  await Promise.all(requests.map(request => cache.delete(request).catch(() => false)))
}

export async function isAttachmentVersionDeleted(c: Context, fileId: string): Promise<boolean> {
  if (await hasDeletedFileMarker(fileId))
    return true

  // app_versions.r2_path only tracks bundle zip objects, not arbitrary attachment uploads.
  if (!fileId.endsWith('.zip'))
    return false

  try {
    const pgClient = getDeletedLookupPgClient(c)
    const result = await pgClient.query<{ deleted: boolean | null, deleted_at: string | null }>(
      `
        SELECT deleted, deleted_at
        FROM public.app_versions
        WHERE r2_path = $1
          AND (COALESCE(deleted, false) = true OR deleted_at IS NOT NULL)
        LIMIT 1
      `,
      [fileId],
    )
    return result.rows.length > 0
  }
  catch (error) {
    cloudlog({
      requestId: c.get('requestId'),
      message: 'isAttachmentVersionDeleted lookup failed, failing closed',
      fileId,
      error: error instanceof Error ? error.message : String(error),
    })
    return true
  }
}

export const fileReadCacheTestUtils = {
  buildFileReadCacheRequest,
  buildDeletedFileMarkerRequest,
  buildWorkersFileCacheKey,
  getAttachmentFileIdFromReadPath,
  isVersionDeleted,
}
