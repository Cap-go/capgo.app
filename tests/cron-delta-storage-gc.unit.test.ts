import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  listObjectPage: vi.fn(),
  copyObjectToTrash: vi.fn(),
  deleteObjectKey: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({})),
  closeClient: vi.fn(async () => {}),
  getDrizzleClient: () => ({ execute: mocks.execute }),
}))
vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    listObjectPage: mocks.listObjectPage,
    copyObjectToTrash: mocks.copyObjectToTrash,
    deleteObjectKey: mocks.deleteObjectKey,
  },
}))
vi.mock('../supabase/functions/_backend/utils/hono.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/hono.ts')>(),
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
}))

const { app, DELTA_GC_DELETE_START_WINDOW_MS, DELTA_GC_DELETE_TIMEOUT_MS, DELTA_GC_LEASE_MS, deltaPrefix, selectAgedKeys } = await import('../supabase/functions/_backend/triggers/cron_delta_storage_gc.ts')

const DAY = 24 * 60 * 60 * 1000
const prefix = deltaPrefix('org-1', 'com.example.gc')

function sqlText(query: { queryChunks?: unknown[] }) {
  return JSON.stringify(query.queryChunks ?? query)
}

describe('delta storage GC worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.copyObjectToTrash.mockResolvedValue(true)
    mocks.deleteObjectKey.mockResolvedValue(true)
  })

  it.concurrent('skips objects younger than a day and unparseable dates', () => {
    const now = Date.now()
    expect(selectAgedKeys([
      { key: 'old', lastModified: new Date(now - 2 * DAY) },
      { key: 'fresh', lastModified: new Date(now - 60_000) },
      { key: 'invalid', lastModified: new Date('invalid') },
    ], now)).toEqual(['old'])
  })

  it('copies unreferenced objects first and deletes only the paths the lease allows', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    mocks.listObjectPage.mockResolvedValue({
      objects: [
        { key: `${prefix}a_main.js`, lastModified: old },
        { key: `${prefix}b_index.html`, lastModified: old },
        { key: `${prefix}c_new.js`, lastModified: new Date() },
      ],
      nextToken: 'next-page',
    })
    const calls: string[] = []
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim')) {
        calls.push('claim')
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }] }
      }
      if (text.includes('delta_gc_unreferenced_paths')) {
        calls.push('unreferenced')
        return { rows: [{ paths: [`${prefix}a_main.js`, `${prefix}b_index.html`] }] }
      }
      if (text.includes('delta_gc_begin_delete')) {
        calls.push('begin')
        // A concurrent upload referenced b_index.html: only a_main.js may go.
        return { rows: [{ paths: [`${prefix}a_main.js`] }] }
      }
      if (text.includes('delta_gc_end_delete')) {
        calls.push('end')
        return { rows: [] }
      }
      if (text.includes('delta_gc_finish')) {
        calls.push('finish')
        return { rows: [] }
      }
      throw new Error(`unexpected query ${text}`)
    })
    mocks.copyObjectToTrash.mockImplementation(async (_c: unknown, key: string) => {
      calls.push(`copy:${key.slice(prefix.length)}`)
      return true
    })
    mocks.deleteObjectKey.mockImplementation(async (_c: unknown, key: string) => {
      calls.push(`delete:${key.slice(prefix.length)}`)
      return true
    })

    const response = await app.request('/', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(mocks.listObjectPage).toHaveBeenCalledWith(expect.anything(), prefix, null, 1000)
    expect(calls).toEqual([
      'claim',
      'unreferenced',
      'copy:a_main.js',
      'copy:b_index.html',
      'begin',
      'delete:a_main.js',
      'end',
      'finish',
    ])
    const finish = mocks.execute.mock.calls.map(([query]) => sqlText(query)).find(text => text.includes('delta_gc_finish'))
    expect(finish).toContain('next-page')
  })

  it('binds each path array as one Postgres parameter', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    const keys = [`${prefix}a.js`, `${prefix}b.js`]
    mocks.listObjectPage.mockResolvedValue({ objects: keys.map(key => ({ key, lastModified: old })), nextToken: null })
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }] }
      if (text.includes('delta_gc_unreferenced_paths') || text.includes('delta_gc_begin_delete'))
        return { rows: [{ paths: keys }] }
      return { rows: [] }
    })

    await app.request('/', { method: 'POST' })

    const dialect = new PgDialect()
    const rendered = mocks.execute.mock.calls
      .map(([query]) => dialect.sqlToQuery(query))
      .filter(query => query.sql.includes('delta_gc_unreferenced_paths') || query.sql.includes('delta_gc_begin_delete'))
    expect(rendered).toHaveLength(2)
    for (const query of rendered) {
      expect(query.sql).toMatch(/\$\d+::text\[\]/)
      expect(query.params.some(param => Array.isArray(param) && param.length === 2)).toBe(true)
    }
  })

  it('never deletes when the database refuses the lease', async () => {
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: new Date(Date.now() - 2 * DAY) }], nextToken: null })
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: 'token' }] }
      if (text.includes('delta_gc_unreferenced_paths'))
        return { rows: [{ paths: [`${prefix}a.js`] }] }
      if (text.includes('delta_gc_begin_delete'))
        return { rows: [{ paths: [] }] }
      return { rows: [] }
    })

    const response = await app.request('/', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(mocks.listObjectPage).toHaveBeenCalledWith(expect.anything(), prefix, 'token', 1000)
    expect(mocks.copyObjectToTrash).toHaveBeenCalledOnce()
    expect(mocks.deleteObjectKey).not.toHaveBeenCalled()
  })

  it('bounds every delete and releases the lease even when a delete fails', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: old }], nextToken: null })
    const queries: string[] = []
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      queries.push(text)
      if (text.includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }] }
      if (text.includes('delta_gc_unreferenced_paths') || text.includes('delta_gc_begin_delete'))
        return { rows: [{ paths: [`${prefix}a.js`] }] }
      return { rows: [] }
    })
    mocks.deleteObjectKey.mockRejectedValue(new Error('network'))

    const response = await app.request('/', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(mocks.deleteObjectKey).toHaveBeenCalledWith(expect.anything(), `${prefix}a.js`, DELTA_GC_DELETE_TIMEOUT_MS)
    expect(DELTA_GC_DELETE_START_WINDOW_MS + DELTA_GC_DELETE_TIMEOUT_MS).toBeLessThan(DELTA_GC_LEASE_MS)
    expect(queries.some(text => text.includes('delta_gc_end_delete'))).toBe(true)
  })

  it('restarts the listing after a storage error', async () => {
    mocks.listObjectPage.mockRejectedValue(new Error('list failed'))
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      if (sqlText(query).includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: 'stale' }] }
      return { rows: [] }
    })

    const response = await app.request('/', { method: 'POST' })

    expect(response.status).toBe(200)
    const finish = mocks.execute.mock.calls.map(([query]) => sqlText(query)).find(text => text.includes('delta_gc_finish'))
    expect(finish).toContain('list failed')
    expect(finish).not.toContain('stale')
  })
})
