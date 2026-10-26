import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  unsettled: [] as Array<{ path: string, referenced: boolean }>,
  restoreFromTrashIfMissing: vi.fn(),
  listObjectPage: vi.fn(),
  copyObjectToTrash: vi.fn(),
  deleteObjectKey: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({})),
  closeClient: vi.fn(async () => {}),
  // Unsettled-delete claims are routed separately so each test opts in.
  getDrizzleClient: () => ({
    execute: (query: { queryChunks?: unknown[] }) => JSON.stringify(query.queryChunks ?? query).includes('delta_gc_claim_unsettled')
      ? Promise.resolve({ rows: mocks.unsettled })
      : mocks.execute(query),
  }),
}))
vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    listObjectPage: mocks.listObjectPage,
    copyObjectToTrash: mocks.copyObjectToTrash,
    deleteObjectKey: mocks.deleteObjectKey,
    restoreFromTrashIfMissing: mocks.restoreFromTrashIfMissing,
  },
}))
vi.mock('../supabase/functions/_backend/utils/hono.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/hono.ts')>(),
  middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => next(),
}))

const { app, DELTA_GC_BUDGET_MS, DELTA_GC_DELETE_START_WINDOW_MS, DELTA_GC_STORAGE_TIMEOUT_MS, DELTA_GC_DELETE_TIMEOUT_MS, DELTA_GC_LEASE_MS, deltaPrefix, selectAgedKeys } = await import('../supabase/functions/_backend/triggers/cron_delta_storage_gc.ts')

const DAY = 24 * 60 * 60 * 1000
const prefix = deltaPrefix('org-1', 'com.example.gc')

function sqlText(query: { queryChunks?: unknown[] }) {
  return JSON.stringify(query.queryChunks ?? query)
}

