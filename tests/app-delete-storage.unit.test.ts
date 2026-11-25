import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  deleteObjectsWithPrefix: vi.fn(),
  expireSimulatorSessions: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  removeImageFolder: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/image_storage.ts', () => ({
  removeImageFolder: (...args: unknown[]) => mocks.removeImageFolder(...args),
}))

vi.mock('../supabase/functions/_backend/public/build/concurrency.ts', () => ({
  expireSimulatorSessions: (...args: unknown[]) => mocks.expireSimulatorSessions(...args),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: (...args: unknown[]) => mocks.checkPermission(...args),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: (...args: unknown[]) => mocks.cloudlog(...args),
  cloudlogErr: (...args: unknown[]) => mocks.cloudlogErr(...args),
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    deleteObjectsWithPrefix: (...args: unknown[]) => mocks.deleteObjectsWithPrefix(...args),
  },
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const ORG_ID = '22222222-2222-4222-8222-222222222222'
const APP_ID = 'com.example.app'

// Direct Postgres: the owner_org lookup returns the org, every delete succeeds.
const pgClient = {
  query: vi.fn(async (_text: string): Promise<{ rows: { row: { owner_org: string } }[] }> => ({ rows: [] })),
}

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getDrizzleClient: vi.fn(),
  getPgClient: vi.fn(async () => pgClient),
  withPgTransaction: async (_pg: unknown, run: (client: unknown) => Promise<unknown>) => run(pgClient),
}))

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => ({ SUPABASE_URL: 'https://sb.example', SUPABASE_SERVICE_ROLE_KEY: 'service-key' } as Record<string, string>)[key] ?? '',
}))

// Supabase Storage REST: `list` gets (bucket, prefix, body), `remove` gets (bucket, paths);
// each returns the Response the endpoint would send.
const STORAGE = 'https://sb.example/storage/v1/object'
const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
  const body = JSON.parse(init.body as string)
  if (url.startsWith(`${STORAGE}/list/`))
    return mocks.list(url.slice(`${STORAGE}/list/`.length), body.prefix, body)
  if (init.method === 'DELETE')
    return mocks.remove(url.slice(`${STORAGE}/`.length), body.prefixes)
  throw new Error(`unexpected fetch ${url}`)
})
vi.stubGlobal('fetch', fetchMock)

const { deleteApp } = await import('../supabase/functions/_backend/public/app/delete.ts')

function createContext() {
  return {
    get: vi.fn(() => undefined),
    json: (body: unknown) => Response.json(body),
  } as any
}

function file(name: string) {
  return { id: `id-${name}`, name }
}

