import { beforeEach, describe, expect, it, vi } from 'vitest'

const retryGetMock = vi.fn()
const retryHeadMock = vi.fn()
const createStatsBandwidthMock = vi.fn()
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
    constructor() { }
    get() {
      return retryGetMock()
    }

    head() {
      return retryHeadMock()
    }
  },
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  createStatsBandwidth: createStatsBandwidthMock,
}))

function createR2Object(size: number, range?: R2Range): R2ObjectBody {
  return {
    body: new Response('bundle bytes'.repeat(Math.ceil(size / 12))).body,
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
  } as unknown as R2ObjectBody
}

function createR2HeadObject(size: number): R2Object {
  return {
    checksums: {},
    customMetadata: {},
    etag: 'etag',
    httpEtag: '"etag"',
    httpMetadata: {},
    key: 'orgs/test-org/apps/com.test.app/bundle.zip',
    size,
    uploaded: new Date(),
    version: 'version',
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'application/zip')
    },
  } as unknown as R2Object
}

async function createFilesApp(routePrefix = '/files') {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
  const { version } = await import('../supabase/functions/_backend/utils/version.ts')

  const appGlobal = createHono('files', version)
  appGlobal.route(routePrefix, files)
  createAllCatch(appGlobal, 'files')
  return appGlobal
}

const filePath = 'orgs/test-org/apps/com.test.app/bundle.zip'
const readUrl = `http://localhost/files/read/attachments/${filePath}?device_id=device-1&nocache=test`
const objectSize = 1_000

async function fetchHead(appGlobal: Awaited<ReturnType<typeof createFilesApp>>, range?: string) {
  const headers = range ? { range } : undefined
  return appGlobal.fetch(
    new Request(readUrl, { method: 'HEAD', headers }),
    { API_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
    { waitUntil: () => { } } as any,
  )
}

describe('files attachment HEAD reads on workerd/R2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('API_SECRET', 'receipt-secret')
    queryMock.mockResolvedValue({ rows: [] })
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          if (new URL(request.url).pathname.startsWith('/deleted/'))
            return null
          return null
        },
        put: async () => { },
      },
    } as any
  })

  it('returns headers-only 200 with Content-Length on R2 HEAD miss', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(3_478_395))
    retryGetMock.mockResolvedValue(null)
    const appGlobal = await createFilesApp()

    const response = await fetchHead(appGlobal)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3478395')
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filePath}"`)
    const receipt = response.headers.get('x-capgo-manifest-size-receipt')
    const { verifyManifestSizeReceipts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    expect(await verifyManifestSizeReceipts('receipt-secret', [{ path: filePath, receipt: receipt! }])).toEqual([3_478_395])
    expect(await response.text()).toBe('')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(retryGetMock).not.toHaveBeenCalled()
    expect(createStatsBandwidthMock).not.toHaveBeenCalled()
  })

  it('returns 404 when R2 head finds no object', async () => {
    retryHeadMock.mockResolvedValue(null)
    const appGlobal = await createFilesApp()

    const response = await fetchHead(appGlobal)

    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(retryGetMock).not.toHaveBeenCalled()
  })

  it('returns 503 when R2 head fails', async () => {
    retryHeadMock.mockRejectedValue(new Error('r2 unavailable'))
    const appGlobal = await createFilesApp()

    const response = await fetchHead(appGlobal)

    expect(response.status).toBe(503)
    expect(retryGetMock).not.toHaveBeenCalled()
  })

  it('returns 206 for bounded, open-ended, and suffix HEAD ranges', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(objectSize))
    const appGlobal = await createFilesApp()

    const bounded = await fetchHead(appGlobal, 'bytes=0-99')
    expect(bounded.status).toBe(206)
    expect(bounded.headers.get('content-length')).toBe('100')
    expect(bounded.headers.get('content-range')).toBe(`bytes 0-99/${objectSize}`)
    expect((await bounded.arrayBuffer()).byteLength).toBe(0)

    const openEnded = await fetchHead(appGlobal, 'bytes=100-')
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('content-length')).toBe('900')
    expect(openEnded.headers.get('content-range')).toBe(`bytes 100-999/${objectSize}`)

    const suffix = await fetchHead(appGlobal, 'bytes=-500')
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-length')).toBe('500')
    expect(suffix.headers.get('content-range')).toBe(`bytes 500-999/${objectSize}`)
  })

  it('returns 416 for reversed and unsatisfiable HEAD ranges', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(objectSize))
    const appGlobal = await createFilesApp()

    const reversed = await fetchHead(appGlobal, 'bytes=10-5')
    expect(reversed.status).toBe(416)
    expect(reversed.headers.get('content-range')).toBe(`bytes */${objectSize}`)
    expect((await reversed.arrayBuffer()).byteLength).toBe(0)

    const unsatisfiable = await fetchHead(appGlobal, 'bytes=1000-')
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${objectSize}`)
  })

  it('parses attachment byte ranges for suffix and invalid inputs', async () => {
    const { parseAttachmentByteRange } = await import('../supabase/functions/_backend/files/files.ts')

    expect(parseAttachmentByteRange('bytes=-500', objectSize)).toEqual({
      kind: 'partial',
      start: 500,
      end: 999,
      bytesTransferred: 500,
    })
    expect(parseAttachmentByteRange('bytes=10-5', objectSize)).toEqual({ kind: 'invalid' })
    expect(parseAttachmentByteRange('bytes=1000-', objectSize)).toEqual({ kind: 'invalid' })
  })

  it('returns headers-only 200 with Content-Length on cache hit', async () => {
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          if (new URL(request.url).pathname.startsWith('/deleted/'))
            return null
          return new Response('cached zip bytes', {
            headers: {
              'cache-control': 'public, max-age=3600',
              'content-length': '3478395',
              'content-type': 'application/zip',
              'content-disposition': `attachment; filename="${filePath}"`,
            },
          })
        },
        put: async () => { },
      },
    } as any
    retryHeadMock.mockResolvedValue(createR2HeadObject(3_478_395))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(readUrl, { method: 'HEAD' }),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3478395')
    expect(await response.text()).toBe('')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(createStatsBandwidthMock).not.toHaveBeenCalled()
  })

  it('still returns body bytes for GET on R2 miss', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(12))
    retryGetMock.mockResolvedValue(createR2Object(12))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(readUrl),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('12')
    expect((await response.text()).length).toBeGreaterThan(0)
    expect(createStatsBandwidthMock).toHaveBeenCalledWith(
      expect.anything(),
      'device-1',
      'com.test.app',
      12,
    )
  })

  it('returns 404 for deleted versions on HEAD and GET', async () => {
    queryMock.mockResolvedValue({
      rows: [{ deleted: true, deleted_at: '2026-08-16T00:00:00Z' }],
    })
    retryHeadMock.mockResolvedValue(createR2HeadObject(100))
    retryGetMock.mockResolvedValue(createR2Object(100))
    const appGlobal = await createFilesApp()

    const headResponse = await appGlobal.fetch(
      new Request(readUrl, { method: 'HEAD' }),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )
    const getResponse = await appGlobal.fetch(
      new Request(readUrl),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(headResponse.status).toBe(404)
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0)
    expect(getResponse.status).toBe(404)
    expect(await getResponse.json()).toMatchObject({ error: 'not_found' })
    expect(retryGetMock).not.toHaveBeenCalled()
    expect(retryHeadMock).not.toHaveBeenCalled()
  })
})