describe('delta storage GC worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.unsettled = []
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
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
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
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
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

  it('deletes a page of a deleted app former-owner prefix and keeps the cursor', async () => {
    const orphanPrefix = 'orgs/former-org/apps/com.example.gone/'
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${orphanPrefix}delta/a.js`, lastModified: new Date() }], nextToken: 'more' })
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [{ prefix: orphanPrefix, list_cursor: null }] }
      return { rows: [] }
    })

    const response = await app.request('/', { method: 'POST' })

    expect(response.status).toBe(200)
    expect(mocks.listObjectPage).toHaveBeenCalledWith(expect.anything(), orphanPrefix, null, 1000)
    expect(mocks.deleteObjectKey).toHaveBeenCalledWith(expect.anything(), `${orphanPrefix}delta/a.js`, DELTA_GC_STORAGE_TIMEOUT_MS)
    expect(DELTA_GC_BUDGET_MS + DELTA_GC_STORAGE_TIMEOUT_MS).toBeLessThan(15_000 - 2_000)
    const finish = mocks.execute.mock.calls.map(([query]) => sqlText(query)).find(text => text.includes('delta_gc_finish_orphan_prefix'))
    expect(finish).toContain('more')
  })

  it('lists a page again when an allowed delete fails', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: old }], nextToken: null })
    mocks.deleteObjectKey.mockResolvedValue(false)
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
      if (text.includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: 'token' }] }
      if (text.includes('delta_gc_unreferenced_paths') || text.includes('delta_gc_begin_delete'))
        return { rows: [{ paths: [`${prefix}a.js`] }] }
      return { rows: [] }
    })

    await app.request('/', { method: 'POST' })

    const finish = mocks.execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query))
      .find(query => query.sql.includes('delta_gc_finish('))
    expect(finish?.params).toEqual(['com.example.gc', 'token', false])
  })

  it('keeps an orphan prefix task when a delete of its page fails', async () => {
    const orphanPrefix = 'orgs/former-org/apps/com.example.gone/'
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${orphanPrefix}delta/a.js`, lastModified: new Date() }], nextToken: null })
    mocks.deleteObjectKey.mockResolvedValue(false)
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      if (sqlText(query).includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [{ prefix: orphanPrefix, list_cursor: null }] }
      return { rows: [] }
    })

    await app.request('/', { method: 'POST' })

    const dialect = new PgDialect()
    const finish = mocks.execute.mock.calls
      .map(([query]) => dialect.sqlToQuery(query))
      .find(query => query.sql.includes('delta_gc_finish_orphan_prefix'))
    expect(finish?.params).toEqual([orphanPrefix, null, false])
  })

  it('records unconfirmed deletes and restores a reused, missing object later', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: old }], nextToken: null })
    mocks.deleteObjectKey.mockResolvedValue(false)
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
      if (text.includes('delta_gc_claim'))
        return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }] }
      if (text.includes('delta_gc_unreferenced_paths') || text.includes('delta_gc_begin_delete'))
        return { rows: [{ paths: [`${prefix}a.js`] }] }
      return { rows: [] }
    })

    await app.request('/', { method: 'POST' })
    const recorded = mocks.execute.mock.calls
      .map(([query]) => new PgDialect().sqlToQuery(query))
      .find(query => query.sql.includes('delta_gc_record_unsettled'))
    expect(recorded?.params).toEqual(['com.example.gc', [`${prefix}a.js`]])

    // A later run: the key was reused by an upload and the late delete removed it.
    vi.clearAllMocks()
    mocks.unsettled = [{ path: `${prefix}a.js`, referenced: true }, { path: `${prefix}b.js`, referenced: false }]
    mocks.restoreFromTrashIfMissing.mockResolvedValue('restored')
    mocks.execute.mockResolvedValue({ rows: [] })
    await app.request('/', { method: 'POST' })

    expect(mocks.restoreFromTrashIfMissing).toHaveBeenCalledOnce()
    expect(mocks.restoreFromTrashIfMissing).toHaveBeenCalledWith(expect.anything(), `${prefix}a.js`)
    const settled = mocks.execute.mock.calls.map(([query]) => sqlText(query)).filter(text => text.includes('delta_gc_settle'))
    expect(settled).toHaveLength(2)
  })

  it('never deletes when the database refuses the lease', async () => {
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: new Date(Date.now() - 2 * DAY) }], nextToken: null })
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
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

  it('bounds every delete and keeps the lease when a delete is not confirmed', async () => {
    const old = new Date(Date.now() - 2 * DAY)
    mocks.listObjectPage.mockResolvedValue({ objects: [{ key: `${prefix}a.js`, lastModified: old }], nextToken: null })
    const queries: string[] = []
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      const text = sqlText(query)
      if (text.includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
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
    // The lease runs to its end: an unconfirmed delete may still be applied.
    expect(queries.some(text => text.includes('delta_gc_end_delete'))).toBe(false)
  })

  it('stops starting storage work for the whole run after a copy times out', async () => {
    vi.useFakeTimers()
    try {
      const old = new Date(Date.now() - 2 * DAY)
      // More than one delete batch, and a second claimed app plus an orphan prefix.
      const keys = Array.from({ length: 150 }, (_, index) => `${prefix}f${index}.js`)
      mocks.listObjectPage.mockResolvedValue({ objects: keys.map(key => ({ key, lastModified: old })), nextToken: null })
      mocks.copyObjectToTrash.mockReturnValue(new Promise(() => {}))
      mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
        const text = sqlText(query)
        if (text.includes('delta_gc_claim_orphan_prefixes'))
          return { rows: [{ prefix: 'orgs/former/apps/gone/', list_cursor: null }] }
        if (text.includes('delta_gc_claim'))
          return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }, { app_id: 'com.example.other', list_org: 'org-1', list_cursor: null }] }
        if (text.includes('delta_gc_unreferenced_paths'))
          return { rows: [{ paths: keys }] }
        return { rows: [] }
      })

      const pending = app.request('/', { method: 'POST' })
      await vi.advanceTimersByTimeAsync(DELTA_GC_STORAGE_TIMEOUT_MS + 10)
      await pending

      // One concurrency window was started; nothing after the first timeout:
      // no second batch, no second app, no orphan prefix.
      expect(mocks.copyObjectToTrash).toHaveBeenCalledTimes(25)
      expect(mocks.listObjectPage).toHaveBeenCalledOnce()
      expect(mocks.deleteObjectKey).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('fails a stalled listing within the storage timeout', async () => {
    vi.useFakeTimers()
    try {
      mocks.listObjectPage.mockReturnValue(new Promise(() => {}))
      mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
        const text = sqlText(query)
        if (text.includes('delta_gc_claim_orphan_prefixes'))
          return { rows: [] }
        if (text.includes('delta_gc_claim'))
          return { rows: [{ app_id: 'com.example.gc', list_org: 'org-1', list_cursor: null }] }
        return { rows: [] }
      })

      const pending = app.request('/', { method: 'POST' })
      await vi.advanceTimersByTimeAsync(DELTA_GC_STORAGE_TIMEOUT_MS + 10)
      const response = await pending

      expect(response.status).toBe(200)
      const finish = mocks.execute.mock.calls.map(([query]) => sqlText(query)).find(text => text.includes('delta_gc_finish('))
      expect(finish).toContain('R2 listing timed out')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('restarts the listing after a storage error', async () => {
    mocks.listObjectPage.mockRejectedValue(new Error('list failed'))
    mocks.execute.mockImplementation(async (query: { queryChunks?: unknown[] }) => {
      if (sqlText(query).includes('delta_gc_claim_orphan_prefixes'))
        return { rows: [] }
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
