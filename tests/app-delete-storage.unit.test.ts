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
const APP_ID = 'com.example.app'

// Direct Postgres: every delete succeeds.
const pgClient = {
  query: vi.fn(async () => ({ rows: [] })),
}

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getDrizzleClient: vi.fn(),
  getPgClient: vi.fn(async () => pgClient),
  withPgTransaction: async (_pg: unknown, run: (client: unknown) => Promise<unknown>) => run(pgClient),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: (bucket: string) => ({
        list: (prefix: string, options: unknown) => mocks.list(bucket, prefix, options),
        remove: (paths: string[]) => mocks.remove(bucket, paths),
      }),
    },
  }),
}))

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
    mocks.checkPermission.mockResolvedValue(true)
    mocks.deleteObjectsWithPrefix.mockResolvedValue(0)
    mocks.remove.mockResolvedValue({ data: [], error: null })
    mocks.list.mockResolvedValue({ data: [], error: null })
    mocks.removeImageFolder.mockResolvedValue(0)
    mocks.expireSimulatorSessions.mockResolvedValue(undefined)
  })

  it('leaves R2 cleanup to on_app_delete and paginates the legacy apps bucket', async () => {
    mocks.list.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}`)
        return { data: [{ id: null, name: 'versions' }], error: null }
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}/versions`)
        return { data: [file('1.0.0.zip'), file('1.0.1.zip')], error: null }
      return { data: [], error: null }
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
    expect(mocks.cloudlogErr).not.toHaveBeenCalled()
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })

  it('logs legacy apps bucket errors returned by storage', async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: 'storage unavailable' } })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.remove).not.toHaveBeenCalled()
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
  })

  it('still deletes the app when simulator settlement fails', async () => {
    mocks.expireSimulatorSessions.mockRejectedValue(new Error('host down'))

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error settling simulator sessions' }))
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })
})
