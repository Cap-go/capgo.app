import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()
const closeClientMock = vi.fn()
const getPgClientMock = vi.fn(() => ({ query: queryMock }))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'workerd',
  }
})

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: () => Promise.resolve(),
  sendDiscordAlert: () => Promise.resolve(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getAppOwnerPostgres: vi.fn(),
  getDatabaseURL: vi.fn(() => 'postgres://test'),
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/files/retry.ts', () => ({
  DEFAULT_RETRY_PARAMS: {},
  RetryBucket: class RetryBucketMock {
    head() {
      return Promise.resolve(null)
    }

    get() {
      return Promise.resolve(null)
    }
  },
}))

const originalCaches = globalThis.caches

function createCache(entries: Map<string, Response> = new Map()) {
  return {
    match: async (request: Request) => {
      return entries.get(new URL(request.url).pathname) ?? entries.get(request.url) ?? null
    },
    put: async (request: Request, response: Response) => {
      entries.set(new URL(request.url).pathname, response)
      entries.set(request.url, response)
    },
    delete: async (request: Request) => {
      entries.delete(new URL(request.url).pathname)
      entries.delete(request.url)
      return true
    },
    entries,
  }
}

async function createFilesApp() {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
  const { version } = await import('../supabase/functions/_backend/utils/version.ts')

  const appGlobal = createHono('files', version)
  appGlobal.route('/', files)
  createAllCatch(appGlobal, 'files')
  return appGlobal
}

describe('deleted bundle cache', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    queryMock.mockResolvedValue({ rows: [] })
  })

  afterEach(() => {
    globalThis.caches = originalCaches
  })

  it('does not serve or restore a cached file when the version is deleted', async () => {
    queryMock.mockResolvedValue({
      rows: [{ deleted: true, deleted_at: '2026-08-16T00:00:00Z' }],
    })

    const cache = createCache(new Map([
      ['/read/attachments/orgs/test-org/apps/test-app/bundle.zip', new Response('cached deleted bytes', {
        headers: { 'content-type': 'application/zip' },
      })],
    ]))
    globalThis.caches = { default: cache } as any

    const bucketPut = vi.fn()
    const appGlobal = await createFilesApp()
    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/bundle.zip'),
      { ATTACHMENT_BUCKET: { put: bucketPut, head: vi.fn(), get: vi.fn() } },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'not_found' })
    expect(bucketPut).not.toHaveBeenCalled()
    expect(queryMock).toHaveBeenCalled()
  })

  it('does not serve or restore a cached file when a deleted marker is present', async () => {
    const { buildDeletedFileMarkerRequest } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
    const cache = createCache(new Map([
      ['/read/attachments/orgs/test-org/apps/test-app/bundle.zip', new Response('cached deleted bytes', {
        headers: { 'content-type': 'application/zip' },
      })],
    ]))
    await cache.put(buildDeletedFileMarkerRequest('orgs/test-org/apps/test-app/bundle.zip'), new Response('deleted'))
    globalThis.caches = { default: cache } as any

    const bucketPut = vi.fn()
    const appGlobal = await createFilesApp()
    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/bundle.zip'),
      { ATTACHMENT_BUCKET: { put: bucketPut, head: vi.fn(), get: vi.fn() } },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(404)
    expect(bucketPut).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('purges file cache keys and writes a deleted marker', async () => {
    const cache = createCache()
    globalThis.caches = { default: cache } as any

    const { buildDeletedFileMarkerRequest, buildFileReadCacheRequest, purgeFileReadCache } = await import('../supabase/functions/_backend/files/file_read_cache.ts')
    const fileId = 'orgs/org-1/apps/com.cleanup.test/1.0.0.zip'
    const checksum = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const readRequest = buildFileReadCacheRequest(new Request(`https://api.capgo.app/files/read/attachments/${fileId}`))
    const keyedReadRequest = buildFileReadCacheRequest(new Request(`https://api.capgo.app/files/read/attachments/${fileId}?device_id=device-1&key=${checksum}`))
    await cache.put(readRequest, new Response('cached bundle bytes', {
      headers: { 'content-type': 'application/zip' },
    }))
    await cache.put(keyedReadRequest, new Response('cached keyed bundle bytes', {
      headers: { 'content-type': 'application/zip' },
    }))
    expect(await cache.match(readRequest)).not.toBeNull()
    expect(await cache.match(keyedReadRequest)).not.toBeNull()

    await purgeFileReadCache(fileId, checksum)

    expect(await cache.match(readRequest)).toBeNull()
    expect(await cache.match(keyedReadRequest)).toBeNull()
    const marker = await cache.match(buildDeletedFileMarkerRequest(fileId))
    expect(marker).not.toBeNull()
    expect(marker?.status).toBe(404)
  })

  it('treats deleted and deleted_at as deleted versions', async () => {
    const { isVersionDeleted } = await import('../supabase/functions/_backend/files/file_read_cache.ts')

    expect(isVersionDeleted({ deleted: true, deleted_at: null })).toBe(true)
    expect(isVersionDeleted({ deleted: false, deleted_at: '2026-08-16T00:00:00Z' })).toBe(true)
    expect(isVersionDeleted({ deleted: false, deleted_at: null })).toBe(false)
    expect(isVersionDeleted(null)).toBe(false)
  })
})
