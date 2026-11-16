import type { Context } from 'hono'
import { env } from 'node:process'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { clearConsoleQueryCatalogCache, runConsoleQuery } from '../supabase/functions/_backend/private/console_query_run.ts'

const mocks = vi.hoisted(() => ({ getPgClient: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient: mocks.getPgClient,
  // Keep the test's one-connection pool open to verify rollback and reuse.
  closeClient: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlogErr: vi.fn() }))

const connectionString = env.SUPABASE_DB_URL ?? env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

describe('console catalog database timeout', () => {
  it('cancels a slow cold read on the server, rolls back, and retries the catalog', async () => {
    const pool = new Pool({ connectionString, max: 1 })
    mocks.getPgClient.mockResolvedValue(pool)
    clearConsoleQueryCatalogCache()
    let catalogReads = 0
    pool.on('connect', (client) => {
      const query = client.query.bind(client)
      client.query = ((text: unknown, ...args: unknown[]) => {
        if (typeof text === 'string' && text.includes('AS foreign_keys')) {
          catalogReads++
          // Execute real SQL in place of just the first catalog SELECT. BEGIN,
          // SET LOCAL, server cancellation, ROLLBACK, and retry are all real.
          if (catalogReads === 1)
            return query('SELECT pg_catalog.pg_sleep(11)')
        }
        return Reflect.apply(query, client, [text, ...args])
      }) as typeof client.query
    })
    const c = { get: () => undefined } as unknown as Context
    const session = { role: 'authenticated' as const, claims: { sub: '11111111-1111-4111-8111-111111111111' } }
    const request = {
      kind: 'table' as const,
      name: 'orgs',
      args: [],
      operations: [{ method: 'select', args: ['id'] }, { method: 'limit', args: [0] }],
    }
    try {
      // Give the session a much longer timeout to prove the cold read gets its
      // own bound. This setting belongs only to this test connection.
      await pool.query('SET statement_timeout = 120000')
      const before = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const failed = await runConsoleQuery(c, request, session)
      expect(failed.error?.code).toBe('57014')
      expect(failed.error?.message).toContain('statement timeout')
      expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(before)
      expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('2min')
      const retried = await runConsoleQuery(c, request, session)
      expect(retried.error).toBeNull()
      expect(retried.data).toEqual([])
      expect(catalogReads).toBe(2)
    }
    finally {
      clearConsoleQueryCatalogCache()
      await pool.end()
    }
  })
})
