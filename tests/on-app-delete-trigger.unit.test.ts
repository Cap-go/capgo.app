import { beforeEach, describe, expect, it, vi } from 'vitest'

const appExists = { value: false }
const pgQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
  if (sql.includes('SELECT 1 FROM public.apps'))
    return { rows: appExists.value ? [{ '?column?': 1 }] : [], rowCount: appExists.value ? 1 : 0 }
  return { rows: [], rowCount: 0 }
})
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

const { app, MAX_STORAGE_CLEANUP_PASSES, STORAGE_CLEANUP_BUDGET_MS, STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS } = await import('../supabase/functions/_backend/triggers/on_app_delete.ts')

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

function requeueCalls() {
  return pgQuery.mock.calls.filter(([sql]) => sql.includes('pgmq.send'))
}

describe('on_app_delete trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    appExists.value = false
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
    expect(statements.indexOf(inserts[0])).toBe(0)
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
    expect(requeueCalls()).toHaveLength(0)
  })

  it('requeues a delayed follow-up pass when the deadline leaves objects behind', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 20_000, failed: 0, done: false })

    const response = await sendTrigger()

    expect(response.status).toBe(200)
    const calls = requeueCalls()
    expect(calls).toHaveLength(1)
    const [queue, message, delay] = calls[0][1] as [string, string, number]
    expect(queue).toBe('on_app_delete')
    expect(delay).toBe(STORAGE_CLEANUP_REQUEUE_DELAY_SECONDS)
    expect(JSON.parse(message)).toEqual({
      function_name: 'on_app_delete',
      payload: { type: 'DELETE', table: 'apps', schema: 'public', record: null, old_record: record, storage_cleanup_pass: 1 },
    })
  })

  it('a follow-up pass only continues storage cleanup', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 500, failed: 0, done: false })

    const response = await sendTrigger({ storage_cleanup_pass: 3 })

    expect(response.status).toBe(200)
    const statements = sqlStatements()
    expect(statements.some(sql => sql.includes('INSERT INTO public.deleted_apps'))).toBe(false)
    expect(statements.some(sql => sql.startsWith('DELETE FROM public.'))).toBe(false)
    expect(deleteObjectsWithPrefix).toHaveBeenCalledOnce()
    expect(JSON.parse(requeueCalls()[0][1]![1] as string).payload.storage_cleanup_pass).toBe(4)
  })

  it('stops requeuing after the pass budget', async () => {
    deleteObjectsWithPrefix.mockResolvedValue({ deleted: 500, failed: 0, done: false })

    await sendTrigger({ storage_cleanup_pass: MAX_STORAGE_CLEANUP_PASSES - 1 })

    expect(requeueCalls()).toHaveLength(0)
    expect(cloudlogErr).toHaveBeenCalledWith(expect.objectContaining({ message: 'app storage cleanup gave up after max passes' }))
  })

  it('requeues when the storage pass throws', async () => {
    deleteObjectsWithPrefix.mockRejectedValue(new Error('r2 unavailable'))

    await sendTrigger()

    expect(requeueCalls()).toHaveLength(1)
  })

  it('leaves storage alone when the app id was recreated in the same org', async () => {
    appExists.value = true

    await sendTrigger({ storage_cleanup_pass: 2 })

    expect(deleteObjectsWithPrefix).not.toHaveBeenCalled()
    expect(removeImageFolder).not.toHaveBeenCalled()
    expect(requeueCalls()).toHaveLength(0)
  })
})
