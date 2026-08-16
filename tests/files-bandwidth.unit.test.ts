import { beforeEach, describe, expect, it, vi } from 'vitest'

const retryGetMock = vi.fn()
const createStatsBandwidthMock = vi.fn()

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
  },
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  createStatsBandwidth: createStatsBandwidthMock,
}))

function createR2Object(size: number, range?: R2Range): R2ObjectBody {
  return {
    body: new Response('bundle bytes').body,
    checksums: {},
    customMetadata: {},
    etag: 'etag',
    httpEtag: '"etag"',
    httpMetadata: {},
    key: 'orgs/test-org/apps/com.test.app/bundle.zip',
    range,
    size,
    uploaded: new Date(),
    version: 'version',
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'application/zip')
    },
  } as R2ObjectBody
}

async function createFilesApp(routePrefix: string) {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
  const { version } = await import('../supabase/functions/_backend/utils/version.ts')

  const appGlobal = createHono('files', version)
  appGlobal.route(routePrefix, files)
  createAllCatch(appGlobal, 'files')
  return appGlobal
}

describe('files bandwidth tracking', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    globalThis.caches = {
      default: {
        match: async () => null,
        put: async () => { },
      },
    } as any
  })

  it('calculates full object bytes when Cloudflare returns an empty range shape', async () => {
    const { calculateBytesTransferred } = await import('../supabase/functions/_backend/files/files.ts')

    expect(calculateBytesTransferred(3_478_395, { suffix: undefined } as unknown as R2Range)).toBe(3_478_395)
  })

  it('tracks bandwidth for file-worker reads with the calculated object size', async () => {
    retryGetMock.mockResolvedValue(createR2Object(3_478_395, { suffix: undefined } as unknown as R2Range))
    const appGlobal = await createFilesApp('/files')

    const response = await appGlobal.fetch(
      new Request('http://localhost/files/read/attachments/orgs/test-org/apps/com.test.app/bundle.zip?device_id=device-1'),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3478395')
    expect(createStatsBandwidthMock).toHaveBeenCalledWith(
      expect.anything(),
      'device-1',
      'com.test.app',
      3_478_395,
    )
  })

  it('does not track bandwidth for cached HEAD reads', async () => {
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          if (new URL(request.url).pathname.startsWith('/deleted/'))
            return null
          return new Response(null, {
            headers: {
              'cache-control': 'public, max-age=3600',
              'content-length': '3478395',
            },
          })
        },
        put: async () => { },
      },
    } as any
    const appGlobal = await createFilesApp('/files')

    const response = await appGlobal.fetch(
      new Request('http://localhost/files/read/attachments/orgs/test-org/apps/com.test.app/bundle.zip?device_id=device-1', {
        method: 'HEAD',
      }),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(createStatsBandwidthMock).not.toHaveBeenCalled()
  })

  it('keeps range response headers finite when suffix is present but empty', async () => {
    retryGetMock.mockResolvedValue(createR2Object(3_478_395, { offset: 0, length: 100, suffix: undefined } as unknown as R2Range))
    const appGlobal = await createFilesApp('/files')

    const response = await appGlobal.fetch(
      new Request('http://localhost/files/read/attachments/orgs/test-org/apps/com.test.app/bundle.zip?device_id=device-1', {
        headers: { range: 'bytes=0-99' },
      }),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(206)
    expect(response.headers.get('content-range')).toBe('bytes 0-99/3478395')
    expect(response.headers.get('content-length')).toBe('100')
    expect(createStatsBandwidthMock).toHaveBeenCalledWith(
      expect.anything(),
      'device-1',
      'com.test.app',
      100,
    )
  })
})
