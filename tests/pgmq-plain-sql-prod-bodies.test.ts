import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

// 20261126151718_pgmq_plain_sql against a reproduction of prod's pgmq: a real
// pgmq 1.5.1 extension with prod's older function bodies (they run
// ALTER EXTENSION with no check that the extension exists) and queue tables
// that are not extension members. The local image ships newer bodies, so the
// pgTAP test alone cannot see the failure the prod dry run hit.

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const MIGRATION_SQL = readFileSync(resolve(repoRoot, 'supabase/migrations/20261126151718_pgmq_plain_sql.sql'), 'utf8')
const PROD_OLD_FUNCTIONS_SQL = readFileSync(resolve(repoRoot, 'tests/fixtures/pgmq-prod-1.5.1-old-functions.sql'), 'utf8')

/** md5(prosrc) on prod (2026-11-28), to prove the fixture is prod's code. */
const PROD_PROSRC_MD5: Record<string, string> = {
  'pgmq.create_non_partitioned(text)': '50e8ff0a55ceb63dbf98e0e0a112695b',
  'pgmq.create_partitioned(text,text,text)': '294fe62f063132ae771fbd5b34c07c56',
  'pgmq.create_unlogged(text)': 'b32529f85429320bacfb7391b976c322',
  'pgmq.detach_archive(text)': '870a910c5a96b4a42fc5306e5c820037',
  'pgmq.drop_queue(text)': '894d5d403da146b0fcbfdb7fe592a6e5',
}

/** The migration without its function replacements: what the prod dry run ran. */
const MIGRATION_WITHOUT_REPLACEMENTS = MIGRATION_SQL.replace(/\n {2}EXECUTE \$fn\$\n[\s\S]*?\n\$fn\$;\n/g, '\n')

function databaseUrl(baseUrl: string, database: string) {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function withProdLikePgmq<T>(run: (client: Client) => Promise<T>) {
  const database = `pgmq_prod_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = new Client({ connectionString: POSTGRES_URL })
  await admin.connect()
  const client = new Client({ connectionString: databaseUrl(POSTGRES_URL, database) })
  try {
    await admin.query(`CREATE DATABASE ${database}`)
    await client.connect()
    await client.query('CREATE SCHEMA pgmq; CREATE EXTENSION pgmq WITH SCHEMA pgmq;')
    await client.query(PROD_OLD_FUNCTIONS_SQL)
    // A queue with messages, its tables taken out of the extension like on prod.
    await client.query(`
      SELECT pgmq.create('prod_queue');
      SELECT pgmq.send('prod_queue', '{"n":1}'::jsonb);
      SELECT pgmq.send('prod_queue', '{"n":2}'::jsonb);
      ALTER EXTENSION pgmq DROP TABLE pgmq.q_prod_queue;
      ALTER EXTENSION pgmq DROP TABLE pgmq.a_prod_queue;
    `)
    return await run(client)
  }
  finally {
    await client.end().catch(() => {})
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    )
    await admin.query(`DROP DATABASE IF EXISTS ${database}`)
    await admin.end()
  }
}

async function scalar<T>(client: Client, sql: string): Promise<T> {
  const { rows } = await client.query(sql)
  return Object.values(rows[0])[0] as T
}

describe('pgmq plain SQL migration on prod pgmq bodies', () => {
  it('reproduces prod: the fixture holds prod\'s bodies and, without the replacements, pgmq.create fails', async () => {
    await withProdLikePgmq(async (client) => {
      const { rows } = await client.query<{ sig: string, src_md5: string }>(
        `SELECT p.oid::regprocedure::text AS sig, md5(p.prosrc) AS src_md5
         FROM pg_catalog.pg_proc AS p
         WHERE p.oid::regprocedure::text = ANY($1::text[])`,
        [Object.keys(PROD_PROSRC_MD5)],
      )
      expect(Object.fromEntries(rows.map(row => [row.sig, row.src_md5]))).toEqual(PROD_PROSRC_MD5)

      await client.query(MIGRATION_WITHOUT_REPLACEMENTS)
      await expect(client.query(`SELECT pgmq.create('after_drop')`)).rejects.toThrow('extension "pgmq" does not exist')
    })
  }, 120_000)

  it('drops the extension, keeps the data, and the queue API works on prod\'s bodies', async () => {
    await withProdLikePgmq(async (client) => {
      const metaRowsBefore = await scalar<number>(client, 'SELECT count(*)::int FROM pgmq.meta')
      const partitionedErrorBefore = await client.query(`SELECT pgmq.create_partitioned('part_queue')`)
        .then(() => null, (error: Error) => error.message)

      await client.query(MIGRATION_SQL)

      expect(await scalar<number>(client, `SELECT count(*)::int FROM pg_catalog.pg_extension WHERE extname = 'pgmq'`)).toBe(0)
      expect(await scalar<number>(client, 'SELECT count(*)::int FROM pgmq.meta')).toBe(metaRowsBefore)
      expect(await scalar<number>(client, 'SELECT count(*)::int FROM pgmq.q_prod_queue')).toBe(2)

      await client.query(`SELECT pgmq.create('new_queue')`)
      await client.query(`SELECT pgmq.create_unlogged('unlogged_queue')`)
      expect(await scalar<string>(client, `SELECT relpersistence FROM pg_catalog.pg_class WHERE oid = 'pgmq.q_unlogged_queue'::regclass`)).toBe('u')
      await client.query(`SELECT pgmq.send('new_queue', '{"n":1}'::jsonb)`)
      await client.query(`SELECT pgmq.send_batch('new_queue', ARRAY['{"n":2}', '{"n":3}']::jsonb[])`)
      const read = await client.query<{ msg_id: string }>(`SELECT msg_id FROM pgmq.read('new_queue', 30, 10)`)
      expect(read.rows).toHaveLength(3)
      expect(await scalar<boolean>(client, `SELECT pgmq.archive('new_queue', ${Number(read.rows[0].msg_id)}::bigint)`)).toBe(true)
      expect(await scalar<number>(client, 'SELECT count(*)::int FROM pgmq.a_new_queue')).toBe(1)
      await client.query(`SELECT pgmq.detach_archive('new_queue')`)

      for (const queue of ['new_queue', 'unlogged_queue', 'prod_queue']) {
        expect(await scalar<boolean>(client, `SELECT pgmq.drop_queue('${queue}')`)).toBe(true)
        expect(await scalar<string | null>(client, `SELECT pg_catalog.to_regclass('pgmq.q_${queue}')::text`)).toBeNull()
        expect(await scalar<number>(client, `SELECT count(*)::int FROM pgmq.meta WHERE queue_name = '${queue}'`)).toBe(0)
      }

      // Capgo has no partitioned queues and no pg_partman: create_partitioned
      // failed before the migration and fails the same way after it.
      const partitionedErrorAfter = await client.query(`SELECT pgmq.create_partitioned('part_queue')`)
        .then(() => null, (error: Error) => error.message)
      expect(partitionedErrorBefore).toMatch(/pg_partman/)
      expect(partitionedErrorAfter).toBe(partitionedErrorBefore)
    })
  }, 120_000)
})
