import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  deleteObjectsWithPrefix: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
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

function createTableMock() {
  const query: Record<string, any> = {}
  query.select = vi.fn(() => query)
  query.delete = vi.fn(() => query)
  query.eq = vi.fn(() => query)
  query.single = vi.fn(async () => ({ data: { owner_org: ORG_ID }, error: null }))
  // Awaiting a delete chain resolves to a successful PostgREST response.
  query.then = (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null })
  return query
}

const ORG_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'
const APP_ID = 'com.example.app'

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseApikey: () => ({ from: () => createTableMock() }),
  supabaseAdmin: () => ({
    from: () => createTableMock(),
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
  })

  it('paginates and recurses before removing every listed object', async () => {
    const firstImagesPage = Array.from({ length: 100 }, (_, i) => file(`img-${i}`))
    mocks.list.mockImplementation(async (bucket: string, prefix: string, options: { offset: number }) => {
      if (bucket === 'images' && prefix === `org/${ORG_ID}/${APP_ID}`)
        return { data: options.offset === 0 ? firstImagesPage : [file('icon')], error: null }
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}`)
        return { data: [{ id: null, name: 'versions' }], error: null }
      if (bucket === 'apps' && prefix === `${USER_ID}/${APP_ID}/versions`)
        return { data: [file('1.0.0.zip'), file('1.0.1.zip')], error: null }
      return { data: [], error: null }
    })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.list).toHaveBeenCalledWith('images', `org/${ORG_ID}/${APP_ID}`, { limit: 100, offset: 0 })
    expect(mocks.list).toHaveBeenCalledWith('images', `org/${ORG_ID}/${APP_ID}`, { limit: 100, offset: 100 })
    const removedImages = mocks.remove.mock.calls.filter(([bucket]) => bucket === 'images').flatMap(([, paths]) => paths)
    expect(removedImages).toHaveLength(101)
    expect(removedImages).toContain(`org/${ORG_ID}/${APP_ID}/icon`)
    expect(mocks.remove).toHaveBeenCalledWith('apps', [
      `${USER_ID}/${APP_ID}/versions/1.0.0.zip`,
      `${USER_ID}/${APP_ID}/versions/1.0.1.zip`,
    ])
    expect(mocks.cloudlogErr).not.toHaveBeenCalled()
  })

  it('logs list errors returned by storage instead of claiming success', async () => {
    mocks.list.mockResolvedValue({ data: null, error: { message: 'storage unavailable' } })

    const response = await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(response.status).toBe(200)
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting app images' }))
    expect(mocks.cloudlog).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'deleted app images' }))
  })

  it('logs remove errors returned by storage instead of claiming success', async () => {
    mocks.list.mockImplementation(async (bucket: string) => ({
      data: bucket === 'images' ? [file('icon')] : [],
      error: null,
    }))
    mocks.remove.mockResolvedValue({ data: null, error: { message: 'remove failed' } })

    await deleteApp(createContext(), APP_ID, { key: 'test-key', user_id: USER_ID } as any)

    expect(mocks.cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error deleting app images' }))
    expect(mocks.cloudlog).not.toHaveBeenCalledWith(expect.objectContaining({ message: 'deleted app images' }))
  })
})
