import { beforeEach, describe, expect, it, vi } from 'vitest'

const appExists = { value: false }
const claimOverride: { value: string | null } = { value: null }
async function defaultPgQuery(sql: string, _params?: unknown[]) {
  // The SQL functions decide on the primary whether the app id exists again in the org.
  if (sql.includes('begin_app_storage_cleanup_pass'))
    return { rows: [{ claim: claimOverride.value ?? (appExists.value ? 'recreated' : 'claimed') }], rowCount: 1 }
  if (sql.includes('finish_app_storage_cleanup_pass')) {
    const done = (_params as unknown[])[3] as boolean
    return { rows: [{ msg_id: done || appExists.value ? null : '42' }], rowCount: 1 }
  }
  return { rows: [], rowCount: 0 }
}
const pgQuery = vi.fn(defaultPgQuery)
const cleanupStarted = vi.fn()
const deleteObjectsWithPrefix = vi.fn()
const removeImageFolder = vi.fn()
const cloudlogErr = vi.fn()

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: (...args: unknown[]) => cloudlogErr(...args),
}))

vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  s3: {
    deleteObjectsWithPrefix: (...args: unknown[]) => deleteObjectsWithPrefix(...args),
  },
}))

vi.mock('../supabase/functions/_backend/utils/image_storage.ts', () => ({
  removeImageFolder: (...args: unknown[]) => removeImageFolder(...args),
}))

interface StorageEventRow { timestamp: string, version_id: number, size: number }

