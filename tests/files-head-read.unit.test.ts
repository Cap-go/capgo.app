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
    checksums: { sha256: new Uint8Array(32) },
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

function createR2HeadObject(size: number): R2Object {
  return {
    checksums: { sha256: new Uint8Array(32) },
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
  } as R2Object
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
const readUrl = `http://localhost/files/read/attachments/${filePath}?device_id=device-1`

describe('files attachment HEAD reads on workerd/R2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
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

    const response = await appGlobal.fetch(
      new Request(readUrl, { method: 'HEAD' }),
      { ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('3478395')
    expect(response.headers.get('content-type')).toBe('application/zip')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${filePath}"`)
    expect(await response.text()).toBe('')
    expect((await response.arrayBuffer()).byteLength).toBe(0)
    expect(retryGetMock).not.toHaveBeenCalled()
    expect(createStatsBandwidthMock).not.toHaveBeenCalled()
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
    expect(getResponse.status).toBe(404)
    expect(await getResponse.json()).toMatchObject({ error: 'not_found' })
    expect(retryGetMock).not.toHaveBeenCalled()
    expect(retryHeadMock).not.toHaveBeenCalled()
  })
})
