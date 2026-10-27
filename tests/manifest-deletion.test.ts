import type { Context } from 'hono'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { INITIAL_MANIFEST_REQUEUE_CURSOR, requeueDeletedManifestBatch } from '../scripts/reclaim_deleted_version_manifests.ts'

const { getPgClient, closeClient, moveObjectToTrash, deleteObject } = vi.hoisted(() => ({
  getPgClient: vi.fn(),
  closeClient: vi.fn(),
  moveObjectToTrash: vi.fn(),
  deleteObject: vi.fn(),
}))
vi.mock('../supabase/functions/_backend/utils/pg.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>(),
  getPgClient,
  closeClient,
}))
vi.mock('../supabase/functions/_backend/utils/s3.ts', () => ({
  getPath: vi.fn(),
  s3: { moveObjectToTrash, deleteObject },
}))

const { deleteVersionManifestBatch } = await import('../supabase/functions/_backend/utils/manifest_cleanup.ts')
const { persistVersionManifestEntries } = await import('../supabase/functions/_backend/utils/manifest_persist.ts')
const { onVersionUpdateTestUtils } = await import('../supabase/functions/_backend/triggers/on_version_update.ts')

// A separate database preserves test isolation even when files run concurrently.
// The fixture has the production version/manifests key paths and counter types;
// real Drizzle transactions execute the actual cleanup and persistence SQL.
const dbName = `manifest_deletion_${randomUUID().replaceAll('-', '')}`
const parentUrl = env.SUPABASE_DB_URL ?? env.DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const admin = new Pool({ connectionString: parentUrl, max: 1 })
const dbUrl = new URL(parentUrl)
dbUrl.pathname = `/${dbName}`
const pool = new Pool({ connectionString: dbUrl.toString(), max: 4 })
const database = drizzle({ client: pool })
const c = { get: () => undefined } as unknown as Context
const appId = 'com.test.manifest.deletion'
const record = (id: number) => ({ id, app_id: appId }) as any

async function seedVersion(id: number, count: number, deleted = true, trackedCount = count) {
  await pool.query(`INSERT INTO public.app_versions (id, app_id, deleted, deleted_at, manifest_count)
    VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, $4)`, [id, appId, deleted, trackedCount])
  if (count > 0) {
    // Uploads store one shared delta_files row per file and one version_files row.
    await pool.query(`INSERT INTO public.delta_files (app_id, s3_path, file_name, file_hash, file_size, path_key, entry_key)
      SELECT $2, 'delta/file-' || i, 'file-' || i, 'hash-' || i, 42,
        public.delta_path_key('delta/file-' || i), public.delta_entry_key('delta/file-' || i, 'file-' || i, 'hash-' || i)
      FROM generate_series(1, $1::integer) i
      ON CONFLICT (entry_key) DO NOTHING`, [count, appId])
    await pool.query(`INSERT INTO public.version_files (app_version_id, file_ids)
      SELECT $1, array_agg(df.id ORDER BY df.id) FROM public.delta_files df
      WHERE df.entry_key IN (SELECT public.delta_entry_key('delta/file-' || i, 'file-' || i, 'hash-' || i) FROM generate_series(1, $2::integer) i)`, [id, count])
    await pool.query('UPDATE public.apps SET manifest_bundle_count = manifest_bundle_count + 1 WHERE app_id = $1', [appId])
  }
}

// Rows of the legacy table, for the one-off reclaim/requeue ops scripts that
// still target it on databases restored from before the cutover.
async function seedLegacyVersion(id: number, count: number, deleted = true, trackedCount = count) {
  await pool.query(`INSERT INTO public.app_versions (id, app_id, deleted, deleted_at, manifest_count)
    VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END, $4)`, [id, appId, deleted, trackedCount])
  await pool.query(`INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size)
    SELECT $1, 'file-' || i, 'hash-' || i, 'delta/file-' || i, 42 FROM generate_series(1, $2::integer) i`, [id, count])
  await pool.query('UPDATE public.apps SET manifest_bundle_count = manifest_bundle_count + 1 WHERE app_id = $1', [appId])
}

