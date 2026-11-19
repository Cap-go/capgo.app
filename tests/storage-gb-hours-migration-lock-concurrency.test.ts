import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseMigrationFiles } from '../scripts/local-db.ts'
import {
  invertStorageMigrationLockOrder,
  readStorageGbHoursMigrationSql,
} from './storage-gb-hours-migration-lock-helpers.ts'
import { ORG_ID, POSTGRES_URL } from './test-utils.ts'

const DEMO_APP = 'com.demo.app'
const STORAGE_MIGRATION_VERSION = '20261118193000'

const REPLACE_HOURLY_SQL = `SELECT public.replace_app_storage_hourly(
  $1::varchar,
  $2::uuid,
  CURRENT_DATE,
  CURRENT_DATE + 1,
  CURRENT_DATE + 2,
  '-infinity'::timestamptz,
  '[]'::jsonb,
  pg_catalog.clock_timestamp(),
  true)`

/** Pre-deploy writer: FOR SHARE on apps, then writes daily_storage_hourly (legacy pk). */
const LEGACY_CRON_WRITER_SQL = `
CREATE OR REPLACE FUNCTION public.replace_app_storage_hourly(
    p_app_id character varying,
    p_owner_org uuid,
    p_cycle_start_day date,
    p_cycle_end_day date,
    p_end_exclusive_day date,
    p_segment_start timestamptz,
    p_rows jsonb,
    p_written_at timestamptz,
    p_require_current_owner boolean DEFAULT true,
    p_app_uuid uuid DEFAULT NULL,
    p_calculated_until timestamptz DEFAULT NULL,
    p_transfer_count integer DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF p_require_current_owner THEN
    PERFORM 1
    FROM public.apps
    WHERE apps.app_id = p_app_id
      AND apps.owner_org = p_owner_org
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN;
    END IF;
  END IF;
  INSERT INTO public.daily_storage_hourly (app_id, owner_org, date, storage_byte_hours, updated_at)
  VALUES (p_app_id, p_owner_org, CURRENT_DATE, 1, pg_catalog.clock_timestamp())
  ON CONFLICT (app_id, date) DO UPDATE
    SET storage_byte_hours = EXCLUDED.storage_byte_hours,
        updated_at = EXCLUDED.updated_at;
END;
$$;
GRANT EXECUTE ON FUNCTION public.replace_app_storage_hourly(
  character varying, uuid, date, date, date, timestamptz, jsonb, timestamptz, boolean, uuid, timestamptz, integer
) TO service_role;
`

function supabaseAdminUrl(baseUrl: string) {
  const url = new URL(baseUrl)
  url.username = 'supabase_admin'
  return url.toString()
}

function databaseUrl(baseUrl: string, database: string) {
  const url = new URL(baseUrl)
  url.pathname = `/${database}`
  return url.toString()
}

async function terminateDatabaseConnections(admin: Client, database: string) {
  await admin.query(
    `SELECT pg_terminate_backend(activity.pid)
     FROM pg_catalog.pg_stat_activity activity
     WHERE activity.datname = $1
       AND activity.pid <> pg_catalog.pg_backend_pid()`,
    [database],
  )
}

async function dropDatabase(admin: Client, database: string) {
  await terminateDatabaseConnections(admin, database)
  await admin.query(`DROP DATABASE IF EXISTS ${database}`)
}

async function runSqlFile(client: Client, sql: string, label: string) {
  try {
    await client.query(sql)
  }
  catch (error) {
    throw new Error(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

async function provisionBeforeStorageMigration(targetUrl: string) {
  const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
  const supabaseDir = resolve(repoRoot, 'supabase')
  const bootstrapClient = new Client({ connectionString: supabaseAdminUrl(targetUrl) })
  await bootstrapClient.connect()
  try {
    await runSqlFile(
      bootstrapClient,
      readFileSync(resolve(repoRoot, 'tests/fixtures/local-db-disposable-auth-stub.sql'), 'utf8'),
      'local-db-disposable-auth-stub.sql',
    )
    await runSqlFile(
      bootstrapClient,
      readFileSync(resolve(supabaseDir, 'bootstrap.sql'), 'utf8'),
      'bootstrap.sql',
    )
  }
  finally {
    await bootstrapClient.end()
  }

  const client = new Client({ connectionString: targetUrl })
  await client.connect()
  try {
    const migrations = parseMigrationFiles(readdirSync(resolve(supabaseDir, 'migrations')))
      .filter(migration => migration.version < STORAGE_MIGRATION_VERSION)
    for (const migration of migrations) {
      const sql = readFileSync(resolve(supabaseDir, 'migrations', migration.file), 'utf8')
      await runSqlFile(client, sql, migration.file)
    }

    await runSqlFile(client, readFileSync(resolve(repoRoot, 'supabase/seed.sql'), 'utf8'), 'seed.sql')
    await runSqlFile(client, LEGACY_CRON_WRITER_SQL, 'legacy replace_app_storage_hourly')
  }
  finally {
    await client.end()
  }
}

async function waitForMigratorLocks(
  observer: Client,
  migratorPid: number,
  relationNames: string[],
  deadlineMs = 120_000,
) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const locks = await observer.query<{ relname: string }>(
      `SELECT c.relname
       FROM pg_catalog.pg_locks locks
       INNER JOIN pg_catalog.pg_class c ON c.oid = locks.relation
       INNER JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE locks.pid = $1
         AND locks.granted
         AND locks.locktype = 'relation'
         AND n.nspname = 'public'
         AND c.relname = ANY($2::text[])`,
      [migratorPid, relationNames],
    )
    if (relationNames.every(name => locks.rows.some(row => row.relname === name)))
      return locks.rows.map(row => row.relname)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`migrator pid ${migratorPid} did not grant locks on ${relationNames.join(', ')}`)
}

async function waitForRelationLockWait(observer: Client, pid: number, deadlineMs = 30_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const blocked = await observer.query(
      `SELECT 1
       FROM pg_catalog.pg_locks waiting
       INNER JOIN pg_catalog.pg_stat_activity blocked
         ON blocked.pid = waiting.pid
       WHERE waiting.pid = $1
         AND waiting.locktype = 'relation'
         AND waiting.granted = false
         AND blocked.wait_event_type = 'Lock'
       LIMIT 1`,
      [pid],
    )
    if (blocked.rowCount === 1)
      return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`pid ${pid} did not enter a relation lock wait`)
}

