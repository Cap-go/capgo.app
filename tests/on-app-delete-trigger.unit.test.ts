import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgQuery = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
const cleanupStarted = vi.fn()

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
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
      if (body.occurred_at)
        c.set('webhookOccurredAt', body.occurred_at)
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
    // Storage finalization runs first, then deleted_apps, then the row cleanup.
    const insertIndex = statements.indexOf(inserts[0])
    expect(insertIndex).toBeLessThan(statements.findIndex(sql => sql.startsWith('DELETE FROM public.')))
    expect(statements.slice(0, insertIndex).every(sql => !sql.startsWith('DELETE FROM public.'))).toBe(true)
    expect(statements.at(-1)).toBe('DELETE FROM public.app_versions WHERE app_id = $1')
    expect(statements.filter(sql => sql.startsWith('DELETE FROM public.'))).toHaveLength(9)
  })

  it('records the storage hours from the last refresh up to the deletion time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string) => {
        // close_app_storage_lifetimes closed the bundle when the app was deleted, at 06:00.
        if (sql.includes('max(timestamp) AS deleted_at'))
          return { rows: [{ deleted_at: '2026-01-10T06:00:00.000Z' }], rowCount: 1 } as any
        if (sql.includes('FROM public.version_meta'))
          return { rows: [
            { timestamp: '2026-01-10T00:00:00.000Z', version_id: 1, size: 100 },
            { timestamp: '2026-01-10T06:00:00.000Z', version_id: 1, size: -100 },
          ], rowCount: 2 } as any
        if (sql.includes('billing_cycle_for_anchor'))
          return { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
        return { rows: [], rowCount: 0 }
      })

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
      const replace = pgQuery.mock.calls.find(([sql]) => sql.includes('replace_app_storage_hourly'))
      // Whole-cycle segment: the app existed since the cycle start.
      expect(replace?.[1]?.slice(0, 7)).toEqual(['com.test.delete', 'org-1', '2026-01-01', '2026-02-01', '2026-02-01', '2026-01-01T00:00:00.000Z', true])
      // 100 bytes for the 6 hours between the upload and the deletion, not up to the handler's
      // clock (12:00): the queue delay is not billed.
      expect(JSON.parse(replace?.[1]?.[7] as string)).toEqual([{ cycle_start: '2026-01-01', date: '2026-01-10', storage_byte_hours: 600 }])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('fails the job without recording deleted_apps when storage finalization fails', async () => {
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM public.version_meta'))
        throw new Error('connection reset')
      return { rows: [], rowCount: 0 }
    })
    try {
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

      // A non-2xx response leaves the queue message for a retry.
      expect(response.status).toBeGreaterThanOrEqual(500)
      expect(pgQuery.mock.calls.some(([sql]) => sql.includes('INSERT INTO public.deleted_apps'))).toBe(false)
      expect(cleanupStarted).not.toHaveBeenCalled()
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
    }
  })

  it('also finalizes the previous cycle when the app is deleted right after a rollover', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-01T12:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('max(timestamp) AS deleted_at'))
          return { rows: [{ deleted_at: '2026-02-01T06:00:00.000Z' }], rowCount: 1 } as any
        if (sql.includes('FROM public.version_meta'))
          return { rows: [
            { timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 },
            { timestamp: '2026-02-01T06:00:00.000Z', version_id: 1, size: -100 },
          ], rowCount: 2 } as any
        if (sql.includes('billing_cycle_for_anchor')) {
          const before = new Date(String(params?.[1])).getTime()
          return before <= Date.parse('2026-02-01T00:00:00.000Z')
            ? { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
            : { rows: [{ cycle_start: '2026-02-01T00:00:00.000Z', cycle_end: '2026-03-01T00:00:00.000Z' }], rowCount: 1 } as any
        }
        return { rows: [], rowCount: 0 }
      })

      const response = await app.request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'DELETE',
          table: 'apps',
          record: { app_id: 'com.test.delete', owner_org: 'org-1', created_at: '2026-01-01T00:00:00.000Z', transfer_history: [] },
        }),
      })

      expect(response.status).toBe(200)
      const replaced = pgQuery.mock.calls
        .filter(([sql]) => sql.includes('replace_app_storage_hourly'))
        .map(([, params]) => [params?.[2], JSON.parse(params?.[7] as string)])
      expect(replaced).toEqual([
        // The deletion's cycle: 6 hours on February 1st.
        ['2026-02-01', [{ cycle_start: '2026-02-01', date: '2026-02-01', storage_byte_hours: 600 }]],
        // The previous cycle up to its end: all of January 31st.
        ['2026-01-01', [{ cycle_start: '2026-01-01', date: '2026-01-31', storage_byte_hours: 2400 }]],
      ])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('finalizes up to the event time and the former owner after a transfer, ignoring a recreated app', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-12T00:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('max(timestamp) AS deleted_at'))
          throw new Error('the event time must be used, not the closing events')
        if (sql.includes('FROM public.version_meta')) {
          const until = Date.parse(String(params?.[1]))
          const all = [
            { timestamp: '2026-01-10T00:00:00.000Z', version_id: 1, size: 100 },
            { timestamp: '2026-01-10T12:00:00.000Z', version_id: 1, size: -100 },
            // A recreated app ID's bundle, after the deletion.
            { timestamp: '2026-01-11T00:00:00.000Z', version_id: 2, size: 999 },
          ]
          const rows = all.filter(row => Date.parse(row.timestamp) < until)
          return { rows, rowCount: rows.length } as any
        }
        if (sql.includes('billing_cycle_for_anchor'))
          return { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
        return { rows: [], rowCount: 0 }
      })

      const response = await app.request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'DELETE',
          table: 'apps',
          occurred_at: '2026-01-10T12:00:00.000Z',
          record: {
            app_id: 'com.test.delete',
            owner_org: 'org-new',
            created_at: '2026-01-01T00:00:00.000Z',
            transfer_history: [{ transferred_at: '2026-01-10T06:00:00.000Z', transferred_from: 'org-old', transferred_to: 'org-new' }],
          },
        }),
      })

      expect(response.status).toBe(200)
      const replaced = pgQuery.mock.calls
        .filter(([sql]) => sql.includes('replace_app_storage_hourly'))
        .map(([, params]) => [params?.[1], params?.[5], JSON.parse(params?.[7] as string)])
      expect(replaced).toEqual([
        // The new owner, from the transfer to the deletion: 6 hours.
        ['org-new', '2026-01-10T06:00:00.000Z', [{ cycle_start: '2026-01-01', date: '2026-01-10', storage_byte_hours: 600 }]],
        // The former owner, up to the transfer: 6 hours.
        ['org-old', '2026-01-01T00:00:00.000Z', [{ cycle_start: '2026-01-01', date: '2026-01-10', storage_byte_hours: 600 }]],
      ])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('finalizes the former owner\'s previous cycle when the transfer follows its rollover', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM public.version_meta')) {
          const until = Date.parse(String(params?.[1]))
          const rows = [{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }]
            .filter(row => Date.parse(row.timestamp) < until)
          return { rows, rowCount: rows.length } as any
        }
        if (sql.includes('billing_cycle_for_anchor')) {
          const before = Date.parse(String(params?.[1]))
          return before <= Date.parse('2026-02-01T00:00:00.000Z')
            ? { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
            : { rows: [{ cycle_start: '2026-02-01T00:00:00.000Z', cycle_end: '2026-03-01T00:00:00.000Z' }], rowCount: 1 } as any
        }
        return { rows: [], rowCount: 0 }
      })

      const response = await app.request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'DELETE',
          table: 'apps',
          occurred_at: '2026-02-01T12:00:00.000Z',
          record: {
            app_id: 'com.test.delete',
            owner_org: 'org-new',
            created_at: '2026-01-01T00:00:00.000Z',
            transfer_history: [{ transferred_at: '2026-02-01T06:00:00.000Z', transferred_from: 'org-old', transferred_to: 'org-new' }],
          },
        }),
      })

      expect(response.status).toBe(200)
      const replaced = pgQuery.mock.calls
        .filter(([sql]) => sql.includes('replace_app_storage_hourly'))
        .map(([, params]) => [params?.[1], params?.[2], JSON.parse(params?.[7] as string).reduce((sum: number, row: { storage_byte_hours: number }) => sum + row.storage_byte_hours, 0)])
      expect(replaced).toEqual(expect.arrayContaining([
        // The former owner's January cycle up to its end: Jan 31, 24 hours.
        ['org-old', '2026-01-01', 2400],
        // The former owner's February cycle up to the transfer: 6 hours.
        ['org-old', '2026-02-01', 600],
        // The new owner, from the transfer to the deletion: 6 hours.
        ['org-new', '2026-02-01', 600],
      ]))
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it.each([
    ['never finalized', null, true],
    ['finalized after the transfer', '2026-01-02T00:00:00.000Z', false],
  ] as const)('finalizes the former owner long after the transfer when %s', async (_label, finalizedAt, expectFormer) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-31T00:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM public.daily_storage_hourly_refreshes'))
          return { rows: finalizedAt ? [{ written_at: finalizedAt }] : [], rowCount: finalizedAt ? 1 : 0 } as any
        if (sql.includes('FROM public.version_meta')) {
          const until = Date.parse(String(params?.[1]))
          const rows = [{ timestamp: '2026-01-01T00:00:00.000Z', version_id: 1, size: 100 }]
            .filter(row => Date.parse(row.timestamp) < until)
          return { rows, rowCount: rows.length } as any
        }
        if (sql.includes('billing_cycle_for_anchor'))
          return { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
        return { rows: [], rowCount: 0 }
      })

      const response = await app.request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'DELETE',
          table: 'apps',
          occurred_at: '2026-01-30T00:00:00.000Z',
          record: {
            app_id: 'com.test.delete',
            owner_org: 'org-new',
            created_at: '2026-01-01T00:00:00.000Z',
            transfer_history: [{ transferred_at: '2026-01-01T12:00:00.000Z', transferred_from: 'org-old', transferred_to: 'org-new' }],
          },
        }),
      })

      expect(response.status).toBe(200)
      const former = pgQuery.mock.calls
        .filter(([sql, params]) => sql.includes('replace_app_storage_hourly') && params?.[1] === 'org-old')
        .map(([, params]) => JSON.parse(params?.[7] as string))
      // 29 days after the transfer: still finalized once (12 hours), never again afterwards.
      expect(former).toEqual(expectFormer ? [[{ cycle_start: '2026-01-01', date: '2026-01-01', storage_byte_hours: 1200 }]] : [])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('retries both former-owner cycles when the previous one fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-02T00:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM public.version_meta')) {
          const until = Date.parse(String(params?.[1]))
          const rows = [{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }]
            .filter(row => Date.parse(row.timestamp) < until)
          return { rows, rowCount: rows.length } as any
        }
        if (sql.includes('billing_cycle_for_anchor')) {
          const before = Date.parse(String(params?.[1]))
          return before <= Date.parse('2026-02-01T00:00:00.000Z')
            ? { rows: [{ cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-01T00:00:00.000Z' }], rowCount: 1 } as any
            : { rows: [{ cycle_start: '2026-02-01T00:00:00.000Z', cycle_end: '2026-03-01T00:00:00.000Z' }], rowCount: 1 } as any
        }
        // The former owner's January cycle cannot be written.
        if (sql.includes('replace_app_storage_hourly') && params?.[1] === 'org-old' && params?.[2] === '2026-01-01')
          throw new Error('connection reset')
        return { rows: [], rowCount: 0 }
      })

      const response = await app.request('http://local/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'DELETE',
          table: 'apps',
          occurred_at: '2026-02-01T12:00:00.000Z',
          record: {
            app_id: 'com.test.delete',
            owner_org: 'org-new',
            created_at: '2026-01-01T00:00:00.000Z',
            transfer_history: [{ transferred_at: '2026-02-01T06:00:00.000Z', transferred_from: 'org-old', transferred_to: 'org-new' }],
          },
        }),
      })

      // The job fails for a retry, and the former owner's February cycle (whose watermark marks the
      // finalization done) was not written before the January one succeeded.
      expect(response.status).toBeGreaterThanOrEqual(500)
      const formerFebruary = pgQuery.mock.calls.filter(([sql, params]) => sql.includes('replace_app_storage_hourly') && params?.[1] === 'org-old' && params?.[2] === '2026-02-01')
      expect(formerFebruary).toHaveLength(0)
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })
})
