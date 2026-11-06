import type { Context } from 'hono'
import { env } from 'node:process'
import { sql } from 'drizzle-orm'
import { Client, Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { closeClient as closePluginClient, createLazyPgClient, getDrizzleClient as getPluginDrizzleClient, getPgClient as getPluginPgClient } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { BEGIN_WRITE_TRANSACTION_SQL, beginWriteTransaction, checkoutPgClient, closeClient, getDrizzleClient, getPgClient, releasePgClient, withPgTransaction } from '../supabase/functions/_backend/utils/pg.ts'

const runtime = vi.hoisted(() => ({ key: 'node' }))
vi.mock('hono/adapter', async importOriginal => ({
  ...await importOriginal<typeof import('hono/adapter')>(),
  env: (c: Context) => c.env,
  getRuntimeKey: () => runtime.key,
}))

const connectionString = env.SUPABASE_DB_URL ?? env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

function context() {
  const variables = new Map<string, unknown>([['requestId', 'test-transaction-mode']])
  return {
    env: {
      HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString },
      CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
      SB_REGION: 'eu-west-3',
    },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => variables.set(key, value),
    header: vi.fn(),
    req: { header: () => undefined, raw: Object.assign(new Request('https://example.test/updates'), { cf: { continent: 'EU', country: 'FR' } }) },
    res: new Response(null),
  } as unknown as Context
}

