import type { PoolClient } from 'pg'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { POSTGRES_URL } from './test-utils.ts'

const migration = readFileSync(new URL('../supabase/migrations/20261029025503_bundle_list_index.sql', import.meta.url), 'utf8')
const indexName = 'idx_app_versions_app_deleted_created_at'
const pool = new Pool({ connectionString: POSTGRES_URL, max: 2 })

/** Replay the actual migration against a private schema with no shared fixtures. */
async function withIndexFixture(run: (client: PoolClient, schema: string, sql: string) => Promise<void>) {
  const client = await pool.connect()
  const schema = `bundle_list_index_${randomUUID().replaceAll('-', '')}`
  const sql = migration.replaceAll(`public.${indexName}`, `${schema}.${indexName}`)
    .replaceAll('ON public.app_versions', `ON ${schema}.versions`)
  try {
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`CREATE TABLE ${schema}.versions (app_id varchar, deleted boolean, created_at timestamptz)`)
    await run(client, schema, sql)
  }
  finally {
    try {
      await client.query('ROLLBACK')
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    }
    finally {
      client.release()
    }
  }
}

/** Read the index identity and usability flags without modifying the catalogs. */
async function indexState(client: PoolClient, schema: string) {
  const result = await client.query(`SELECT indexrelid, indisvalid, indisready FROM pg_catalog.pg_index
    WHERE indexrelid=pg_catalog.to_regclass($1)`, [`${schema}.${indexName}`])
  return result.rows[0] as { indexrelid: number, indisvalid: boolean, indisready: boolean } | undefined
}

afterAll(async () => {
  await pool.end()
})

describe('bundle-list index migration preflight', () => {
  it.concurrent('creates a missing index and reuses it on repeated application', async () => {
    await withIndexFixture(async (client, schema, sql) => {
      await client.query('BEGIN')
      expect(await indexState(client, schema)).toBeUndefined()
      await client.query(sql)
      const created = await indexState(client, schema)
      expect(created).toMatchObject({ indisvalid: true, indisready: true })
      await client.query(sql)
      expect(await indexState(client, schema)).toEqual(created)
    })
  })

  it.concurrent('reuses a valid index built concurrently before the migration', async () => {
    await withIndexFixture(async (client, schema, sql) => {
      await client.query(`CREATE INDEX CONCURRENTLY ${indexName} ON ${schema}.versions (app_id, deleted, created_at DESC)`)
      const prebuilt = await indexState(client, schema)
      expect(prebuilt).toMatchObject({ indisvalid: true, indisready: true })
      await client.query('BEGIN')
      await client.query(sql)
      expect(await indexState(client, schema)).toEqual(prebuilt)
    })
  })

  it.concurrent.each([
    { kind: 'table', definition: '(id integer)' },
    { kind: 'view', definition: 'AS SELECT 1 AS id' },
    { kind: 'sequence', definition: '' },
    { kind: 'materialized view', definition: 'AS SELECT 1 AS id' },
  ])('rejects a same-name $kind without changing it', async ({ kind, definition }) => {
    await withIndexFixture(async (client, schema, sql) => {
      await client.query(`CREATE ${kind.toUpperCase()} ${schema}.${indexName} ${definition}`)
      const stateQuery = 'SELECT oid, relkind FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass($1)'
      const stateParams = [`${schema}.${indexName}`]
      const original = await client.query(stateQuery, stateParams)
      expect(original.rows).toHaveLength(1)
      expect(await indexState(client, schema)).toBeUndefined()
      await client.query('BEGIN')
      await expect(client.query(sql)).rejects.toMatchObject({
        code: 'P0001',
        message: `${indexName} exists but is not an index; inspect it before retrying`,
      })
      await client.query('ROLLBACK')
      expect((await client.query(stateQuery, stateParams)).rows).toEqual(original.rows)
      await client.query(`DROP ${kind.toUpperCase()} ${schema}.${indexName}`)
      await client.query('BEGIN')
      await client.query(sql)
      expect(await indexState(client, schema)).toMatchObject({ indisvalid: true, indisready: true })
    })
  })

  it.concurrent.each([
    { name: 'missing key', definition: '(app_id, created_at DESC)' },
    { name: 'wrong key order', definition: '(deleted, app_id, created_at DESC)' },
    { name: 'ascending time order', definition: '(app_id, deleted, created_at ASC)' },
    { name: 'different null ordering', definition: '(app_id, deleted, created_at DESC NULLS LAST)' },
    { name: 'partial predicate', definition: '(app_id, deleted, created_at DESC) WHERE deleted = false' },
    { name: 'expression key', definition: '(lower(app_id), deleted, created_at DESC)' },
    { name: 'unique index', definition: '(app_id, deleted, created_at DESC)', unique: true },
    { name: 'wrong table', definition: '(app_id, deleted, created_at DESC)', otherTable: true },
  ])('rejects a valid same-name index with $name', async ({ definition, unique, otherTable }) => {
    await withIndexFixture(async (client, schema, sql) => {
      const table = otherTable ? 'other_versions' : 'versions'
      if (otherTable)
        await client.query(`CREATE TABLE ${schema}.other_versions (LIKE ${schema}.versions)`)
      await client.query(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${schema}.${table} ${definition}`)
      const mismatched = await indexState(client, schema)
      expect(mismatched).toMatchObject({ indisvalid: true, indisready: true })
      await client.query('BEGIN')
      await expect(client.query(sql)).rejects.toMatchObject({
        code: 'P0001',
        message: `${indexName} exists with an unexpected definition; inspect it before retrying`,
      })
      await client.query('ROLLBACK')
      expect(await indexState(client, schema)).toEqual(mismatched)
      await client.query(`DROP INDEX CONCURRENTLY ${schema}.${indexName}`)
      await client.query('BEGIN')
      await client.query(sql)
      expect(await indexState(client, schema)).toMatchObject({ indisvalid: true, indisready: true })
    })
  })

  it.concurrent('rejects a failed concurrent prebuild until it is removed and retried', async () => {
    await withIndexFixture(async (client, schema, sql) => {
      await client.query(`INSERT INTO ${schema}.versions(app_id) VALUES ('duplicate'), ('duplicate')`)
      await expect(client.query(`CREATE UNIQUE INDEX CONCURRENTLY ${indexName} ON ${schema}.versions (app_id)`))
        .rejects.toMatchObject({ code: '23505' })
      const invalid = await indexState(client, schema)
      expect(invalid).toMatchObject({ indisvalid: false })
      await client.query('BEGIN')
      await expect(client.query(sql)).rejects.toMatchObject({
        code: 'P0001',
        message: `${indexName} exists but is invalid or not ready; drop it concurrently and retry`,
      })
      await client.query('ROLLBACK')
      expect(await indexState(client, schema)).toEqual(invalid)
      await client.query(`DROP INDEX CONCURRENTLY ${schema}.${indexName}`)
      await client.query('BEGIN')
      await client.query(sql)
      expect(await indexState(client, schema)).toMatchObject({ indisvalid: true, indisready: true })
    })
  })
})
