import type { Context } from 'hono'
import type { ConsoleQueryRequest } from '../supabase/functions/_backend/private/console_query_sql.ts'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  transactionQuery: vi.fn(),
  execute: vi.fn(),
  release: vi.fn(),
  events: [] as string[],
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  const client = { query: mocks.transactionQuery, release: mocks.release }
  return {
    ...original,
    getPgClient: async () => ({ query: mocks.catalog, connect: async () => client }),
    closeClient: vi.fn(),
    getDrizzleClient: (queryClient: unknown) => {
      expect(queryClient).toBe(client)
      return { execute: mocks.execute }
    },
  }
})

const { clearConsoleQueryCatalogCache, runConsoleQuery } = await import('../supabase/functions/_backend/private/console_query_run.ts')
const c = { get: () => undefined } as unknown as Context
const request: ConsoleQueryRequest = {
  kind: 'table', name: 'orgs', args: [], operations: [{ method: 'select', args: ['id'] }],
}
const session = { role: 'authenticated' as const, claims: { sub: '11111111-1111-4111-8111-111111111111' } }

beforeEach(() => {
  vi.clearAllMocks()
  clearConsoleQueryCatalogCache()
  mocks.events.length = 0
  mocks.catalog.mockImplementation(async () => {
    mocks.events.push('catalog')
    return { rows: [{ columns: [{ table_name: 'orgs', column_name: 'id', udt: 'uuid' }], foreign_keys: [], functions: [] }] }
  })
  mocks.transactionQuery.mockImplementation(async (text: string) => {
    mocks.events.push(text.startsWith('BEGIN') ? 'begin' : text)
    return { rows: [] }
  })
  mocks.execute.mockImplementation(async () => {
    mocks.events.push('user query')
    return { rows: [{ row: { id: session.claims.sub } }] }
  })
})

describe('console catalog caching and caller isolation', () => {
  it('loads cold metadata outside the transaction and executes data under the caller role', async () => {
    const result = await runConsoleQuery(c, request, session)
    expect(result.error).toBeNull()
    expect(mocks.events).toEqual(['catalog', 'begin', 'user query', 'COMMIT'])
    const setup = mocks.transactionQuery.mock.calls[0][0] as string
    expect(setup).toContain('SET LOCAL ROLE authenticated')
    expect(setup).toContain(session.claims.sub)
    expect(setup).toContain('SET LOCAL row_security = on')
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('reuses only metadata across callers and sets each caller in a new transaction', async () => {
    await runConsoleQuery(c, request, session)
    const other = { role: 'authenticated' as const, claims: { sub: '22222222-2222-4222-8222-222222222222' } }
    await runConsoleQuery(c, request, other)
    expect(mocks.catalog).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    const setup = mocks.transactionQuery.mock.calls[2][0] as string
    expect(setup).toContain(other.claims.sub)
    expect(setup).not.toContain(session.claims.sub)
  })

  it('shares an in-flight catalog read', async () => {
    await Promise.all([runConsoleQuery(c, request, session), runConsoleQuery(c, request, session)])
    expect(mocks.catalog).toHaveBeenCalledOnce()
    expect(mocks.execute).toHaveBeenCalledTimes(2)
  })

  it('retries failed metadata without opening a user transaction', async () => {
    mocks.catalog.mockRejectedValueOnce(new Error('catalog unavailable'))
    await expect(runConsoleQuery(c, request, session)).rejects.toThrow('catalog unavailable')
    expect(mocks.transactionQuery).not.toHaveBeenCalled()
    await runConsoleQuery(c, request, session)
    expect(mocks.catalog).toHaveBeenCalledTimes(2)
    expect(mocks.execute).toHaveBeenCalledOnce()
  })

  it('never executes a data query if assuming the caller role fails', async () => {
    mocks.transactionQuery.mockRejectedValueOnce(new Error('role setup failed'))
    await expect(runConsoleQuery(c, request, session)).rejects.toThrow('role setup failed')
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.transactionQuery).toHaveBeenLastCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalledOnce()
  })
})
