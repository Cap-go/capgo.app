import { beforeEach, describe, expect, it, vi } from 'vitest'

const retryGetMock = vi.fn()
const retryHeadMock = vi.fn()
const createStatsBandwidthMock = vi.fn()
const queryMock = vi.fn()
const closeClientMock = vi.fn()
const getPgClientMock = vi.fn(async () => ({ query: queryMock }))

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

vi.mock('../supabase/functions/_backend/plugin_runtime/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
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
    get(key: string) {
      return retryGetMock(key)
    }

    head(key: string) {
      return retryHeadMock(key)
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
const plainReadUrl = `http://localhost/files/read/attachments/${filePath}?device_id=device-1`
const objectSize = 1_000

async function fetchHead(appGlobal: Awaited<ReturnType<typeof createFilesApp>>, range?: string) {
  const headers = range ? { range } : undefined
  return appGlobal.fetch(
    new Request(readUrl, { method: 'HEAD', headers }),
    { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
    { waitUntil: () => { } } as any,
  )
}

describe('files attachment HEAD reads on workerd/R2', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('MANIFEST_SIZE_RECEIPT_SECRET', 'receipt-secret')
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

  it.each(['HEAD', 'GET'])('requires exact physical keys for CLI %s while preserving device aliases', async (method) => {
    const hash = 'a'.repeat(64)
    const legacyKey = `orgs/test-org/apps/com.test.app/delta/${hash}_.htaccess`
    const safeKey = `orgs/test-org/apps/com.test.app/delta/${hash}_%2Ehtaccess`
    retryHeadMock.mockImplementation(async (key: string) => key === legacyKey ? { ...createR2HeadObject(4), key: legacyKey } : null)
    retryGetMock.mockImplementation(async (key: string) => key === legacyKey ? { ...createR2Object(4), key: legacyKey } : null)
    const appGlobal = await createFilesApp()
    const url = `http://localhost/files/read/attachments/${encodeURIComponent(safeKey)}`
    const env = { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} }
    const response = await appGlobal.fetch(
      new Request(`${url}${method === 'HEAD' ? '?nocache=' : ''}`, { method, headers: method === 'GET' ? { 'x-cli-version': '8.82.0' } : {} }),
      env,
      { waitUntil: () => {} } as any,
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('x-capgo-manifest-size-receipt')).toBeNull()
    expect(retryHeadMock).not.toHaveBeenCalledWith(legacyKey)
    expect(retryGetMock).not.toHaveBeenCalledWith(legacyKey)

    const deviceResponse = await appGlobal.fetch(new Request(url, { method }), env, { waitUntil: () => {} } as any)
    expect(deviceResponse.status).toBe(200)
    expect(deviceResponse.headers.get('x-capgo-manifest-size-receipt')).toBeNull()

    const exactResponse = await appGlobal.fetch(
      new Request(`http://localhost/files/read/attachments/${encodeURIComponent(legacyKey)}?nocache=test`, { method }),
      env,
      { waitUntil: () => {} } as any,
    )
    const { verifyManifestSizeReceiptFacts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    const receipt = exactResponse.headers.get('x-capgo-manifest-size-receipt')!
    expect(exactResponse.status).toBe(200)
    expect(await verifyManifestSizeReceiptFacts('receipt-secret', 'capgo', [{ path: legacyKey, receipt }])).not.toBeNull()
    expect(await verifyManifestSizeReceiptFacts('receipt-secret', 'capgo', [{ path: safeKey, receipt }])).toBeNull()
  })

  it.each(['HEAD', 'GET'])('rejects CLI %s cached aliases that have no receipt for the exact physical key', async (method) => {
    const hash = 'a'.repeat(64)
    const legacyKey = `orgs/test-org/apps/com.test.app/delta/${hash}_.htaccess`
    const safeKey = `orgs/test-org/apps/com.test.app/delta/${hash}_%2Ehtaccess`
    const { createManifestSizeReceipt } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    const receipt = await createManifestSizeReceipt('receipt-secret', 'capgo', legacyKey, { size: 4, source: 'r2_read', evidenceAt: Date.now() - 60_000 })
    globalThis.caches = { default: {
      match: async (request: Request) => new URL(request.url).pathname.startsWith('/deleted/') ? null : new Response('cached bytes', { headers: { 'content-length': '4', 'x-capgo-manifest-size-receipt': receipt } }),
      put: async () => {},
    } } as any
    retryHeadMock.mockImplementation(async (key: string) => key === legacyKey ? { ...createR2HeadObject(4), key: legacyKey } : null)
    const appGlobal = await createFilesApp()
    const url = `http://localhost/files/read/attachments/${encodeURIComponent(safeKey)}`
    const env = { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} }
    const response = await appGlobal.fetch(
      new Request(`${url}?nocache=test`, { method }),
      env,
      { waitUntil: () => {} } as any,
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('x-capgo-manifest-size-receipt')).toBeNull()
    expect(retryHeadMock).not.toHaveBeenCalledWith(legacyKey)
    const deviceResponse = await appGlobal.fetch(new Request(url, { method }), env, { waitUntil: () => {} } as any)
    expect(deviceResponse.status).toBe(200)
  })

  it('does not add generic percent decode candidates for non-dotfile attachment paths', async () => {
    const encodedSegmentPath = 'orgs/test-org/apps/com.test.app/delta/hash_assets/B%2FC/file.txt'
    const headCalls: string[] = []
    retryHeadMock.mockImplementation(async (key: string) => {
      headCalls.push(key)
      if (key === encodedSegmentPath)
        return createR2HeadObject(8)
      return null
    })
    const appGlobal = await createFilesApp()
    const readUrl = `http://localhost/files/read/attachments/${encodeURIComponent(encodedSegmentPath)}?nocache=test`

    const response = await appGlobal.fetch(
      new Request(readUrl, { method: 'HEAD' }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(headCalls).toEqual([encodedSegmentPath])
  })

  it('adds a complete-size receipt for a CLI HEAD without nocache', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(3_478_395))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(plainReadUrl, { method: 'HEAD', headers: { 'x-cli-version': '7.0.0' } }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    const receipt = response.headers.get('x-capgo-manifest-size-receipt')
    const { verifyManifestSizeReceipts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    expect(await verifyManifestSizeReceipts('receipt-secret', [{ path: filePath, receipt: receipt! }])).toEqual([3_478_395])
  })

  it('adds a complete-size receipt for a CLI GET without nocache', async () => {
    retryGetMock.mockResolvedValue(createR2Object(12))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(plainReadUrl, { headers: { 'x-cli-version': '7.0.0' } }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    const receipt = response.headers.get('x-capgo-manifest-size-receipt')
    const { verifyManifestSizeReceipts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    expect(await verifyManifestSizeReceipts('receipt-secret', [{ path: filePath, receipt: receipt! }])).toEqual([12])
  })

  it('treats an empty nocache query parameter as a receipt request', async () => {
    retryHeadMock.mockResolvedValue(createR2HeadObject(12))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(`${plainReadUrl}&nocache=`, { method: 'HEAD' }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.headers.get('x-capgo-manifest-size-receipt')).not.toBeNull()
  })

  it('uses local read evidence even when provider upload metadata is ahead of the clock', async () => {
    retryHeadMock.mockResolvedValue({ ...createR2HeadObject(12), uploaded: new Date(Date.now() + 10_000) })
    const response = await fetchHead(await createFilesApp())
    expect(response.status).toBe(200)
    const { verifyManifestSizeReceiptFacts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    expect(await verifyManifestSizeReceiptFacts('receipt-secret', 'capgo', [{ path: filePath, receipt: response.headers.get('x-capgo-manifest-size-receipt')! }])).toEqual([expect.objectContaining({ source: 'r2_read', size: 12 })])
  })

  it('captures read evidence before awaiting R2 metadata', async () => {
    const start = Date.now()
    let clock = start
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    retryHeadMock.mockImplementation(async () => {
      clock += 10_000
      return createR2HeadObject(12)
    })
    try {
      const response = await fetchHead(await createFilesApp())
      const { verifyManifestSizeReceiptFacts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
      expect(await verifyManifestSizeReceiptFacts('receipt-secret', 'capgo', [{ path: filePath, receipt: response.headers.get('x-capgo-manifest-size-receipt')! }])).toEqual([
        expect.objectContaining({ source: 'r2_read', evidenceAt: start, signedAt: start + 10_000 }),
      ])
    }
    finally { dateNow.mockRestore() }
  })

  it('preserves the original cached receipt and does not refresh its signing or evidence times', async () => {
    const { createManifestSizeReceipt, verifyManifestSizeReceiptFacts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    const evidenceAt = Date.now() - 60_000
    const originalReceipt = await createManifestSizeReceipt('receipt-secret', 'capgo', filePath, { size: 12, source: 'r2_read', evidenceAt })
    globalThis.caches = {
      default: {
        match: async (request: Request) => new URL(request.url).pathname.startsWith('/deleted/')
          ? null
          : new Response('cached bytes', {
              headers: { 'content-length': '12', 'x-capgo-manifest-size-receipt': originalReceipt },
            }),
        put: async () => {},
      },
    } as any
    retryHeadMock.mockResolvedValue(createR2HeadObject(12))
    const response = await fetchHead(await createFilesApp())
    expect(response.headers.get('x-capgo-manifest-size-receipt')).toBe(originalReceipt)
    expect(await verifyManifestSizeReceiptFacts('receipt-secret', 'capgo', [{ path: filePath, receipt: originalReceipt }])).toEqual([
      expect.objectContaining({ evidenceAt }),
    ])
  })

  it('cannot mint a receipt from an old cache entry when R2 has no object', async () => {
    globalThis.caches = {
      default: {
        match: async (request: Request) => new URL(request.url).pathname.startsWith('/deleted/')
          ? null
          : new Response('cached bytes', {
              headers: { 'content-length': '12', 'x-capgo-manifest-size-receipt': 'legacy-cached-value' },
            }),
        put: async () => {},
      },
    } as any
    retryHeadMock.mockResolvedValue(null)
    const response = await fetchHead(await createFilesApp())
    expect(response.status).toBe(404)
    expect(response.headers.get('x-capgo-manifest-size-receipt')).toBeNull()
  })

  it('stores the original receipt with cached R2 bytes', async () => {
    const put = vi.fn(async (_request: Request, _response: Response) => {})
    globalThis.caches = { default: { match: async () => null, put } } as any
    retryGetMock.mockResolvedValue(createR2Object(12))
    const response = await (await createFilesApp()).fetch(
      new Request(plainReadUrl, { headers: { 'x-cli-version': '7.0.0' } }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => {} } as any,
    )
    expect(put).toHaveBeenCalled()
    const cached = put.mock.calls[0]![1] as Response
    expect(cached.headers.get('x-capgo-manifest-size-receipt')).toBe(response.headers.get('x-capgo-manifest-size-receipt'))
  })

  it('adds a complete-size receipt to CLI cache hits', async () => {
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          if (new URL(request.url).pathname.startsWith('/deleted/'))
            return null
          return new Response('cached zip bytes', {
            headers: {
              'content-length': '3478395',
              'x-capgo-manifest-size-receipt': 'stale-cached-receipt',
              'x-test-cache-hit': 'yes',
            },
          })
        },
        put: async () => { },
      },
    } as any
    retryHeadMock.mockResolvedValue(createR2HeadObject(3_478_395))
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(plainReadUrl, { method: 'HEAD', headers: { 'x-cli-version': '7.0.0' } }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    const receipt = response.headers.get('x-capgo-manifest-size-receipt')
    const { verifyManifestSizeReceipts } = await import('../supabase/functions/_backend/utils/manifest_size_receipt.ts')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-test-cache-hit')).toBe('yes')
    expect(receipt).not.toBe('stale-cached-receipt')
    expect(await verifyManifestSizeReceipts('receipt-secret', [{ path: filePath, receipt: receipt! }])).toEqual([3_478_395])
  })

  it('does not expose a cached receipt to normal native reads', async () => {
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          if (new URL(request.url).pathname.startsWith('/deleted/'))
            return null
          return new Response('cached zip bytes', {
            headers: {
              'content-length': '3478395',
              'x-capgo-manifest-size-receipt': 'stale-cached-receipt',
              'x-test-cache-hit': 'yes',
            },
          })
        },
        put: async () => { },
      },
    } as any
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request(plainReadUrl, { method: 'HEAD' }),
      { MANIFEST_SIZE_RECEIPT_SECRET: 'receipt-secret', ATTACHMENT_BUCKET: {} },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('x-test-cache-hit')).toBe('yes')
    expect(response.headers.get('x-capgo-manifest-size-receipt')).toBeNull()
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