async function state(id: number) {
  const result = await pool.query(`SELECT av.manifest_count, av.manifest, a.manifest_bundle_count,
    (SELECT count(*)::int FROM public.manifest WHERE app_version_id = av.id) AS rows,
    (SELECT cardinality(file_ids) FROM public.version_files WHERE app_version_id = av.id) AS kept
    FROM public.app_versions av JOIN public.apps a USING (app_id) WHERE av.id = $1`, [id])
  return result.rows[0]
}

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${dbName}`)
  await pool.query(`CREATE TABLE public.apps (app_id text PRIMARY KEY, manifest_bundle_count bigint NOT NULL DEFAULT 0, updated_at timestamptz);
    CREATE TYPE public.manifest_entry AS (file_name character varying, s3_path character varying, file_hash character varying);
    CREATE TABLE public.app_versions (id bigint PRIMARY KEY, app_id text REFERENCES public.apps, deleted boolean DEFAULT false, storage_provider text NOT NULL DEFAULT 'r2-direct', created_at timestamptz DEFAULT now(),
      deleted_at timestamptz, manifest_count bigint NOT NULL DEFAULT 0, manifest public.manifest_entry[], updated_at timestamptz);
    CREATE TABLE public.manifest (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, app_version_id bigint REFERENCES public.app_versions ON DELETE CASCADE,
      file_name text, file_hash text, s3_path text, file_size bigint);
    CREATE INDEX idx_manifest_app_version_id_file_hash ON public.manifest (app_version_id, file_hash) INCLUDE (file_size);
    CREATE INDEX idx_app_versions_deleted_at_id ON public.app_versions (deleted_at, id) WHERE deleted = true;
    CREATE INDEX idx_app_versions_deleted_with_manifest ON public.app_versions (id) WHERE deleted = true AND manifest_count > 0;
    CREATE SCHEMA IF NOT EXISTS pgmq;
    CREATE TABLE pgmq.sent (queue_name text, message jsonb);
    CREATE FUNCTION pgmq.send(queue_name text, message jsonb) RETURNS bigint LANGUAGE sql
      AS $$ INSERT INTO pgmq.sent VALUES (queue_name, message); SELECT 1::bigint $$;
    CREATE TABLE public.delta_files (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, app_id text NOT NULL REFERENCES public.apps ON DELETE CASCADE,
      s3_path text NOT NULL, file_name text NOT NULL, file_hash text NOT NULL, file_size bigint NOT NULL DEFAULT 0,
      path_key bytea NOT NULL, entry_key bytea NOT NULL UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.version_files (app_version_id bigint PRIMARY KEY REFERENCES public.app_versions ON DELETE CASCADE,
      file_ids bigint[] NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE public.manifest_trash_restore_pending (app_version_id bigint REFERENCES public.app_versions ON DELETE CASCADE,
      s3_path text, created_at timestamptz DEFAULT now(), PRIMARY KEY (app_version_id, s3_path));`)
  await pool.query(`INSERT INTO public.apps (app_id) VALUES ('com.test.legacy.restore');
    INSERT INTO public.app_versions (id, app_id) VALUES (999, 'com.test.legacy.restore');
    INSERT INTO public.manifest_trash_restore_pending (app_version_id, s3_path) VALUES (999, 'delta/legacy');`)
  // Apply the actual migration to existing recovery state as well as fresh schemas.
  await pool.query(await readFile(new URL('../supabase/migrations/20261014101115_retain_manifest_delta_objects.sql', import.meta.url), 'utf8'))
  // Real delta storage key helpers (step 1 of the delta storage migration).
  const deltaStorage = await readFile(new URL('../supabase/migrations/20261027130100_delta_storage_backfill.sql', import.meta.url), 'utf8')
  for (const name of ['delta_entry_key', 'delta_canonical_path', 'delta_path_key']) {
    const definition = deltaStorage.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;\\n`))?.[0]
    if (!definition)
      throw new Error(`Missing ${name} in delta storage migration`)
    await pool.query(definition)
  }
  const cutover = await readFile(new URL('../supabase/migrations/20261027130101_delta_storage_v2.sql', import.meta.url), 'utf8')
  const lockKey = cutover.match(/CREATE FUNCTION public\.delta_gc_lock_key\([\s\S]*?\n\$\$;\n/)?.[0]
  if (!lockKey)
    throw new Error('Missing delta_gc_lock_key in delta storage migration')
  await pool.query(lockKey)
  getPgClient.mockResolvedValue(pool)
})

beforeEach(async () => {
  vi.clearAllMocks()
  await pool.query('TRUNCATE public.apps, public.app_versions, public.manifest, public.delta_files, public.version_files, pgmq.sent CASCADE')
  await pool.query('INSERT INTO public.apps (app_id) VALUES ($1)', [appId])
})