describe('app delete storage cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgClient.query.mockImplementation(async text => ({ rows: text.includes('SELECT owner_org FROM public.apps') ? [{ row: { owner_org: ORG_ID } }] : [] }))
    mocks.checkPermission.mockResolvedValue(true)
    mocks.deleteObjectsWithPrefix.mockResolvedValue(0)
    mocks.remove.mockImplementation(async () => Response.json([]))
    mocks.list.mockImplementation(async () => Response.json([]))
    mocks.removeImageFolder.mockResolvedValue(0)
    mocks.expireSimulatorSessions.mockResolvedValue(undefined)
  })

  it('leaves R2 cleanup to on_app_delete and paginates the legacy apps bucket', async () => {
    mocks.list.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}`)
        return Response.json([{ id: null, name: 'versions' }])
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}/versions`)
        return Response.json([file('1.0.0.zip'), file('1.0.1.zip')])
      return Response.json([])
    })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    // R2 bundle storage and the app icon are deleted once, in bounded passes, by the
    // on_app_delete trigger; the request no longer lists or deletes them itself.
    expect(mocks.deleteObjectsWithPrefix).not.toHaveBeenCalled()
    expect(mocks.removeImageFolder).not.toHaveBeenCalled()
    // Images no longer go through Supabase Storage.
    expect(mocks.list).not.toHaveBeenCalledWith('images', expect.anything(), expect.anything())
    expect(mocks.remove).not.toHaveBeenCalledWith('images', expect.anything())
    expect(mocks.remove).toHaveBeenCalledWith('apps', [
      `${USER_ID}/${APP_ID}/versions/1.0.0.zip`,
      `${USER_ID}/${APP_ID}/versions/1.0.1.zip`,
    ])
    expect(mocks.list).toHaveBeenCalledWith('apps', `${USER_ID}/${APP_ID}`, {
      limit: 100,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
      prefix: `${USER_ID}/${APP_ID}`,
    })
    expect(fetchMock).toHaveBeenCalledWith(`${STORAGE}/apps`, expect.objectContaining({
      method: 'DELETE',
      headers: expect.objectContaining({ Authorization: 'Bearer service-key', apikey: 'service-key' }),
    }))
    expect(mocks.cloudlogErr).not.toHaveBeenCalled()
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })

  it('pages through the legacy apps bucket and removes in batches of 1000', async () => {
    const prefix = `${USER_ID}/${APP_ID}`
    const names = Array.from({ length: 1150 }, (_, i) => `f${String(i).padStart(4, '0')}.zip`)
    mocks.list.mockImplementation(async (bucket: string, listPrefix: string, body: { offset: number, limit: number }) => {
      if (bucket !== 'apps' || listPrefix !== prefix)
        return Response.json([])
      return Response.json(names.slice(body.offset, body.offset + body.limit).map(file))
    })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    const appsOffsets = mocks.list.mock.calls.filter(([bucket]) => bucket === 'apps').map(([, , body]) => body.offset)
    expect(appsOffsets).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100])
    const batches = mocks.remove.mock.calls.filter(([bucket]) => bucket === 'apps').map(([, paths]) => paths)
    expect(batches.map(paths => paths.length)).toEqual([1000, 150])
    expect(batches.flat()).toEqual(names.map(name => `${prefix}/${name}`))
  })

  it.each([
    ['an error status from list', () => mocks.list.mockImplementation(async () => new Response('storage unavailable', { status: 503 }))],
    ['a network error from list', () => mocks.list.mockRejectedValue(new TypeError('fetch failed'))],
  ])('logs legacy apps bucket errors (%s) and still deletes the app', async (_label, fail) => {
    fail()

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting legacy user-scoped app storage' }))
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })

  it('logs a failed legacy apps bucket remove', async () => {
    mocks.list.mockImplementation(async (bucket: string, prefix: string) =>
      Response.json(bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}` ? [file('1.0.0.zip')] : []))
    mocks.remove.mockImplementation(async () => new Response('denied', { status: 403 }))

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting legacy user-scoped app storage' }))
  })

  it('settles simulator sessions whose device stopped before the app delete settles the rest', async () => {
    const order: string[] = []
    mocks.expireSimulatorSessions.mockImplementation(async () => {
      order.push('settle')
    })
    pgClient.query.mockImplementation(async (text: string) => {
      if (text.includes('SELECT owner_org FROM public.apps'))
        return { rows: [{ row: { owner_org: ORG_ID } }] }
      if (text.startsWith('DELETE FROM public.apps'))
        order.push('delete app')
      return { rows: [] }
    })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.expireSimulatorSessions).toHaveBeenCalledWith(expect.anything(), ORG_ID)
    expect(order).toEqual(['settle', 'delete app'])
    expect(pgClient.query.mock.calls.filter(([text]) => text.includes('SELECT owner_org FROM public.apps'))).toHaveLength(1)
  })

  it('still deletes the app when the simulator owner lookup fails', async () => {
    pgClient.query.mockImplementation(async (text) => {
      if (text.includes('SELECT owner_org FROM public.apps'))
        throw new Error('temporary lookup failure')
      return { rows: [] }
    })
    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)
    expect(response.status).toBe(200)
    expect(mocks.expireSimulatorSessions).not.toHaveBeenCalled()
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error settling simulator sessions' }))
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })

  it('still deletes the app when simulator settlement fails', async () => {
    mocks.expireSimulatorSessions.mockRejectedValue(new Error('host down'))

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error settling simulator sessions' }))
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })
})