// Tests describe version_meta as events; the refresh reads them folded into one lifetime per bundle.
function foldStorageEvents(events: StorageEventRow[]) {
  const lifetimes = new Map<number, { version_id: number, added_at: string | null, size: number | null, removed_at: string | null }>()
  for (const event of [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    const lifetime = lifetimes.get(event.version_id) ?? { version_id: event.version_id, added_at: null, size: null, removed_at: null }
    if (event.size > 0 && lifetime.added_at === null) {
      lifetime.added_at = event.timestamp
      lifetime.size = event.size
    }
    else if (event.size < 0 && lifetime.removed_at === null) {
      lifetime.removed_at = event.timestamp
    }
    lifetimes.set(event.version_id, lifetime)
  }
  return [...lifetimes.values()]
}

async function queryThroughMock(sql: string, params?: unknown[]) {
  const result = await pgQuery(sql, params)
  // Test-specific mocks only describe storage reads; the cleanup claim keeps its default answer.
  if (result.rows.length === 0 && (sql.includes('begin_app_storage_cleanup_pass') || sql.includes('finish_app_storage_cleanup_pass')))
    return defaultPgQuery(sql, params)
  if (sql.includes('FROM public.version_meta vm') && result.rows.some(row => 'timestamp' in (row as object)))
    return { rows: foldStorageEvents(result.rows as unknown as StorageEventRow[]), rowCount: result.rowCount }
  return result
}

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: queryThroughMock })),
  closeClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', async () => {
  const actual = await vi.importActual('../supabase/functions/_backend/utils/hono.ts')
  return {
    ...actual,
    middlewareAPISecret: async (_c: unknown, next: () => Promise<void>) => await next(),
    triggerValidator: () => async (c: any, next: () => Promise<void>) => {
      const body = await c.req.raw.clone().json()
      c.set('webhookBody', body.old_record ?? body.record)
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

const { app, MAX_STORAGE_CLEANUP_PASSES, STORAGE_CLEANUP_BUDGET_MS, STORAGE_CLEANUP_LEASE_SECONDS, STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS } = await import('../supabase/functions/_backend/triggers/on_app_delete.ts')

const record = {
  app_id: 'com.test.delete',
  owner_org: 'org-1',
  created_at: '2026-01-01T00:00:00.000Z',
  transfer_history: [],
}

function sendTrigger(extra: Record<string, unknown> = {}) {
  return app.request('http://local/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'DELETE', table: 'apps', schema: 'public', record: null, old_record: record, occurred_at: '2026-01-02T00:00:00.000Z', ...extra }),
  })
}

function sqlStatements() {
  return pgQuery.mock.calls.map(([sql]) => sql)
}

function finishCalls() {
  return pgQuery.mock.calls.filter(([sql]) => sql.includes('finish_app_storage_cleanup_pass'))
}

/** finish calls that asked for a next pass (done = false). */
function requeueCalls() {
  return finishCalls().filter(([, params]) => (params as unknown[])[3] === false)
}

describe('on_app_delete trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgQuery.mockImplementation(defaultPgQuery)
    appExists.value = false
    claimOverride.value = null
    vi.stubEnv('CAPGO_PREVENT_BACKGROUND_FUNCTIONS', 'true')
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 3, failed: 0, done: true })
    removeImageFolder.mockResolvedValue(0)
  })

  it('records deleted_apps then runs storage and row cleanup', async () => {
    const response = await sendTrigger()

    expect(response.status).toBe(200)
    const statements = pgQuery.mock.calls.map(([sql]) => sql)
    const inserts = statements.filter(sql => sql.includes('record_app_deletion_once'))
    expect(inserts).toHaveLength(1)
    expect(pgQuery.mock.calls.find(([sql]) => sql.includes('record_app_deletion_once'))?.[1])
      .toEqual(['com.test.delete', 'org-1', '2026-01-01T00:00:00.000Z', '[]'])
    expect(cleanupStarted).toHaveBeenCalledOnce()
    // Storage hours are finalized first (a retry must not find the pass claimed), then the pass is
    // claimed, deleted_apps is recorded, and the rows are cleaned up.
    const claimIndex = statements.findIndex(sql => sql.includes('begin_app_storage_cleanup_pass'))
    expect(claimIndex).toBeGreaterThan(0)
    expect(statements.slice(0, claimIndex).some(sql => sql.includes('version_meta'))).toBe(true)
    expect(statements.slice(0, claimIndex).every(sql => !sql.startsWith('DELETE FROM public.') && !sql.includes('record_app_deletion_once'))).toBe(true)
    expect(pgQuery.mock.calls[claimIndex][1]).toEqual(['com.test.delete', 'org-1', 0, STORAGE_CLEANUP_LEASE_SECONDS, JSON.stringify(record)])
    expect(statements.indexOf(inserts[0])).toBe(claimIndex + 1)
    expect(statements.filter(sql => sql.startsWith('DELETE FROM public.'))).toHaveLength(9)
    expect(statements).toContain('DELETE FROM public.app_versions WHERE app_id = $1')
  })

  it('bounds the storage pass with a deadline and does not requeue a finished prefix', async () => {
    const before = Date.now()
    const response = await sendTrigger()

    expect(response.status).toBe(200)
    expect(deleteObjectsWithPrefix).toHaveBeenCalledOnce()
    const [, prefix, options] = deleteObjectsWithPrefix.mock.calls[0] as [unknown, string, { deadline: number }]
    expect(prefix).toBe('orgs/org-1/apps/com.test.delete/')
    expect(options.deadline).toBeGreaterThanOrEqual(before + STORAGE_CLEANUP_BUDGET_MS)
    expect(options.deadline).toBeLessThanOrEqual(Date.now() + STORAGE_CLEANUP_BUDGET_MS)
    expect(removeImageFolder).toHaveBeenCalledWith(expect.anything(), 'org/org-1/com.test.delete', { deadline: options.deadline })
    // An empty prefix clears the cleanup state instead of queueing a pass.
    expect(finishCalls().map(([, params]) => params)).toEqual([['com.test.delete', 'org-1', 0, true, STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS, STORAGE_CLEANUP_LEASE_SECONDS]])
  })

  it('requeues a delayed follow-up pass when the deadline leaves objects behind', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 20_000, failed: 0, done: false })

    const response = await sendTrigger()

    expect(response.status).toBe(200)
    expect(requeueCalls().map(([, params]) => params)).toEqual([
      ['com.test.delete', 'org-1', 0, false, STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS, STORAGE_CLEANUP_LEASE_SECONDS],
    ])
  })

  it('a follow-up pass only continues storage cleanup', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 500, failed: 0, done: false })

    const response = await sendTrigger({ storage_cleanup_pass: 3 })

    expect(response.status).toBe(200)
    const statements = sqlStatements()
    expect(statements.some(sql => sql.includes('record_app_deletion_once'))).toBe(false)
    expect(statements.some(sql => sql.startsWith('DELETE FROM public.'))).toBe(false)
    expect(deleteObjectsWithPrefix).toHaveBeenCalledOnce()
    expect((requeueCalls()[0][1] as unknown[])[2]).toBe(3)
  })

  it('stops requeuing after the pass budget', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 500, failed: 0, done: false })

    await sendTrigger({ storage_cleanup_pass: MAX_STORAGE_CLEANUP_PASSES - 1 })

    expect(requeueCalls()).toHaveLength(0)
    expect(finishCalls()).toHaveLength(1)
    expect(cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'app storage cleanup gave up after max passes' }))
  })

  it('requeues when the storage pass throws', async () => {
    deleteObjectsWithPrefix.mockRejectedValue(new Error('r2 unavailable'))

    await sendTrigger()

    expect(requeueCalls()).toHaveLength(1)
  })

  it('deletes nothing when the database reports the app id was recreated in the org', async () => {
    appExists.value = true

    const response = await sendTrigger({ storage_cleanup_pass: 2 })

    expect(response.status).toBe(200)
    // The guard is decided by the SQL function on the primary, never by a separate cached read.
    expect(sqlStatements().some(sql => sql.includes('FROM public.apps'))).toBe(false)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
    expect(removeImageFolder).not.toHaveBeenCalled()
    expect(finishCalls()).toHaveLength(0)
  })

  it('keeps the recreated app rows when pass 0 finds the app id taken again', async () => {
    appExists.value = true

    await sendTrigger()

    const statements = sqlStatements()
    // The deletion is still recorded for billing, but app_id-matched rows now belong to the new app.
    expect(statements.some(sql => sql.includes('record_app_deletion_once'))).toBe(true)
    expect(statements.some(sql => sql.startsWith('DELETE FROM public.'))).toBe(false)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
  })

  it.each(['superseded', 'running'])('ignores a pass-0 message the database reports as %s', async (claim) => {
    claimOverride.value = claim

    await sendTrigger()

    const statements = sqlStatements()
    expect(statements.some(sql => sql.includes('record_app_deletion_once'))).toBe(false)
    expect(statements.some(sql => sql.startsWith('DELETE FROM public.'))).toBe(false)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
    expect(finishCalls()).toHaveLength(0)
  })

  it('keeps cleaning when the image folder could not be removed', async () => {
    removeImageFolder.mockRejectedValue(new Error('r2 unavailable'))

    await sendTrigger()

    expect(requeueCalls()).toHaveLength(1)
  })

  it('fails the message when the pass cannot be claimed, so the queue retries it', async () => {
    pgQuery.mockImplementationOnce(async () => {
      throw new Error('db unavailable')
    })

    const response = await sendTrigger()

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(sqlStatements().some(sql => sql.includes('record_app_deletion_once'))).toBe(false)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
  })

  it('keeps the claimed state for the sweeper when finishing the pass fails', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 500, failed: 0, done: false })
    pgQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('begin_app_storage_cleanup_pass'))
        return { rows: [{ claim: 'claimed' }], rowCount: 1 }
      if (sql.includes('finish_app_storage_cleanup_pass'))
        throw new Error('db unavailable')
      return { rows: [], rowCount: 0 }
    })

    const response = await sendTrigger({ storage_cleanup_pass: 1 })

    expect(response.status).toBe(200)
    expect(cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'error finishing app storage cleanup pass' }))
  })

  it('records the storage hours from the last refresh up to the deletion time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T12:00:00.000Z'))
    try {
      pgQuery.mockImplementation(async (sql: string) => {
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
          // The deletion, at 06:00; the handler runs at 12:00.
          occurred_at: '2026-01-10T06:00:00.000Z',
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
      // The app row is gone, so the deletion finalizer skips the current-owner check.
      expect(replace?.[1]?.[8]).toBe(false)
      // The segment is when the owner got the app (its creation here).
      expect(replace?.[1]?.slice(0, 6)).toEqual(['com.test.delete', 'org-1', '2026-01-01', '2026-02-01', '2026-02-01', '2026-01-01T00:00:00.000Z'])
      // 100 bytes for the 6 hours between the upload and the deletion, not up to the handler's
      // clock (12:00): the queue delay is not billed.
      expect(JSON.parse(replace?.[1]?.[6] as string)).toEqual([{ cycle_start: '2026-01-01', date: '2026-01-10', storage_byte_hours: 600 }])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('does not finalize storage for a message queued before it carried occurred_at', async () => {
    const response = await sendTrigger({ occurred_at: undefined })

    expect(response.status).toBe(200)
    const statements = sqlStatements()
    // No storage hours: nothing tells this deletion's events from a later app with the same ID.
    expect(statements.some(sql => sql.includes('version_meta') || sql.includes('replace_app_storage_hourly'))).toBe(false)
    // The deletion is still recorded and cleaned up.
    expect(statements.some(sql => sql.includes('record_app_deletion_once'))).toBe(true)
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
          occurred_at: '2026-01-10T06:00:00.000Z',
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
          occurred_at: '2026-02-01T06:00:00.000Z',
          record: { app_id: 'com.test.delete', owner_org: 'org-1', created_at: '2026-01-01T00:00:00.000Z', transfer_history: [] },
        }),
      })

      expect(response.status).toBe(200)
      const replaced = pgQuery.mock.calls
        .filter(([sql]) => sql.includes('replace_app_storage_hourly'))
        .map(([, params]) => [params?.[2], JSON.parse(params?.[6] as string)])
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
        .map(([, params]) => [params?.[1], params?.[5], JSON.parse(params?.[6] as string)])
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
        .map(([, params]) => [params?.[1], params?.[2], JSON.parse(params?.[6] as string).reduce((sum: number, row: { storage_byte_hours: number }) => sum + row.storage_byte_hours, 0)])
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
          return { rows: finalizedAt ? [{ calculated_until: finalizedAt }] : [], rowCount: finalizedAt ? 1 : 0 } as any
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
        .map(([, params]) => JSON.parse(params?.[6] as string))
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

  function mockMonthlyCycles(events: Array<{ timestamp: string, version_id: number, size: number }>, refreshedAt: Record<string, string> = {}) {
    pgQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM public.daily_storage_hourly_refreshes')) {
        const writtenAt = refreshedAt[`${params?.[1]}|${params?.[2]}`]
        return { rows: writtenAt ? [{ calculated_until: writtenAt }] : [], rowCount: writtenAt ? 1 : 0 } as any
      }
      if (sql.includes('FROM public.version_meta')) {
        const until = Date.parse(String(params?.[1]))
        const rows = events.filter(row => Date.parse(row.timestamp) < until)
        return { rows, rowCount: rows.length } as any
      }
      if (sql.includes('billing_cycle_for_anchor')) {
        // Calendar months.
        const before = new Date(Date.parse(String(params?.[1])) - 1000)
        const start = new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth(), 1))
        const end = new Date(Date.UTC(before.getUTCFullYear(), before.getUTCMonth() + 1, 1))
        return { rows: [{ cycle_start: start.toISOString(), cycle_end: end.toISOString() }], rowCount: 1 } as any
      }
      return { rows: [], rowCount: 0 }
    })
  }

  async function deleteApp(record: Record<string, unknown>, occurredAt: string) {
    const response = await app.request('http://local/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'DELETE', table: 'apps', occurred_at: occurredAt, record }),
    })
    expect(response.status).toBe(200)
    return pgQuery.mock.calls
      .filter(([sql]) => sql.includes('replace_app_storage_hourly'))
      .map(([, params]) => [params?.[1], params?.[2], JSON.parse(params?.[6] as string).reduce((sum: number, row: { storage_byte_hours: number }) => sum + row.storage_byte_hours, 0)])
  }

  it('finalizes every former owner of a transfer chain', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-20T00:00:00.000Z'))
    try {
      mockMonthlyCycles([{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }])
      const replaced = await deleteApp({
        app_id: 'com.test.delete',
        owner_org: 'org-c',
        created_at: '2026-01-01T00:00:00.000Z',
        transfer_history: [
          { transferred_at: '2026-02-01T00:00:00.000Z', transferred_from: 'org-a', transferred_to: 'org-b' },
          { transferred_at: '2026-03-01T00:00:00.000Z', transferred_from: 'org-b', transferred_to: 'org-c' },
        ],
      }, '2026-03-10T00:00:00.000Z')

      expect(replaced).toEqual(expect.arrayContaining([
        // org-a, January 31st up to its transfer.
        ['org-a', '2026-01-01', 2400],
        // org-b, all of February up to its transfer.
        ['org-b', '2026-02-01', 100 * 28 * 24],
        // org-c, March 1st to the deletion.
        ['org-c', '2026-03-01', 100 * 9 * 24],
      ]))
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it.each([
    ['not finalized yet', {}, true],
    ['finalized by a refresh after the rollover', { 'org-1|2026-01-01': '2026-02-01T02:00:00.000Z' }, false],
  ] as const)('finalizes the previous cycle long after the rollover when %s', async (_label, refreshedAt, expectJanuary) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-02-21T00:00:00.000Z'))
    try {
      mockMonthlyCycles([{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }], refreshedAt)
      const replaced = await deleteApp({
        app_id: 'com.test.delete',
        owner_org: 'org-1',
        created_at: '2026-01-01T00:00:00.000Z',
        transfer_history: [],
      }, '2026-02-20T00:00:00.000Z')

      const january = replaced.filter(([org, cycle]) => org === 'org-1' && cycle === '2026-01-01')
      // 20 days after the rollover, January 31st is still recorded once.
      expect(january).toEqual(expectJanuary ? [['org-1', '2026-01-01', 2400]] : [])
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('finalizes every unfinished cycle of a gap across two rollovers', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'))
    try {
      mockMonthlyCycles([{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }])
      const replaced = await deleteApp({
        app_id: 'com.test.delete',
        owner_org: 'org-1',
        created_at: '2026-01-01T00:00:00.000Z',
        transfer_history: [],
      }, '2026-03-01T01:00:00.000Z')

      expect(replaced).toEqual(expect.arrayContaining([
        ['org-1', '2026-03-01', 100],
        // February, the previous cycle.
        ['org-1', '2026-02-01', 100 * 28 * 24],
        // January too: the last refresh before the gap never recorded January 31st.
        ['org-1', '2026-01-01', 2400],
      ]))
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })

  it('reaches an older unfinished cycle on retry after a newer one was finalized', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-02T00:00:00.000Z'))
    try {
      // February was finalized by the failed attempt; January was not.
      mockMonthlyCycles([{ timestamp: '2026-01-31T00:00:00.000Z', version_id: 1, size: 100 }], { 'org-1|2026-02-01': '2026-03-01T00:00:00.000Z' })
      const replaced = await deleteApp({
        app_id: 'com.test.delete',
        owner_org: 'org-1',
        created_at: '2026-01-01T00:00:00.000Z',
        transfer_history: [],
      }, '2026-03-01T01:00:00.000Z')

      expect(replaced.filter(([, cycle]) => cycle === '2026-02-01')).toEqual([])
      expect(replaced).toEqual(expect.arrayContaining([['org-1', '2026-01-01', 2400]]))
    }
    finally {
      pgQuery.mockReset()
      pgQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }))
      vi.useRealTimers()
    }
  })
})