interface ConcurrentRunResult {
  migration: PromiseSettledResult<unknown>
  writer: PromiseSettledResult<unknown>
}

async function runMigrationWithConcurrentWriter(
  dbUrl: string,
  migrationSql: string,
  waitRelations: string[],
): Promise<ConcurrentRunResult> {
  const migrator = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 })
  const writer = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 })
  const observer = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 })
  await Promise.all([migrator.connect(), writer.connect(), observer.connect()])

  try {
    const migratorPid = (await migrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
    const migrationPromise = migrator.query(migrationSql)

    await waitForMigratorLocks(observer, migratorPid, waitRelations)

    const writerPromise = (async () => {
      await writer.query('BEGIN')
      await writer.query(`SET LOCAL lock_timeout = '5s'`)
      await writer.query(REPLACE_HOURLY_SQL, [DEMO_APP, ORG_ID])
      await writer.query('COMMIT')
    })()

    await waitForRelationLockWait(observer, writerPid)

    const [migration, writerResult] = await Promise.allSettled([migrationPromise, writerPromise])
    return { migration, writer: writerResult }
  }
  finally {
    await migrator.query('ROLLBACK').catch(() => undefined)
    await writer.query('ROLLBACK').catch(() => undefined)
    await Promise.all([migrator.end(), writer.end(), observer.end()])
  }
}

describe('storage gb-hours migration SQL vs replace_app_storage_hourly', () => {
  const templateDb = `stor_gb_lock_tpl_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const adminUrl = POSTGRES_URL

  beforeAll(async () => {
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    try {
      await admin.query(`CREATE DATABASE ${templateDb}`)
      await provisionBeforeStorageMigration(databaseUrl(adminUrl, templateDb))
    }
    finally {
      await admin.end()
    }
  }, 600_000)

  afterAll(async () => {
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    try {
      await dropDatabase(admin, templateDb)
    }
    finally {
      await admin.end()
    }
  })

  async function withFreshDatabase<T>(run: (dbUrl: string) => Promise<T>) {
    const runDb = `stor_gb_lock_run_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const admin = new Client({ connectionString: adminUrl })
    await admin.connect()
    try {
      await admin.query(`CREATE DATABASE ${runDb} TEMPLATE ${templateDb}`)
      return await run(databaseUrl(adminUrl, runDb))
    }
    finally {
      await dropDatabase(admin, runDb)
      await admin.end()
    }
  }

  it('applies the real migration SQL with a concurrent cron writer and does not deadlock', async () => {
    await withFreshDatabase(async (dbUrl) => {
      const result = await runMigrationWithConcurrentWriter(
        dbUrl,
        readStorageGbHoursMigrationSql(),
        ['apps'],
      )
      expect(result.migration.status).toBe('fulfilled')
      expect(result.writer.status).toBe('fulfilled')
    })
  }, 300_000)

  it('mutation: inverted lock order in migration SQL fails under the same writer', async () => {
    await withFreshDatabase(async (dbUrl) => {
      const inverted = invertStorageMigrationLockOrder(readStorageGbHoursMigrationSql())
      expect(inverted).not.toEqual(readStorageGbHoursMigrationSql())

      const result = await runMigrationWithConcurrentWriter(
        dbUrl,
        inverted,
        ['daily_storage_hourly'],
      )

      const migrationFailed = result.migration.status === 'rejected'
      const writerFailed = result.writer.status === 'rejected'
      expect(migrationFailed || writerFailed).toBe(true)
      if (migrationFailed && result.migration.status === 'rejected') {
        const code = (result.migration.reason as { code?: string })?.code
        expect(['40P01', '55P03', '57014']).toContain(code)
      }
    })
  }, 300_000)
})