afterAll(async () => {
  await pool.end()
  // All fixture clients must close normally. FORCE can terminate a socket
  // during its graceful shutdown and surface an uncaught pg pool error in CI.
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`)
  await admin.end()
})

describe('manifest deletion Postgres effects', () => {
  it('keeps a deleted version\'s references and finalizes its counters exactly once under concurrent retries', async () => {
    await seedVersion(1, 5000)
    await seedVersion(2, 3000, false)
    await Promise.all(Array.from({ length: 8 }, () => onVersionUpdateTestUtils.deleteManifest(c, record(1))))
    // The deleted version keeps its 5,000 file references for the restore window.
    expect(await state(1)).toMatchObject({ kept: 5000, manifest_count: '0', manifest_bundle_count: '1' })
    expect(await state(2)).toMatchObject({ kept: 3000, manifest_count: '3000', manifest_bundle_count: '1' })
    expect(pool.totalCount).toBeLessThanOrEqual(4)
    expect(moveObjectToTrash).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('finalizes a deleted version in one transaction and stays idempotent on retries', async () => {
    await seedVersion(1, 2501)
    expect(await deleteVersionManifestBatch(database, 1)).toEqual({ deleted: 0, complete: true })
    expect(await state(1)).toMatchObject({ kept: 2501, manifest_count: '0', manifest_bundle_count: '0' })
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    expect(await state(1)).toMatchObject({ kept: 2501, manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('rolls back counter finalization as a whole when it fails', async () => {
    await seedVersion(1, 1001)
    await pool.query(`ALTER TABLE public.apps ADD CONSTRAINT reject_finalization CHECK (manifest_bundle_count > 0)`)
    try {
      await expect(deleteVersionManifestBatch(database, 1)).rejects.toThrow()
      expect(await state(1)).toMatchObject({ kept: 1001, manifest_count: '1001', manifest_bundle_count: '1' })
    }
    finally {
      await pool.query('ALTER TABLE public.apps DROP CONSTRAINT reject_finalization')
    }
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    expect(await state(1)).toMatchObject({ kept: 1001, manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('keeps an inline manifest that has no version_files and does not decrement an uncounted bundle', async () => {
    await seedVersion(1, 0)
    await pool.query(`UPDATE public.app_versions SET manifest = ARRAY[ROW('legacy', NULL, NULL)::public.manifest_entry] WHERE id = 1`)
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    // It is the only reference GC sees for this version, so it stays.
    expect(await state(1)).toMatchObject({ manifest: '{"(legacy,,)"}', manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('clears an inline manifest once the version has version_files', async () => {
    await seedVersion(1, 2)
    await pool.query(`UPDATE public.app_versions SET manifest = ARRAY[ROW('legacy', NULL, NULL)::public.manifest_entry] WHERE id = 1`)
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    expect(await state(1)).toMatchObject({ manifest: null, kept: 2, manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('fully removes the legacy recovery table, including existing records', async () => {
    expect((await pool.query('SELECT to_regclass(\'public.manifest_trash_restore_pending\') AS table_name')).rows[0].table_name).toBeNull()
  })

  it('sweeps stale counts, JSON manifests and legacy zero-count rows without premature finalization', async () => {
    await seedVersion(1, 0, true, 2)
    await seedVersion(2, 0)
    await seedLegacyVersion(3, 1, true, 0)
    await pool.query('UPDATE public.apps SET manifest_bundle_count = 2')
    await pool.query(`UPDATE public.app_versions SET manifest = ARRAY[ROW('legacy', NULL, NULL)::public.manifest_entry] WHERE id = 2`)
    expect((await pool.query('SELECT public.sweep_deleted_version_manifests(100) AS count')).rows[0].count).toBe('2')
    const client = await pool.connect()
    try {
      await requeueDeletedManifestBatch(client, INITIAL_MANIFEST_REQUEUE_CURSOR)
    }
    finally {
      client.release()
    }
    expect((await pool.query('SELECT public.sweep_deleted_version_manifests(100) AS count')).rows[0].count).toBe('3')
    expect(await state(1)).toMatchObject({ manifest_count: '2', manifest_bundle_count: '2' })
    expect(await state(2)).toMatchObject({ manifest: '{"(legacy,,)"}' })
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    await onVersionUpdateTestUtils.deleteManifest(c, record(2))
    await onVersionUpdateTestUtils.deleteManifest(c, record(3))
    // Legacy rows of a restored database are left for the reclaim scripts.
    expect(await state(3)).toMatchObject({ rows: 1, manifest_count: '0' })
    expect((await pool.query('SELECT public.sweep_deleted_version_manifests(100) AS count')).rows[0].count).toBe('1')
  })

  it('rotates bounded sweeps past unfinished versions without changing counters', async () => {
    for (let id = 1; id <= 3; id++)
      await seedVersion(id, 1)
    await pool.query('UPDATE public.app_versions SET updated_at = \'2020-01-01\'::timestamptz + id * interval \'1 second\'')
    const touched: number[] = []
    for (let i = 0; i < 3; i++) {
      await pool.query('SELECT public.sweep_deleted_version_manifests(1)')
      touched.push(Number((await pool.query('SELECT id FROM public.app_versions ORDER BY updated_at DESC LIMIT 1')).rows[0].id))
    }
    expect(touched).toEqual([1, 2, 3])
    expect(await state(1)).toMatchObject({ kept: 1, manifest_count: '1', manifest_bundle_count: '3' })
  })

  it('requires a concurrent index prebuild on large databases and accepts that prebuilt index', async () => {
    const migration = await readFile(new URL('../supabase/migrations/20261014101115_retain_manifest_delta_objects.sql', import.meta.url), 'utf8')
    await pool.query('INSERT INTO public.app_versions (id, app_id) SELECT i, $1 FROM generate_series(1,10001) i', [appId])
    await pool.query('DROP INDEX public.idx_app_versions_deleted_manifest_pending')
    try {
      await expect(pool.query(migration)).rejects.toThrow('Prebuild the index')
    }
    finally {
      await pool.query(await readFile(new URL('../scripts/ops/deleted_manifest_retry_index.sql', import.meta.url), 'utf8'))
    }
    await pool.query(migration)
  })

  it('resumes legacy requeue across bounded timestamp/id pages, microseconds and null dates without changing app counters', async () => {
    await pool.query(`INSERT INTO public.app_versions (id, app_id, deleted, deleted_at)
      SELECT i, $1, i <= 102, CASE WHEN i <= 100 THEN '2026-01-01 00:00:00.123456+00'::timestamptz
        + ((i - 1) % 2) * interval '1 microsecond' ELSE NULL END FROM generate_series(1,103) i`, [appId])
    await pool.query(`INSERT INTO public.manifest (app_version_id, file_name, file_hash, s3_path, file_size)
      SELECT i, 'file.js', 'hash', 'delta/shared.js', 1 FROM generate_series(1,103) i`)
    await pool.query('UPDATE public.apps SET manifest_bundle_count = 103')
    const client = await pool.connect()
    try {
      const first = await requeueDeletedManifestBatch(client, INITIAL_MANIFEST_REQUEUE_CURSOR)
      expect(first).toMatchObject({ scanned: 50, requeued: 50, cursor: { id: '99', phase: 'dated' } })
      expect(first.cursor.deletedAt).toContain('.123456')
      let cursor = first.cursor
      let marked = first.requeued
      while (cursor.phase !== 'done') {
        const next = await requeueDeletedManifestBatch(client, cursor)
        expect(next.scanned).toBeLessThanOrEqual(50)
        marked += next.requeued
        cursor = next.cursor
      }
      expect(marked).toBe(102)
    }
    finally {
      client.release()
    }
    expect(await state(103)).toMatchObject({ rows: 1, manifest_count: '0', manifest_bundle_count: '103' })
    expect((await pool.query('SELECT count(*)::int AS count FROM public.app_versions WHERE manifest_count = 1')).rows[0].count).toBe(102)
    expect(moveObjectToTrash).not.toHaveBeenCalled()
    expect(deleteObject).not.toHaveBeenCalled()
  })

  it('rolls back legacy requeue on a competing cleanup lock and can retry the same checkpoint', async () => {
    await seedLegacyVersion(1, 1, true, 0)
    const blocker = await pool.connect()
    const client = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_catalog.pg_advisory_xact_lock(1::bigint)')
      await expect(requeueDeletedManifestBatch(client, INITIAL_MANIFEST_REQUEUE_CURSOR)).rejects.toMatchObject({ versionIds: ['1'] })
      expect(await state(1)).toMatchObject({ manifest_count: '0', rows: 1 })
      await blocker.query('ROLLBACK')
      expect(await requeueDeletedManifestBatch(client, INITIAL_MANIFEST_REQUEUE_CURSOR)).toMatchObject({ requeued: 1 })
    }
    finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      client.release()
    }
  })

  it('preserves the original database error and failed IDs when the failure report cannot be saved', async () => {
    await seedLegacyVersion(1, 1, true, 0)
    await pool.query('ALTER TABLE public.manifest RENAME TO manifest_report_error_fixture')
    try {
      const result = spawnSync('bun', [fileURLToPath(new URL('../scripts/reclaim_deleted_version_manifests.ts', import.meta.url))], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...env,
          SUPABASE_DB_URL: dbUrl.toString(),
          MANIFEST_REQUEUE_CHECKPOINT: join(tmpdir(), `manifest-report-missing-${randomUUID()}`, 'state.json'),
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Failed to write failure report')
      expect(result.stderr).toContain('42P01')
      expect(result.stderr).toContain('"versionIds":["1"]')
    }
    finally {
      await pool.query('ALTER TABLE public.manifest_report_error_fixture RENAME TO manifest')
    }
  })

  it('serializes upload finalization with deletion and rejects a stale upload after cleanup', async () => {
    await seedVersion(1, 0, false)
    const upload = [{ file_name: 'file.js', file_hash: 'hash', s3_path: 'delta/file.js', file_size: 5 }]
    const blocker = await pool.connect()
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT pg_catalog.pg_advisory_xact_lock(1::bigint)')
      const pending = persistVersionManifestEntries(c, record(1), upload, { trustFileSizes: true })
      // Yield through a database round-trip while persistence waits for the lock.
      await blocker.query('UPDATE public.app_versions SET deleted = true, deleted_at = now() WHERE id = 1')
      await blocker.query('COMMIT')
      await expect(pending).rejects.toThrow('Deleted versions cannot receive manifest entries')
    }
    finally {
      await blocker.query('ROLLBACK')
      blocker.release()
    }
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    await expect(persistVersionManifestEntries(c, record(1), upload, { trustFileSizes: true })).rejects.toThrow('Deleted versions cannot receive manifest entries')
    expect(await state(1)).toMatchObject({ kept: null, manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('refuses new references once the upload is no longer in progress', async () => {
    await seedVersion(1, 0, false)
    await pool.query(`UPDATE public.app_versions SET storage_provider = 'r2' WHERE id = 1`)
    await expect(persistVersionManifestEntries(c, record(1), [{ file_name: 'file.js', file_hash: 'hash', s3_path: 'delta/file.js', file_size: 5 }], { trustFileSizes: true }))
      .rejects
      .toThrow('Only in-progress uploads can receive manifest entries')
    expect(await state(1)).toMatchObject({ kept: null })
  })

  it('refuses new references once GC no longer treats a stalled upload as in progress', async () => {
    await seedVersion(1, 0, false)
    await pool.query(`UPDATE public.app_versions SET created_at = now() - interval '2 days', updated_at = now() - interval '2 days' WHERE id = 1`)
    await expect(persistVersionManifestEntries(c, record(1), [{ file_name: 'file.js', file_hash: 'hash', s3_path: 'delta/file.js', file_size: 5 }], { trustFileSizes: true }))
      .rejects
      .toThrow('Only in-progress uploads can receive manifest entries')
  })

  it('does not remove references or counters for a live version', async () => {
    await seedVersion(1, 1, false)
    expect(await deleteVersionManifestBatch(database, 1)).toEqual({ deleted: 0, complete: true })
    expect(await state(1)).toMatchObject({ kept: 1, manifest_count: '1', manifest_bundle_count: '1' })
  })

  it('cleans a successful finalization that commits before the deletion transition', async () => {
    await seedVersion(1, 0, false)
    await persistVersionManifestEntries(c, record(1), [{ file_name: 'file.js', file_hash: 'hash', s3_path: 'delta/file.js', file_size: 5 }], { trustFileSizes: true })
    await pool.query('UPDATE public.app_versions SET deleted = true, deleted_at = now() WHERE id = 1')
    await onVersionUpdateTestUtils.deleteManifest(c, record(1))
    expect(await state(1)).toMatchObject({ kept: 1, manifest_count: '0', manifest_bundle_count: '0' })
  })

  it('registers a manifest on a reused backend whose session default is read-only', async () => {
    await seedVersion(1, 0, false)
    const client = await pool.connect()
    try {
      await client.query('SET default_transaction_read_only = on')
      // This is the same row-lock failure as a plain BEGIN on a contaminated pool.
      await expect(client.query('SELECT id FROM public.app_versions WHERE id = 1 FOR UPDATE')).rejects.toMatchObject({ code: '25006' })
      getPgClient.mockResolvedValue(client)
      await expect(persistVersionManifestEntries(c, record(1), [
        { file_name: 'file.js', file_hash: 'hash', s3_path: 'delta/file.js', file_size: 5 },
      ], { trustFileSizes: true })).resolves.toEqual({ inserted: 1, alreadyPresent: false })
      expect(await state(1)).toMatchObject({ kept: 1, manifest_count: '1', manifest_bundle_count: '1' })
      expect((await client.query('SHOW default_transaction_read_only')).rows[0].default_transaction_read_only).toBe('on')
    }
    finally {
      getPgClient.mockResolvedValue(pool)
      await client.query('RESET default_transaction_read_only')
      client.release()
    }
  })
})
