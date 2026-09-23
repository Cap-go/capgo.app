/**
 * Primary-key version lookup vs scanning every version of the app.
 *
 * Uses the local bench Postgres already on 127.0.0.1:55433.
 * Creates schema pk_bench only. Does not touch public.
 *
 *   bun scripts/bench_manifest_version_pk.ts
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from 'pg'
import { buildManifestSizeLookupQuery } from '../supabase/functions/_backend/utils/manifest_size.ts'

const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55433/manifest_size_bench'
const APP_ID = 'com.bench.pk'
const LIVE_VERSION_ID = 1
const DELETED_VERSIONS = 2000
const LIVE_VERSIONS = 150
const FILES = 400
const RUNS = 5

const SCAN_SQL = `
WITH requested AS MATERIALIZED (
  SELECT DISTINCT file_hash, version_id
  FROM jsonb_to_recordset($1::jsonb) AS request_files(file_hash text, version_id bigint)
  WHERE file_hash IS NOT NULL
)
SELECT r.file_hash, av.id AS version_id, MAX(m.file_size) AS file_size
FROM requested r
INNER JOIN public.app_versions av
  ON av.id = r.version_id
 AND av.app_id = $2
 AND av.deleted = false
INNER JOIN public.manifest m
  ON m.app_version_id = av.id
 AND m.file_hash = r.file_hash
WHERE r.version_id IS NOT NULL
GROUP BY r.file_hash, av.id
`

function assertSafeUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl)
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55433' || dbName !== 'manifest_size_bench')
    throw new Error(`Refusing bench against ${parsed.hostname}:${parsed.port}/${dbName}`)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function timeQuery(client: Client, sql: string, params: unknown[]) {
  await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params)
  const timesMs: number[] = []
  let rows = 0
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now()
    const result = await client.query(sql, params)
    timesMs.push(performance.now() - started)
    rows = result.rowCount ?? 0
  }
  return {
    rows,
    medianMs: Math.round(median(timesMs) * 10) / 10,
    timesMs: timesMs.map(value => Math.round(value * 10) / 10),
  }
}

async function explain(client: Client, sql: string, params: unknown[]) {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params)
  return result.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n')
}

function planLine(explainText: string, pattern: RegExp) {
  return explainText.split('\n').map(line => line.trim()).find(line => pattern.test(line)) ?? ''
}

async function main() {
  assertSafeUrl(DATABASE_URL)
  const client = new Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 })
  await client.connect()
  await client.query('SET jit = off')
  await client.query('DROP SCHEMA IF EXISTS pk_bench CASCADE')
  await client.query('CREATE SCHEMA pk_bench')
  await client.query('SET search_path = pk_bench, public')
  await client.query(`
    CREATE TABLE pk_bench.app_versions (
      id bigint PRIMARY KEY,
      app_id text NOT NULL,
      name text NOT NULL,
      deleted boolean NOT NULL DEFAULT false
    );
    CREATE TABLE pk_bench.manifest (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      app_version_id bigint NOT NULL,
      file_hash text NOT NULL,
      file_size bigint NOT NULL
    );
    CREATE INDEX idx_app_id_app_versions ON pk_bench.app_versions (app_id);
  `)
  await client.query(`
    INSERT INTO pk_bench.app_versions (id, app_id, name, deleted)
    SELECT v, 'com.bench.other.' || v::text, '1.0.0', false
    FROM generate_series(100000, 100499) AS v
  `)
  await client.query('ANALYZE pk_bench.app_versions')
  await client.query(`
    INSERT INTO pk_bench.app_versions (id, app_id, name, deleted)
    SELECT v, $1, '1.0.0', v > $2
    FROM generate_series(1, $2::int + $3::int) AS v
  `, [APP_ID, LIVE_VERSIONS, DELETED_VERSIONS])
  await client.query(`
    INSERT INTO pk_bench.manifest (app_version_id, file_hash, file_size)
    SELECT 1, 'hash-' || f, f
    FROM generate_series(1, $1::int) AS f
  `, [FILES])
  await client.query(`
    CREATE INDEX idx_manifest_app_version_id_file_hash
      ON pk_bench.manifest (app_version_id, file_hash) INCLUDE (file_size);
    ANALYZE pk_bench.manifest;
  `)

  const files = Array.from({ length: FILES }, (_, index) => ({
    file_hash: `hash-${index + 1}`,
    version_id: LIVE_VERSION_ID,
  }))
  const scanSql = SCAN_SQL.replaceAll('public.', 'pk_bench.')
  const lookup = buildManifestSizeLookupQuery(APP_ID, undefined, undefined, files.map(file => ({
    file_name: file.file_hash,
    file_hash: file.file_hash,
    download_url: null,
    version_id: file.version_id,
  })))
  if (!lookup)
    throw new Error('lookup builder returned null')
  const pkSql = lookup.text.replaceAll('public.', 'pk_bench.')

  const before = await timeQuery(client, scanSql, lookup.values)
  const beforePlan = await explain(client, scanSql, lookup.values)
  const after = await timeQuery(client, pkSql, lookup.values)
  const afterPlan = await explain(client, pkSql, lookup.values)
  await client.query('DROP SCHEMA IF EXISTS pk_bench CASCADE')
  await client.end()

  const summary = [
    '# Version primary-key lookup',
    '',
    `Local Postgres on 127.0.0.1:55433, schema pk_bench, then dropped. Not production.`,
    '',
    `Seed: ${DELETED_VERSIONS} deleted versions and ${LIVE_VERSIONS} live versions of \`${APP_ID}\`, ${FILES} files on version ${LIVE_VERSION_ID}.`,
    '',
    'Before joins `app_versions` on `app_id` plus `id`. Stats are frozen before the fat app is inserted, matching the production misestimate. After is the `LATERAL` primary-key lookup from `buildManifestSizeLookupQuery`.',
    '',
    `Median of ${RUNS} hot runs after one warmup. jit off.`,
    '',
    '| | Median | Rows |',
    '| --- | ---: | ---: |',
    `| Scan every version | ${before.medianMs} ms | ${before.rows} |`,
    `| Primary-key lookup | ${after.medianMs} ms | ${after.rows} |`,
    '',
    '## Scan plan',
    '',
    planLine(beforePlan, /Bitmap Heap Scan on app_versions|Execution Time/),
    '',
    '```',
    beforePlan,
    '```',
    '',
    '## Primary-key plan',
    '',
    planLine(afterPlan, /Index Scan using app_versions_pkey|Index Only Scan using idx_manifest/),
    '',
    '```',
    afterPlan,
    '```',
    '',
  ].join('\n')

  const summaryPath = resolve(import.meta.dirname, 'bench/manifest_version_pk_summary.md')
  writeFileSync(summaryPath, summary)
  console.log(summary)
  console.log(`Wrote ${summaryPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
