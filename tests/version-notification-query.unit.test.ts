import type { Context } from 'hono'
import { createPgliteEngine } from 'tinbase'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn(), getPgClient: vi.fn(), closeClient: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: mocks.getPgClient,
  closeClient: mocks.closeClient,
}))

const { shouldSkipVersionNotifications } = await import('../supabase/functions/_backend/utils/version_notifications.ts')
const context = {} as Context
let database: Awaited<ReturnType<typeof createPgliteEngine>>
const appId = 'com.example.notifications'

beforeAll(async () => {
  database = await createPgliteEngine()
  await database.exec(`
    CREATE TYPE public.manifest_entry AS (file_name varchar, s3_path varchar, file_hash varchar);
    CREATE TABLE public.app_versions (
      id bigint PRIMARY KEY, app_id text NOT NULL, name text DEFAULT '1.0.0',
      deleted boolean DEFAULT false, deleted_at timestamptz,
      storage_provider text DEFAULT 'r2', r2_path text, external_url text,
      manifest public.manifest_entry[],
      checksum text, session_key text
    );
    CREATE TABLE public.manifest (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      app_version_id bigint NOT NULL, s3_path text
    );
    CREATE INDEX manifest_version_idx ON public.manifest(app_version_id);
    CREATE TABLE public.onboarding_demo_data (
      app_id text, relation_name text, row_key text,
      UNIQUE (app_id, relation_name, row_key)
    );
    CREATE TABLE public.deploy_history (id bigint PRIMARY KEY, app_id text, version_id bigint);
  `)
}, 30_000)

afterAll(async () => database?.close())
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.query.mockImplementation((sql: string, params: unknown[]) => database.query(sql, params))
  mocks.getPgClient.mockResolvedValue({ query: mocks.query })
  await database.exec('TRUNCATE public.app_versions, public.manifest, public.onboarding_demo_data, public.deploy_history')
  await database.query('INSERT INTO public.app_versions(id, app_id) VALUES (123, $1)', [appId])
  await database.query('INSERT INTO public.deploy_history VALUES (456, $1, 123)', [appId])
})

async function addManifest(paths: Array<string | null>) {
  for (const path of paths)
    await database.query('INSERT INTO public.manifest(app_version_id, s3_path) VALUES (123, $1)', [path])
}

async function track(relation = 'app_versions', key = '123', app = appId) {
  await database.query('INSERT INTO public.onboarding_demo_data VALUES ($1, $2, $3)', [app, relation, key])
}

