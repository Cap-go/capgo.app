import { readFileSync } from 'node:fs'
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

const insert = vi.fn(async () => ({ error: null }))
const deleteEq = vi.fn(async () => ({ error: null }))
const deleteFn = vi.fn(() => ({ eq: deleteEq }))
const storageList = vi.fn(async () => ({ data: [] }))
const storageRemove = vi.fn(async () => ({ error: null }))
const storageFrom = vi.fn(() => ({
  list: storageList,
  remove: storageRemove,
}))
const from = vi.fn(() => ({
  insert,
  delete: deleteFn,
}))
const supabaseAdmin = vi.fn(() => ({
  from,
  storage: { from: storageFrom },
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
  }
})

const { app } = await import('../supabase/functions/_backend/triggers/on_app_delete.ts')

function deletePayload(record: Record<string, unknown>) {
  return {
    type: 'DELETE',
    table: 'apps',
    schema: 'public',
    old_record: record,
  }
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

describe('product delete source audit', () => {
  it('public app delete uses trash helper only', () => {
    const source = readFileSync('./supabase/functions/_backend/public/app/delete.ts', 'utf8')
    expect(source).toContain('moveObjectsWithPrefixToTrash')
    expect(source).not.toContain('deleteObjectsWithPrefix')
    expect(source).toContain('TrashMoveError')
  })

  it('plugin_runtime s3 omits permanent delete helpers', () => {
    const source = readFileSync('./supabase/functions/_backend/plugin_runtime/utils/s3.ts', 'utf8')
    expect(source).not.toContain('deleteObjectsWithPrefix')
    expect(source).not.toContain('moveObjectToTrash')
    expect(source).not.toContain('moveObjectsWithPrefixToTrash')
  })
})
