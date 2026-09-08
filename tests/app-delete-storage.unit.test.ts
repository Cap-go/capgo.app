import { beforeEach, describe, expect, it, vi } from 'vitest'

const moveObjectsWithPrefixToTrash = vi.fn()
const deleteObjectsWithPrefix = vi.fn()

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    moveObjectsWithPrefixToTrash,
    deleteObjectsWithPrefix,
  },
  TrashMoveError: class TrashMoveError extends Error {
    failedKeys: string[]
    prefix: string
    constructor(prefix: string, failedKeys: string[]) {
      super('trash failed')
      this.prefix = prefix
      this.failedKeys = failedKeys
    }
  },
}))

const checkPermission = vi.fn(async () => true)
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission,
}))

const deletedTables: string[] = []
const insert = vi.fn(async () => ({ error: null }))
const deleteEq = vi.fn(async () => ({ error: null }))
const storageList = vi.fn(async () => ({ data: [] }))
const storageRemove = vi.fn(async () => ({ error: null }))
const storageFrom = vi.fn(() => ({
  list: storageList,
  remove: storageRemove,
}))
const from = vi.fn((table: string) => {
  return {
    insert,
    delete: () => {
      deletedTables.push(table)
      return { eq: deleteEq }
    },
  }
})
const supabaseAdmin = vi.fn(() => ({
  from,
  storage: { from: storageFrom },
}))

const apiDeleteEq = vi.fn(async () => ({ error: null }))
const apiDelete = vi.fn(() => ({ eq: apiDeleteEq }))
const apiSelectSingle = vi.fn(async () => ({ data: { owner_org: 'org-1' }, error: null }))
const apiSelectEq = vi.fn(() => ({ single: apiSelectSingle }))
const apiSelect = vi.fn(() => ({ eq: apiSelectEq }))
const apiFrom = vi.fn(() => ({
  select: apiSelect,
  delete: apiDelete,
}))
const supabaseApikey = vi.fn(() => ({
  from: apiFrom,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
  supabaseApikey,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const { app } = await import('../supabase/functions/_backend/triggers/on_app_delete.ts')
const { deleteApp } = await import('../supabase/functions/_backend/public/app/delete.ts')
const { s3: pluginRuntimeS3 } = await import('../supabase/functions/_backend/plugin_runtime/utils/s3.ts')

function deletePayload(record: Record<string, unknown>) {
  return {
    type: 'DELETE',
    table: 'apps',
    schema: 'public',
    old_record: record,
  }
}

function makeDeleteAppContext() {
  return {
    get: (key: string) => key === 'requestId' ? 'req-delete-app' : undefined,
    json: vi.fn((body: unknown) => ({ body })),
  } as any
}

describe('on_app_delete storage cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    moveObjectsWithPrefixToTrash.mockResolvedValue(2)
    deleteEq.mockResolvedValue({ error: null })
    storageList.mockResolvedValue({ data: [] })
  })

  it('moves app storage to trash instead of permanent prefix delete', async () => {
    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(deletePayload({
        app_id: 'com.test.app',
        owner_org: 'org-1',
        created_at: '2026-01-01T00:00:00Z',
      })),
    })

    expect(response.status).toBe(200)
    expect(moveObjectsWithPrefixToTrash).toHaveBeenCalledWith(
      expect.anything(),
      'orgs/org-1/apps/com.test.app/',
    )
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
  })

  it('fails closed when trash move fails', async () => {
    moveObjectsWithPrefixToTrash.mockRejectedValue(new Error('trash failed'))

    const response = await app.request('http://localhost/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(deletePayload({
        app_id: 'com.test.app',
        owner_org: 'org-1',
        created_at: '2026-01-01T00:00:00Z',
      })),
    })

    expect(response.status).toBe(500)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
  })
})

describe('public deleteApp storage contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    deletedTables.length = 0
    checkPermission.mockResolvedValue(true)
    apiDeleteEq.mockResolvedValue({ error: null })
    deleteEq.mockResolvedValue({ error: null })
    apiSelectSingle.mockResolvedValue({ data: { owner_org: 'org-1' }, error: null })
    storageList.mockResolvedValue({ data: [] })
  })

  it('deletes the app row without direct R2 trash or permanent delete calls', async () => {
    const response = await deleteApp(
      makeDeleteAppContext(),
      'com.test.app',
      { key: 'capgo_test_key' } as any,
    )

    expect(response).toEqual({ body: { status: 'ok' } })
    expect(moveObjectsWithPrefixToTrash).not.toHaveBeenCalled()
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
    expect(deletedTables).toContain('apps')
    expect(deleteEq).toHaveBeenCalledWith('app_id', 'com.test.app')
  })
})

describe('plugin_runtime s3 surface', () => {
  it('omits trash and permanent delete helpers from the hot-path export', () => {
    expect(pluginRuntimeS3).not.toHaveProperty('deleteObjectsWithPrefix')
    expect(pluginRuntimeS3).not.toHaveProperty('moveObjectToTrash')
    expect(pluginRuntimeS3).not.toHaveProperty('moveObjectsWithPrefixToTrash')
  })
})
