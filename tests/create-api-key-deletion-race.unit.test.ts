import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  getPgClientMock,
  pgConnectMock,
  pgQueryMock,
  pgReleaseMock,
} = vi.hoisted(() => {
  const pgQueryMock = vi.fn()
  const pgReleaseMock = vi.fn()
  const pgConnectMock = vi.fn(async () => ({ query: pgQueryMock, release: pgReleaseMock }))
  return {
    closeClientMock: vi.fn(),
    getPgClientMock: vi.fn(() => ({ connect: pgConnectMock })),
    pgConnectMock,
    pgQueryMock,
    pgReleaseMock,
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getPgClient: getPgClientMock,
}))

const { createApiKey } = await import('../supabase/functions/_backend/utils/supabase.ts')

const USER_ID = '11111111-1111-4111-8111-111111111111'

function normalizedQuery(query: unknown) {
  return String(query).replace(/\s+/g, ' ').trim()
}

function context() {
  return { get: vi.fn(() => 'request-id') } as never
}

describe('createApiKey account-deletion serialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('locks the public profile and rolls back before API-key reads when deletion is scheduled', async () => {
    pgQueryMock.mockImplementation(async (query: unknown) => {
      const sql = normalizedQuery(query)
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL lock_timeout'))
        return { rowCount: null, rows: [] }
      if (sql.includes('SELECT id FROM public.users'))
        return { rowCount: 1, rows: [{ id: USER_ID }] }
      if (sql.includes('FROM public.to_delete_accounts'))
        return { rowCount: 1, rows: [{ deletion_scheduled: true }] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    await createApiKey(context(), USER_ID)

    const queries = pgQueryMock.mock.calls.map(([query]) => normalizedQuery(query))
    expect(queries).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      'SELECT id FROM public.users WHERE id = $1::uuid FOR UPDATE',
      'SELECT EXISTS ( SELECT 1 FROM public.to_delete_accounts WHERE account_id = $1::uuid ) AS deletion_scheduled',
      'ROLLBACK',
    ])
    expect(queries.some(query => query.includes('FROM public.apikeys'))).toBe(false)
    expect(pgConnectMock).toHaveBeenCalledOnce()
    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('continues default-key provisioning only after the deletion guard is clear', async () => {
    pgQueryMock.mockImplementation(async (query: unknown) => {
      const sql = normalizedQuery(query)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql.startsWith('SET LOCAL lock_timeout'))
        return { rowCount: null, rows: [] }
      if (sql.includes('SELECT id FROM public.users'))
        return { rowCount: 1, rows: [{ id: USER_ID }] }
      if (sql.includes('FROM public.to_delete_accounts'))
        return { rowCount: 1, rows: [{ deletion_scheduled: false }] }
      if (sql.includes('SELECT count(*)::text AS count FROM public.apikeys'))
        return { rowCount: 1, rows: [{ count: '0' }] }
      if (sql.startsWith('SELECT DISTINCT rb.org_id'))
        return { rowCount: 1, rows: [{ org_id: '22222222-2222-4222-8222-222222222222' }] }
      if (sql.startsWith('WITH default_keys'))
        return { rowCount: 3, rows: [] }
      throw new Error(`Unexpected query: ${sql}`)
    })

    await createApiKey(context(), USER_ID)

    const queries = pgQueryMock.mock.calls.map(([query]) => normalizedQuery(query))
    const guardIndex = queries.findIndex(query => query.includes('FROM public.to_delete_accounts'))
    const insertIndex = queries.findIndex(query => query.startsWith('WITH default_keys'))
    expect(guardIndex).toBeGreaterThan(0)
    expect(insertIndex).toBeGreaterThan(guardIndex)
    expect(queries.at(-1)).toBe('COMMIT')
    expect(pgConnectMock).toHaveBeenCalledOnce()
    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(closeClientMock).toHaveBeenCalledOnce()
  })

  it('rolls back, destroys the client, and propagates a lock timeout for queue retry', async () => {
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })
    pgQueryMock.mockImplementation(async (query: unknown) => {
      const sql = normalizedQuery(query)
      if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL lock_timeout'))
        return { rowCount: null, rows: [] }
      if (sql.includes('SELECT id FROM public.users'))
        throw lockTimeout
      throw new Error(`Unexpected query: ${sql}`)
    })

    await expect(createApiKey(context(), USER_ID)).rejects.toBe(lockTimeout)

    expect(pgQueryMock.mock.calls.map(([query]) => normalizedQuery(query))).toEqual([
      'BEGIN',
      `SET LOCAL lock_timeout = '5s'`,
      'SELECT id FROM public.users WHERE id = $1::uuid FOR UPDATE',
      'ROLLBACK',
    ])
    expect(pgReleaseMock).toHaveBeenCalledWith(true)
    expect(closeClientMock).toHaveBeenCalledOnce()
  })
})
