import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { runTestQuery } from '../scripts/db-client.ts'
import { POSTGRES_URL } from './test-utils.ts'

// PostgREST ran service_role on the authenticator login (8s statement and lock
// timeouts). Backend service queries must keep that bound, or a query stuck behind
// a lock holds its connection indefinitely.
describe('isolate catalog', () => {
  it('finds a function created after the first call for it', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
    const name = `tmp_late_fn_${randomUUID().replaceAll('-', '_')}`
    const call = () => runTestQuery({ kind: 'rpc', name, args: [{}], operations: [] }, { role: 'service' }, POSTGRES_URL)
    try {
      expect((await call()).error?.code).toBe('PGRST202')
      await pool.query(`CREATE FUNCTION public.${name}() RETURNS int LANGUAGE sql AS $$ SELECT 7 $$`)
      const result = await call()
      expect(result.error).toBeNull()
      expect(result.data).toBe(7)
    }
    finally {
      await pool.query(`DROP FUNCTION IF EXISTS public.${name}()`)
      await pool.end()
    }
  })
})

describe('service query timeouts', () => {
  it('fails at the lock timeout instead of waiting for the lock', async () => {
    const pool = new Pool({ connectionString: POSTGRES_URL, max: 1 })
    // A throwaway table, so the lock never blocks other test files.
    const table = `tmp_lock_${randomUUID().replaceAll('-', '_')}`
    await pool.query(`CREATE TABLE public.${table} (id int PRIMARY KEY)`)
    const holder = await pool.connect()
    // If the timeout ever regresses, cancel the query anyway so the lock is released.
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), 20000)
    try {
      await holder.query('BEGIN')
      await holder.query(`LOCK TABLE public.${table} IN ACCESS EXCLUSIVE MODE`)
      const started = Date.now()
      const result = await runTestQuery({ kind: 'table', name: table, args: [], operations: [{ method: 'select', args: ['id'] }] }, { role: 'service' }, POSTGRES_URL, deadline.signal)
      const elapsed = Date.now() - started
      // Lock (55P03) and statement (57014) timeouts are both 8s; either bounds the wait.
      expect(['55P03', '57014']).toContain(result.error?.code)
      expect(elapsed).toBeGreaterThanOrEqual(7000)
      expect(elapsed).toBeLessThan(15000)
    }
    finally {
      clearTimeout(timer)
      await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      await pool.query(`DROP TABLE IF EXISTS public.${table}`)
      await pool.end()
    }
  }, 40000)
})