describe('pooled PostgreSQL transaction access modes', () => {
  it.each([
    ['API', 'node', getPgClient, closeClient],
    ['API', 'workerd', getPgClient, closeClient],
    ['plugin fallback', 'node', getPluginPgClient, closePluginClient],
    ['plugin fallback', 'workerd', getPluginPgClient, closePluginClient],
  ] as const)('never pins a transaction for %s primary reads in %s', async (_name, runtimeKey, create, close) => {
    runtime.key = runtimeKey
    const c = context()
    const reader = await create(c, true)
    try {
      // A request-long BEGIN READ ONLY pins one Hyperdrive origin connection per
      // in-flight request and exhausts the primary pool; reads must stay idle.
      await reader.query('SELECT 1')
      expect((await reader.query('SELECT now() = statement_timestamp() AS autocommit')).rows[0].autocommit).toBe(true)
      expect((await reader.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('off')
    }
    finally {
      await close(c, reader)
      if (runtimeKey === 'workerd')
        await reader.end()
      runtime.key = 'node'
    }
  })

  it('opens primary reader transactions read-only and closes them', async () => {
    const c = context()
    const reader = await getPgClient(c, true)
    try {
      await withPgTransaction(reader, async (client) => {
        expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on')
      })
      await getDrizzleClient(reader, { logger: false }).transaction(async (tx) => {
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toMatchObject({ transaction_read_only: 'on' })
      })
      const upgrade = vi.fn(async () => undefined)
      await expect(getDrizzleClient(reader, { logger: false }).transaction(upgrade, { accessMode: 'read write' })).rejects.toThrow('read-only client')
      expect(upgrade).not.toHaveBeenCalled()
      const client = await checkoutPgClient(reader)
      expect((await client.query('SELECT now() = statement_timestamp() AS autocommit')).rows[0].autocommit).toBe(true)
      releasePgClient(reader, client)
    }
    finally {
      await closeClient(c, reader)
    }
  })

  it('starts raw writer transactions read-write even on a contaminated backend', async () => {
    const pool = new Pool({ connectionString, max: 1 })
    try {
      await pool.query('SET default_transaction_read_only = on')
      const backend = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await withPgTransaction(pool, async (client) => {
        expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(backend)
        expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off')
        await client.query('CREATE TEMP TABLE transaction_writer (id int)')
      })
      // The transaction override must not mutate session defaults either.
      expect((await pool.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on')
    }
    finally {
      await pool.end()
    }
  })

  it('starts Drizzle writer transactions read-write on a contaminated backend', async () => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await client.query('SET default_transaction_read_only = on')
      await getDrizzleClient(client, { logger: false }).transaction(async (tx) => {
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toMatchObject({ transaction_read_only: 'off' })
        await tx.execute(sql`CREATE TEMP TABLE drizzle_writer (id int)`)
      })
      expect((await client.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on')
    }
    finally {
      await client.end()
    }
  })

  it('bounds idle time inside Drizzle transactions without leaking to the session', async () => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await getDrizzleClient(client, { logger: false }).transaction(async (tx) => {
        expect((await tx.execute(sql`SHOW idle_in_transaction_session_timeout`)).rows[0]).toMatchObject({ idle_in_transaction_session_timeout: '15s' })
      })
      expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('0')
    }
    finally {
      await client.end()
    }
  })

  it('bounds idle time on raw write BEGIN in one round trip', async () => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      expect(BEGIN_WRITE_TRANSACTION_SQL).toMatch(/^BEGIN READ WRITE; SET LOCAL idle_in_transaction_session_timeout = 15000$/)
      await beginWriteTransaction(client)
      expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('15s')
      expect((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('off')
      await client.query('ROLLBACK')
      expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('0')
    }
    finally {
      await client.end()
    }
  })

  it('bounds idle time inside withPgTransaction without a separate SET after BEGIN', async () => {
    const c = context()
    const pool = await getPgClient(c, false)
    try {
      await withPgTransaction(pool, async (client) => {
        expect((await client.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('15s')
        expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('10s')
      })
      expect((await pool.query('SHOW idle_in_transaction_session_timeout')).rows[0].idle_in_transaction_session_timeout).toBe('0')
    }
    finally {
      await closeClient(c, pool)
    }
  })

  it('rejects instead of crashing when the server kills a checked-out transaction client', async () => {
    const c = context()
    const pool = await getPgClient(c, false)
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await expect(getDrizzleClient(pool, { logger: false }).transaction(async (tx) => {
        const { pid } = (await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0] as { pid: number }
        await admin.query('SELECT pg_terminate_backend($1)', [pid])
        // Let the socket close while the transaction is idle, as the idle timeout would.
        await new Promise(resolve => setTimeout(resolve, 200))
        await tx.execute(sql`SELECT 1`)
      })).rejects.toThrow()
    }
    finally {
      await admin.end()
      await closeClient(c, pool)
    }
  })

  it('preserves explicitly read-only Drizzle transaction configuration', async () => {
    const client = new Client({ connectionString })
    await client.connect()
    try {
      await getDrizzleClient(client, { logger: false }).transaction(async (tx) => {
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toMatchObject({ transaction_read_only: 'on' })
      }, { accessMode: 'read only', isolationLevel: 'repeatable read' })
    }
    finally {
      await client.end()
    }
  })

  it('preserves a lazy replica reader mode when starting a Drizzle transaction', async () => {
    const c = context()
    c.env.HYPERDRIVE_CAPGO_READ_EU = { connectionString }
    c.set('requireReadReplica', true)
    const lazy = createLazyPgClient(c, true)
    try {
      expect(lazy.isConnected()).toBe(false)
      await getPluginDrizzleClient(lazy.client, { logger: false }).transaction(async (tx) => {
        expect(c.get('databaseSource')).toBe('HYPERDRIVE_CAPGO_READ_EU')
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toMatchObject({ transaction_read_only: 'on' })
      })
    }
    finally {
      await lazy.close()
    }
  })

  it('rejects a read-write upgrade through a lazy replica reader', async () => {
    const c = context()
    c.env.HYPERDRIVE_CAPGO_READ_EU = { connectionString }
    c.set('requireReadReplica', true)
    const lazy = createLazyPgClient(c, true)
    const run = vi.fn(async () => undefined)
    try {
      await expect(getPluginDrizzleClient(lazy.client, { logger: false }).transaction(run, { accessMode: 'read write' })).rejects.toThrow('read-only client')
      expect(run).not.toHaveBeenCalled()
    }
    finally {
      await lazy.close()
    }
  })

  it('opens a lazy primary reader transaction read-only', async () => {
    const c = context()
    const lazy = createLazyPgClient(c, true)
    try {
      await getPluginDrizzleClient(lazy.client, { logger: false }).transaction(async (tx) => {
        expect((await tx.execute(sql`SHOW transaction_read_only`)).rows[0]).toMatchObject({ transaction_read_only: 'on' })
      })
      expect((await lazy.client.query('SELECT now() = statement_timestamp() AS autocommit')).rows[0].autocommit).toBe(true)
    }
    finally {
      await lazy.close()
    }
  })
})
