import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const getAppByAppIdPgMock = vi.fn(async () => null)
const getPgClientMock = vi.fn(() => ({
  query: async () => ({ rows: [] }),
}))
const originalCaches = globalThis.caches
const cachedBodiesByPath = new Map([
  ['/read/attachments/orgs/test-org/apps/test-app/orphan.txt', 'cached orphan bytes'],
  ['/read/attachments/orgs/test-org/apps/test-app/', 'cached malformed bytes'],
])

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
  closeClient: () => Promise.resolve(),
  getAppOwnerPostgres: vi.fn(),
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg_files.ts', () => ({
  getAppByAppIdPg: getAppByAppIdPgMock,
  getUserIdFromApikey: vi.fn(),
}))

async function createFilesApp() {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { createAllCatch, createHono } = await import('../supabase/functions/_backend/utils/hono.ts')
  const { version } = await import('../supabase/functions/_backend/utils/version.ts')

  const appGlobal = createHono('files', version)
  appGlobal.route('/', files)
  createAllCatch(appGlobal, 'files')
  return appGlobal
}

describe('files app-scoped cached reads', () => {
  beforeAll(() => {
    vi.clearAllMocks()
    globalThis.caches = {
      default: {
        match: async (request: Request) => {
          const pathname = new URL(request.url).pathname
          const body = cachedBodiesByPath.get(pathname)
          if (body == null)
            return null

          return new Response(body, {
            headers: {
              'content-type': 'text/plain',
            },
          })
        },
        put: async () => { },
      },
    } as any
  })

  afterAll(() => {
    globalThis.caches = originalCaches
  })

  it.concurrent('serves orphan app-scoped files from cache when no deleted version row exists', async () => {
    const bucketPut = vi.fn()
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/orphan.txt'),
      {
        ATTACHMENT_BUCKET: { put: bucketPut },
      },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('cached orphan bytes')
    expect(bucketPut).not.toHaveBeenCalled()
    expect(getAppByAppIdPgMock).not.toHaveBeenCalled()
  })

  it.concurrent('serves malformed app-scoped paths from cache when no deleted version row exists', async () => {
    const bucketPut = vi.fn()
    const appGlobal = await createFilesApp()

    const response = await appGlobal.fetch(
      new Request('http://localhost/read/attachments/orgs/test-org/apps/test-app/'),
      {
        ATTACHMENT_BUCKET: { put: bucketPut },
      },
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('cached malformed bytes')
    expect(bucketPut).not.toHaveBeenCalled()
    expect(getAppByAppIdPgMock).not.toHaveBeenCalled()
  })
})
