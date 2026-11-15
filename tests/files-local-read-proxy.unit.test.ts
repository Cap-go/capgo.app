import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAppPlanStatePgMock = vi.fn()
const getPgClientMock = vi.fn(() => ({}))

const STORAGE_URL = 'http://storage.test'
const SERVICE_KEY = 'service-role-test-key'
const OBJECT_PATH = 'orgs/test-org/apps/test-app/local.txt'
const OBJECT_URL = `${STORAGE_URL}/storage/v1/object/authenticated/capgo/${OBJECT_PATH}`

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'node',
  }
})

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: () => Promise.resolve(),
  sendDiscordAlert: () => Promise.resolve(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: () => Promise.resolve(),
  getAppOwnerPostgres: vi.fn(),
  getDatabaseURL: vi.fn(() => 'postgres://test'),
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg_files.ts', () => ({
  getAppPlanStatePg: getAppPlanStatePgMock,
  withFreshPgRetry: vi.fn(),
  getUserIdFromApikey: vi.fn(),
}))

async function requestFile(init?: RequestInit, routeId = OBJECT_PATH) {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
  const { version } = await import('../supabase/functions/_backend/utils/version.ts')

  const appGlobal = createHono('files', version)
  appGlobal.route('/', files)
  createAllCatch(appGlobal, 'files')

  return appGlobal.fetch(
    new Request(`http://localhost/read/attachments/${routeId}`, init),
    {},
    { waitUntil: () => { } } as any,
  )
}

function mockStorage(response: (url: string) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => response(String(input)))
  globalThis.fetch = fetchMock as typeof fetch
  return fetchMock
}

function storageCall(fetchMock: ReturnType<typeof mockStorage>) {
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [input, init] = fetchMock.mock.calls[0]
  return { url: String(input), init: init!, headers: new Headers(init?.headers) }
}

const storedHeaders = {
  'cache-control': 'public, max-age=60',
  'content-disposition': 'inline; filename="stored.txt"',
  'content-type': 'text/plain',
}

describe('files local read proxy', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('SUPABASE_URL', STORAGE_URL)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY)
    globalThis.fetch = originalFetch
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it('reads the object from the Storage REST API with the service key', async () => {
    getAppPlanStatePgMock.mockResolvedValue({ kind: 'ok', value: { owner_org: 'test-org', plan_valid: true } })
    const fetchMock = mockStorage(() => new Response('proxied local bytes', { headers: storedHeaders }))

    const response = await requestFile()

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('proxied local bytes')
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, no-transform')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${OBJECT_PATH}"`)
    const { url, init, headers } = storageCall(fetchMock)
    expect(url).toBe(OBJECT_URL)
    expect(init.method).toBe('GET')
    expect(headers.get('authorization')).toBe(`Bearer ${SERVICE_KEY}`)
    expect(headers.get('apikey')).toBe(SERVICE_KEY)
    expect(headers.get('range')).toBeNull()
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(getAppPlanStatePgMock).not.toHaveBeenCalled()
  })

  it('forwards Range on GET and passes the partial response through', async () => {
    const fetchMock = mockStorage(() => new Response('pro', {
      status: 206,
      headers: { ...storedHeaders, 'content-range': 'bytes 0-2/19', 'content-length': '3' },
    }))

    const response = await requestFile({ headers: { range: 'bytes=0-2' } })

    expect(response.status).toBe(206)
    expect(await response.text()).toBe('pro')
    expect(response.headers.get('content-range')).toBe('bytes 0-2/19')
    expect(storageCall(fetchMock).headers.get('range')).toBe('bytes=0-2')
  })

  it('preserves HEAD requests without forwarding Range', async () => {
    const fetchMock = mockStorage(() => new Response(null, { headers: storedHeaders }))

    const response = await requestFile({ method: 'HEAD', headers: { range: 'bytes=0-2' } })

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, no-transform')
    expect(response.headers.get('content-disposition')).toBe(`attachment; filename="${OBJECT_PATH}"`)
    const { init, headers } = storageCall(fetchMock)
    expect(init.method).toBe('HEAD')
    expect(headers.get('range')).toBeNull()
    expect(getPgClientMock).not.toHaveBeenCalled()
  })

  it('returns 404 when Storage reports a missing object', async () => {
    mockStorage(() => new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message: 'Object not found' }), { status: 400 }))

    const response = await requestFile()

    expect(response.status).toBe(404)
  })

  const INFO_URL = `${STORAGE_URL}/storage/v1/object/info/authenticated/capgo/${OBJECT_PATH}`
  const storageError = (message: string) => new Response(JSON.stringify({ statusCode: '404', error: 'not_found', message }), { status: 400 })

  it.each([
    ['Object not found', 404],
    ['Bucket not found', 503],
  ])('classifies a bodiless HEAD 400 through the metadata route (%s -> %i)', async (message, status) => {
    const fetchMock = mockStorage(url => url === INFO_URL ? storageError(message) : new Response(null, { status: 400 }))

    const response = await requestFile({ method: 'HEAD' })

    expect(response.status).toBe(status)
    expect(fetchMock.mock.calls.map(([input, init]) => [String(input), init?.method ?? 'GET'])).toEqual([
      [OBJECT_URL, 'HEAD'],
      [INFO_URL, 'GET'],
    ])
  })

  it('returns 503 when the Storage bucket is missing', async () => {
    mockStorage(() => new Response(JSON.stringify({ statusCode: '404', error: 'Bucket not found', message: 'Bucket not found' }), { status: 400 }))

    const response = await requestFile()

    expect(response.status).toBe(503)
  })

  it('keeps reserved characters in the key encoded in the Storage URL', async () => {
    const fetchMock = mockStorage(() => new Response('bytes', { headers: storedHeaders }))

    const response = await requestFile(undefined, 'orgs/test-org/apps/test-app/main%3Fcopy.js')

    expect(response.status).toBe(200)
    const url = new URL(storageCall(fetchMock).url)
    expect(url.pathname).toBe('/storage/v1/object/authenticated/capgo/orgs/test-org/apps/test-app/main%3Fcopy.js')
    expect(url.search).toBe('')
  })

  it('refuses keys with dot segments instead of fetching outside the bucket', async () => {
    const fetchMock = mockStorage(() => new Response('other bucket bytes'))
    // A TUS-style upload ID decodes to a key that climbs out of the capgo bucket.
    const tusId = btoa('capgo/orgs/test-org/apps/test-app/../../../../images/private/icon.png/upload-uuid')

    const response = await requestFile(undefined, tusId)

    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns 503 when Storage fails', async () => {
    mockStorage(() => new Response('internal error', { status: 500 }))

    const response = await requestFile()

    expect(response.status).toBe(503)
  })
})
