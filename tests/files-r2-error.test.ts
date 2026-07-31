import { describe, expect, it, vi } from 'vitest'

const retryGetMock = vi.fn()
const retryHeadMock = vi.fn()

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObjectMock {},
  WorkerEntrypoint: class WorkerEntrypointMock {},
}))
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

vi.mock('../supabase/functions/_backend/files/retry.ts', () => ({
  DEFAULT_RETRY_PARAMS: {},
  RetryBucket: class RetryBucketMock {
    constructor() { }
    get() {
      return retryGetMock()
    }

    head() {
      return retryHeadMock()
    }
  },
}))

describe('files R2 error handling', () => {
  it('should return 503 when R2 get fails', async () => {
    vi.resetModules()
    retryHeadMock.mockResolvedValue(null)
    retryGetMock.mockImplementation(() => {
      throw new Error('r2 unavailable')
    })

    globalThis.caches = {
      default: {
        match: async () => null,
        put: async () => { },
      },
    } as any

    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
    const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
    const { version } = await import('../supabase/functions/_backend/utils/version.ts')

    const appGlobal = createHono('files', version)
    appGlobal.route('/', files)
    createAllCatch(appGlobal, 'files')

    const request = new Request('http://localhost/read/attachments/test.zip')
    const response = await appGlobal.fetch(
      request,
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(503)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('upstream_unavailable')
  })

  it('should add immutable cache control and strip tracking params on cached responses', async () => {
    vi.resetModules()
    retryHeadMock.mockResolvedValue(null)
    retryGetMock.mockResolvedValue(null)

    const matchMock = vi.fn(async (request: Request) => {
      const cacheUrl = new URL(request.url)
      expect(cacheUrl.searchParams.get('device_id')).toBeNull()
      expect(cacheUrl.searchParams.get('key')).toBe('checksum')
      expect(cacheUrl.searchParams.get('range')).toBe('')
      return new Response('cached zip bytes', {
        headers: {
          'content-type': 'application/zip',
        },
      })
    })

    globalThis.caches = {
      default: {
        match: matchMock,
        put: async () => { },
      },
    } as any

    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
    const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
    const { version } = await import('../supabase/functions/_backend/utils/version.ts')

    const appGlobal = createHono('files', version)
    appGlobal.route('/', files)
    createAllCatch(appGlobal, 'files')

    const request = new Request('http://localhost/read/attachments/test.zip?device_id=device-1&key=checksum')
    const response = await appGlobal.fetch(
      request,
      {
        ATTACHMENT_BUCKET: { put: vi.fn().mockResolvedValue(undefined) },
      },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable, no-transform')
    expect(matchMock).toHaveBeenCalledTimes(1)
  })

  it('should persist no-transform in file metadata written to R2', async () => {
    const { buildFileHttpMetadata } = await import('../supabase/functions/_backend/files/util.ts')

    expect(buildFileHttpMetadata('application/zip')).toEqual({
      cacheControl: 'no-transform',
      contentType: 'application/zip',
    })

    expect(buildFileHttpMetadata('application/zip', 'public, max-age=3600')).toEqual({
      cacheControl: 'public, max-age=3600, no-transform',
      contentType: 'application/zip',
    })
  })
})

describe('files worker cache keys', () => {
  it('should strip tracking params and preserve file identity params', async () => {
    const { filesWorkerCacheTestUtils } = await import('../cloudflare_workers/files/index.ts')

    const cacheKey = filesWorkerCacheTestUtils.buildWorkersCacheKey(
      new Request('https://api.capgo.app/files/read/attachments/orgs/test/apps/app/bundle.zip?device_id=device-1&key=checksum'),
    )

    expect(cacheKey).toBe('/files-cache/files/read/attachments/orgs/test/apps/app/bundle.zip?key=checksum')
  })

  it('should include preview host in cache keys', async () => {
    const { filesWorkerCacheTestUtils } = await import('../cloudflare_workers/files/index.ts')

    const cacheKey = filesWorkerCacheTestUtils.buildWorkersCacheKey(
      new Request('https://app-123.preview.capgo.app/index.html?b=2&a=1'),
    )

    expect(cacheKey).toBe('/preview-cache/app-123.preview.capgo.app/index.html?a=1&b=2')
  })

  it('should bypass channel preview and range requests', async () => {
    const { filesWorkerCacheTestUtils } = await import('../cloudflare_workers/files/index.ts')

    expect(filesWorkerCacheTestUtils.buildWorkersCacheKey(
      new Request('https://c12-app.preview.capgo.app/index.html'),
    )).toBeNull()
    expect(filesWorkerCacheTestUtils.buildWorkersCacheKey(
      new Request('https://api.capgo.app/files/read/attachments/test.zip', { headers: { range: 'bytes=0-99' } }),
    )).toBeNull()
  })
})