describe('version notification provenance on Postgres', () => {
  it('allows a real version whose manifest paths are not demo paths', async () => {
    await addManifest(['orgs/example/apps/example/index.html'])
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
    expect(mocks.getPgClient).toHaveBeenCalledExactlyOnceWith(context)
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it('allows a new version before its upload metadata and manifest arrive', async () => {
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
  })

  it('skips a nonexistent app and bigint version without failing the trigger lookup', async () => {
    expect(await shouldSkipVersionNotifications(context, 'nonexistent.app', Number.MAX_SAFE_INTEGER)).toBe(true)
  })

  it('reads fresh eligibility after a version changes behind a Hyperdrive query cache', async () => {
    const cache = new Map<string, Awaited<ReturnType<typeof database.query>>>()
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      const key = JSON.stringify([sql, params])
      // Hyperdrive excludes queries containing stable functions such as now().
      const cacheable = !/\bnow\s*\(/i.test(sql)
      if (cacheable && cache.has(key))
        return cache.get(key)
      const result = await database.query(sql, params)
      if (cacheable)
        cache.set(key, result)
      return result
    })
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
    await database.exec('UPDATE public.app_versions SET deleted = true WHERE id = 123')
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(true)
  })

  it('propagates a rejected primary query and still closes the client', async () => {
    const failure = new Error('temporary primary query failure')
    mocks.query.mockRejectedValueOnce(failure)
    await expect(shouldSkipVersionNotifications(context, appId, 123)).rejects.toBe(failure)
    expect(mocks.closeClient).toHaveBeenCalledOnce()
  })

  it('suppresses an exactly tracked demo version', async () => {
    await track()
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(true)
  })

  it('suppresses an exactly tracked demo deployment', async () => {
    await track('deploy_history', '456')
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
  })

  it('suppresses deployment of a demo version even without deployment provenance', async () => {
    await track()
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
  })

  it('does not match another app, relation, or entity with overlapping identifiers', async () => {
    await track('app_versions', '123', 'com.example.other')
    await track('app_versions', '124')
    await track('manifest', '123')
    await track('deploy_history', '457')
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(false)
  })

  it('recognizes untracked legacy versions whose files all use reserved demo paths', async () => {
    await addManifest([`demo/${appId}/1.0.0/index.html`, `demo/${appId}/1.0.0/main.js`])
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(true)
  })

  it.each([
    ['demo-only', ['demo/com.example.notifications/index.html'], true],
    ['mixed', ['demo/com.example.notifications/index.html', 'orgs/example/main.js'], false],
    ['empty', [], false],
    ['null path', [null], false],
  ])('classifies an inline-only %s legacy manifest', async (_name, paths, expected) => {
    await database.query(`UPDATE public.app_versions SET manifest = ARRAY(
      SELECT ROW('index.html', path, 'hash')::public.manifest_entry
      FROM unnest($1::text[]) path
    ) WHERE id = 123`, [paths])
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(expected)
  })

  it('preserves real inline files when relational files look like a demo', async () => {
    await addManifest([`demo/${appId}/index.html`])
    await database.query(`UPDATE public.app_versions
      SET manifest = ARRAY[ROW('main.js', 'orgs/example/main.js', 'hash')::public.manifest_entry]
      WHERE id = 123`)
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
  })

  it.each([
    ['mixed real and demo paths', ['demo/com.example.notifications/index.html', 'orgs/example/main.js']],
    ['a missing storage path', ['demo/com.example.notifications/index.html', null]],
    ['a different app demo prefix', ['demo/com.example.other/index.html']],
    ['a similar app prefix', ['demo/com.example.notifications.other/index.html']],
  ])('does not classify %s as a legacy demo', async (_name, paths) => {
    await addManifest(paths)
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
  })

  it.each(['r2_path', 'external_url', 'checksum', 'session_key'])('preserves real %s evidence', async (column) => {
    await addManifest([`demo/${appId}/index.html`])
    // Columns are fixed by the test cases, never supplied by a caller.
    await database.query(`UPDATE public.app_versions SET ${column} = $1 WHERE id = 123`, ['real-upload'])
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(false)
  })

  it.each(['deleted = true', "deleted_at = '2026-01-01'"])('skips a version with %s', async (assignment) => {
    await database.exec(`UPDATE public.app_versions SET ${assignment} WHERE id = 123`)
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(true)
  })

  it('skips a removed version after its demo provenance was also cleaned up', async () => {
    await database.exec('DELETE FROM public.app_versions')
    expect(await shouldSkipVersionNotifications(context, appId, 123)).toBe(true)
  })

  it('skips a removed deployment even when the version remains', async () => {
    await database.exec('DELETE FROM public.deploy_history')
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
  })

  it('skips a deployment whose version or app does not match the queued event', async () => {
    await database.exec('UPDATE public.deploy_history SET version_id = 124')
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
    await database.query('UPDATE public.deploy_history SET version_id = 123, app_id = $1', ['com.example.other'])
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
  })

  it('handles an app ID containing LIKE wildcards using literal prefix matching', async () => {
    const wildcardApp = 'com.example.%_app'
    await database.query('UPDATE public.app_versions SET app_id = $1', [wildcardApp])
    await addManifest(['demo/com.example.otherapp/index.html'])
    expect(await shouldSkipVersionNotifications(context, wildcardApp, 123)).toBe(false)
  })

  it('uses indexed lookups for a 5k-file version among unrelated versions and manifest rows', async () => {
    await database.exec(`
      INSERT INTO public.app_versions(id, app_id)
      SELECT id, 'com.example.noise' FROM generate_series(1000, 10999) id;
      UPDATE public.app_versions SET manifest = ARRAY(
        SELECT ROW('file-' || id, 'demo/com.example.notifications/file-' || id, 'hash')::public.manifest_entry
        FROM generate_series(1, 5000) id
      ) WHERE id = 123;
      INSERT INTO public.deploy_history(id, app_id, version_id)
      SELECT id, 'com.example.noise', id FROM generate_series(1000, 10999) id;
      INSERT INTO public.manifest(app_version_id, s3_path)
      SELECT 1000 + id % 10000, 'orgs/noise/file' FROM generate_series(1, 100000) id;
      INSERT INTO public.manifest(app_version_id, s3_path)
      SELECT 123, 'demo/${appId}/file-' || id FROM generate_series(1, 5000) id;
      INSERT INTO public.onboarding_demo_data
      SELECT 'com.example.noise', 'app_versions', id::text FROM generate_series(1000, 10999) id;
      ANALYZE;
    `)
    expect(await shouldSkipVersionNotifications(context, appId, 123, 456)).toBe(true)
    const [sql, params] = mocks.query.mock.lastCall!
    const { rows } = await database.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params)
    const plan = JSON.stringify(rows)
    expect(plan).not.toContain('Seq Scan')
    expect(plan).toContain('manifest_version_idx')
    expect(plan).toContain('app_versions_pkey')
  }, 30_000)
})
