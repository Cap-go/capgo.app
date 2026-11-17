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
      const body = await c.req.raw.clone().json()
      c.set('webhookBody', body.old_record)
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
    body: JSON.stringify({ type: 'DELETE', table: 'apps', schema: 'public', record: null, old_record: record, ...extra }),
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
    const inserts = statements.filter(sql => sql.includes('INSERT INTO public.deleted_apps'))
    expect(inserts).toHaveLength(1)
    expect(pgQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO public.deleted_apps'))?.[1])
      .toEqual(['com.test.delete', '2026-01-01T00:00:00.000Z', 'org-1', '[]'])
    expect(cleanupStarted).toHaveBeenCalledOnce()
    // The pass is claimed before anything else, then deleted_apps is recorded.
    expect(statements[0]).toContain('begin_app_storage_cleanup_pass')
    expect(pgQuery.mock.calls[0][1]).toEqual(['com.test.delete', 'org-1', 0, STORAGE_CLEANUP_LEASE_SECONDS])
    expect(statements.indexOf(inserts[0])).toBe(1)
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
    expect(statements.some(sql => sql.includes('INSERT INTO public.deleted_apps'))).toBe(false)
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
    expect(statements.some(sql => sql.includes('INSERT INTO public.deleted_apps'))).toBe(true)
    expect(statements.some(sql => sql.startsWith('DELETE FROM public.'))).toBe(false)
    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
  })

  it.each(['superseded', 'running'])('ignores a pass-0 message the database reports as %s', async (claim) => {
    claimOverride.value = claim

    await sendTrigger()

    const statements = sqlStatements()
    expect(statements.some(sql => sql.includes('INSERT INTO public.deleted_apps'))).toBe(false)
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
    expect(sqlStatements().some(sql => sql.includes('INSERT INTO public.deleted_apps'))).toBe(false)
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
})
