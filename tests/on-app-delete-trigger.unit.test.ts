import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
const cleanupStarted = vi.fn()

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    deleteObjectsWithPrefix: vi.fn(async () => 0),
  },
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: pgQuery })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: () => ({
    storage: {
      from: () => ({
        list: async () => ({ data: [] }),
        remove: async () => ({ error: null }),
      }),
    },
  }),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
    triggerValidator: () => async (c: any, next: () => Promise<void>) => {
      const body = await c.req.json()
      c.set('webhookBody', body.record)
      await next()
    },
  }
})

vi.mock('../supabase/functions/_backend/utils/utils.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/utils.ts')
  return {
    ...actual,
    backgroundTask: async (_c: unknown, task: Promise<unknown>) => {
      cleanupStarted()
      return task
    },
  }
})

const { app } = await import('../supabase/functions/_backend/triggers/on_app_delete.ts')

describe('on_app_delete trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
  })

  it('records deleted_apps then runs storage and row cleanup', async () => {
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'DELETE',
        table: 'apps',
        record: {
          app_id: 'com.test.delete',
          owner_org: 'org-1',
          created_at: '2026-01-01T00:00:00.000Z',
          transfer_history: [],
        },
      }),
    })

    expect(response.status).toBe(200)
    const statements = pgQuery.mock.calls.map(([sql]) => sql)
    const inserts = statements.filter(sql => sql.includes('INSERT INTO public.deleted_apps'))
    expect(inserts).toHaveLength(1)
    expect(pgQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO public.deleted_apps'))?.[1])
      .toEqual(['com.test.delete', '2026-01-01T00:00:00.000Z', 'org-1', '[]'])
    expect(cleanupStarted).toHaveBeenCalledOnce()
    expect(statements.indexOf(inserts[0])).toBe(0)
    expect(statements.at(-1)).toBe('DELETE FROM public.app_versions WHERE app_id = $1')
    expect(statements.filter(sql => sql.startsWith('DELETE FROM public.'))).toHaveLength(9)
  })
})
