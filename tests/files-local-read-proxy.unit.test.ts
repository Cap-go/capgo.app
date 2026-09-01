import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const createSignedUrlMock = vi.fn()
const getAppByAppIdPgMock = vi.fn()
const getPgClientMock = vi.fn(() => ({}))
const storageFromMock = vi.fn(() => ({
  createSignedUrl: createSignedUrlMock,
}))

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
  getAppByAppIdPg: getAppByAppIdPgMock,
  getUserIdFromApikey: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: vi.fn(() => ({
    storage: {
      from: storageFromMock,
    },
  })),
}))

describe('files local read proxy', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    globalThis.fetch = originalFetch
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  it.concurrent('proxies local storage reads without checking the app in the database', async () => {
    getAppByAppIdPgMock.mockResolvedValue({ app_id: 'test-app', owner_org: 'test-org' })
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://storage.example/object?token=test' },
      error: null,
    })

    globalThis.fetch = vi.fn(async (input, init) => {
      expect(String(input)).toBe('https://storage.example/object?token=test')
      expect(init?.method).toBe('GET')
      expect(init?.headers).toBeUndefined()
      return new Response('proxied local bytes', {
        headers: {
          'cache-control': 'public, max-age=60',
          'content-disposition': 'inline; filename="stored.txt"',
          'content-type': 'text/plain',
        },
      })
    }) as typeof fetch

    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
    const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
    const { version } = await import('../supabase/functions/_backend/utils/version.ts')

    const appGlobal = createHono('files', version)
    appGlobal.route('/', files)
    createAllCatch(appGlobal, 'files')

    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/local.txt'),
      {},
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('proxied local bytes')
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, no-transform')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="orgs/test-org/apps/test-app/local.txt"')
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(getAppByAppIdPgMock).not.toHaveBeenCalled()
    expect(storageFromMock).toHaveBeenCalledWith('capgo')
    expect(createSignedUrlMock).toHaveBeenCalledWith('orgs/test-org/apps/test-app/local.txt', 60)
  })

  it('preserves HEAD requests without downloading bytes from the signed URL proxy', async () => {
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: 'https://storage.example/object?token=test' },
      error: null,
    })

    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.method).toBe('HEAD')
      expect(init?.headers).toBeUndefined()
      return new Response(null, {
        headers: {
          'cache-control': 'public, max-age=60',
          'content-disposition': 'inline; filename="stored.txt"',
          'content-type': 'text/plain',
        },
      })
    }) as typeof fetch

    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
    const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
    const { version } = await import('../supabase/functions/_backend/utils/version.ts')

    const appGlobal = createHono('files', version)
    appGlobal.route('/', files)
    createAllCatch(appGlobal, 'files')

    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/local.txt', { method: 'HEAD' }),
      {},
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, no-transform')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="orgs/test-org/apps/test-app/local.txt"')
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(getAppByAppIdPgMock).not.toHaveBeenCalled()
  })
})
