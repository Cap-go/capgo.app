import { env } from 'node:process'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { fileReadCacheTestUtils } from '../supabase/functions/_backend/files/file_read_cache.ts'

const connectionString = env.SUPABASE_DB_URL ?? env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

describe('file_read_cache deleted lookup transaction', () => {
  it('bounds a lookup transaction abandoned right after BEGIN', async () => {
    const client = new Client({ connectionString })
    const admin = new Client({ connectionString })
    await Promise.all([client.connect(), admin.connect()])
    const errors: unknown[] = []
    client.on('error', error => errors.push(error))
    try {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      // Simulate the request deadline abandoning the lookup: BEGIN runs, nothing follows.
      await client.query(fileReadCacheTestUtils.DELETED_LOOKUP_BEGIN)
      const { rows } = await admin.query('SELECT state FROM pg_stat_activity WHERE pid = $1', [pid])
      expect(rows[0]?.state).toBe('idle in transaction')

      await new Promise(resolve => setTimeout(resolve, fileReadCacheTestUtils.DELETED_LOOKUP_TIMEOUT_MS + 1000))

      // PostgreSQL ended the abandoned transaction instead of pinning the connection.
      expect((await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0].n).toBe(0)
      expect(errors.length).toBeGreaterThan(0)
    }
    finally {
      await admin.end()
      await client.end().catch(() => {})
    }
  }, 15000)
})
