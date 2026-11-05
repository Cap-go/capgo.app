import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  deleteObjectsWithPrefix: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  removeImageFolder: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/image_storage.ts', () => ({
  removeImageFolder: (...args: unknown[]) => mocks.removeImageFolder(...args),
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

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const APP_ID = 'com.example.app'

// Direct Postgres: the owner_org lookup returns the org, every delete succeeds.
const pgClient = {
  query: vi.fn(async (text: string) => {
    if (text.includes('SELECT owner_org FROM public.apps'))
      return { rows: [{ row: { owner_org: ORG_ID } }] }
    return { rows: [] }
  }),
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
  })

  it('removes app images from R2 and paginates the legacy apps bucket', async () => {
    mocks.removeImageFolder.mockResolvedValue(2)
    mocks.list.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}`)
        return { data: [{ id: null, name: 'versions' }], error: null }
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}/versions`)
        return { data: [file('1.0.0.zip'), file('1.0.1.zip')], error: null }
      return { data: [], error: null }
    })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.removeImageFolder).toHaveBeenCalledWith(expect.anything(), `org/${ORG_ID}/${APP_ID}`)
    // Images no longer go through Supabase Storage.
    expect(mocks.list).not.toHaveBeenCalledWith('images', expect.anything(), expect.anything())
    expect(mocks.remove).not.toHaveBeenCalledWith('images', expect.anything())
    expect(mocks.remove).toHaveBeenCalledWith('apps', [
      `${USER_ID}/${APP_ID}/versions/1.0.0.zip`,
      `${USER_ID}/${APP_ID}/versions/1.0.1.zip`,
    ])
    expect(mocks.cloudlog).toHaveBeenCalledWith(expect.objectContaining({ message: 'deleted app images', count: 2 }))
    expect(mocks.cloudlogErr).not.toHaveBeenCalled()
    expect(pgClient.query).toHaveBeenCalledWith('DELETE FROM public.apps WHERE app_id = $1', [APP_ID])
  })

  it('logs R2 image errors instead of claiming success', async () => {
    mocks.removeImageFolder.mockRejectedValue(new Error('r2 unavailable'))

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting app images' }))
    expect(mocks.cloudlog).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'deleted app images' }))
  })

  it('logs legacy apps bucket errors returned by storage', async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: 'storage unavailable' } })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting legacy user-scoped app storage' }))
  })
})
