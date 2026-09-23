/**
 * Before/after timings for POST /updates/manifest_size.
 *
 * Local Postgres only. Setup drops the public schema.
 *
 *   docker run -d --name capgo-manifest-size-bench-pg \
 *     -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres \
 *     -e POSTGRES_DB=manifest_size_bench -p 55433:5432 postgres:17-alpine \
 *     -c shared_buffers=512MB -c work_mem=32MB -c maintenance_work_mem=512MB \
 *     -c max_wal_size=2GB -c jit=off
 *
 *   bun scripts/bench_manifest_size_lookup.ts
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client } from 'pg'
import { buildManifestSizeLookupQuery } from '../supabase/functions/_backend/utils/manifest_size.ts'

const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55433/manifest_size_bench'
const APP_ID = 'com.bench.size'
const NOISE_APP_ID = 'com.bench.noise'
const TARGET_VERSIONS = 80
const NOISE_VERSIONS = 400
const FILES_PER_VERSION = 2000
const RUNS = 5
const ROOT = resolve(import.meta.dirname, '..')

const OLD_SQL = `
WITH requested AS (
  SELECT file_hash, version_id
  FROM jsonb_to_recordset($1::jsonb) AS request_files(file_hash text, version_id bigint)
  WHERE file_hash IS NOT NULL
)
SELECT
  requested.file_hash,
  app_versions.id AS version_id,
  MAX(manifest.file_size) AS file_size
FROM requested
INNER JOIN public.app_versions
  ON app_versions.app_id = $2
  AND app_versions.deleted = false
  AND (
    (
      requested.version_id IS NOT NULL
      AND app_versions.id = requested.version_id
    ) OR (
      requested.version_id IS NULL
      AND (
        (
          $3::bigint IS NOT NULL
          AND app_versions.id = $3
        ) OR (
          $3::bigint IS NULL
          AND ($4::text IS NULL OR app_versions.name = $4)
        )
      )
    )
  )
INNER JOIN public.manifest
  ON manifest.app_version_id = app_versions.id
  AND manifest.file_hash = requested.file_hash
GROUP BY requested.file_hash, app_versions.id
`

interface Timing {
  rows: number
  timesMs: number[]
  medianMs: number
  minMs: number
  maxMs: number
}

interface ScenarioReport {
  name: string
  side: 'before' | 'after'
  timing: Timing | null
  skipped: string | null
  explain: string | null
}

function assertSafeUrl(databaseUrl: string) {
  const parsed = new URL(databaseUrl)
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  if (parsed.hostname !== '127.0.0.1' || parsed.port !== '55433' || dbName !== 'manifest_size_bench')
    throw new Error(`Refusing bench against ${parsed.hostname}:${parsed.port}/${dbName}`)
}

function hashes(count: number, versionId: number | null) {
  const files = []
  for (let i = 1; i <= count; i++)
    files.push({ file_name: `f${i}`, file_hash: `hash-${i}`, download_url: null, version_id: versionId })
  return files
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function timeQuery(client: Client, sql: string, params: unknown[]): Promise<Timing> {
  await client.query(sql, params)
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
    timesMs: timesMs.map(value => Math.round(value * 10) / 10),
    medianMs: Math.round(median(timesMs) * 10) / 10,
    minMs: Math.round(Math.min(...timesMs) * 10) / 10,
    maxMs: Math.round(Math.max(...timesMs) * 10) / 10,
  }
}

async function explain(client: Client, sql: string, params: unknown[]): Promise<string> {
  const result = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params)
  return result.rows.map((row: { 'QUERY PLAN': string }) => row['QUERY PLAN']).join('\n')
}

async function setup(client: Client) {
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    CREATE TABLE public.app_versions (
      id bigint PRIMARY KEY,
      app_id text NOT NULL,
      name text NOT NULL,
      deleted boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.manifest (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      app_version_id bigint NOT NULL REFERENCES public.app_versions(id),
      file_name text NOT NULL,
      file_hash text NOT NULL,
      file_size bigint NOT NULL,
      s3_path text NOT NULL
    );
    CREATE INDEX idx_app_id_app_versions ON public.app_versions (app_id);
    CREATE INDEX idx_app_id_name_app_versions ON public.app_versions (app_id, name);
  `)

  await client.query(`
    INSERT INTO public.app_versions (id, app_id, name, deleted)
    SELECT v, $1, v::text, false
    FROM generate_series(1, $2::int) AS v
  `, [APP_ID, TARGET_VERSIONS])
  await client.query(`
    INSERT INTO public.app_versions (id, app_id, name, deleted)
    SELECT v, $1, v::text, false
    FROM generate_series($2::int + 1, $2::int + $3::int) AS v
  `, [NOISE_APP_ID, TARGET_VERSIONS, NOISE_VERSIONS])

  await client.query(`
    INSERT INTO public.manifest (app_version_id, file_name, file_hash, file_size, s3_path)
    SELECT v, 'f' || f, 'hash-' || f, f * 10, v::text || '/' || f::text
    FROM generate_series(1, $1::int + $2::int) AS v
    CROSS JOIN generate_series(1, $3::int) AS f
  `, [TARGET_VERSIONS, NOISE_VERSIONS, FILES_PER_VERSION])

  await client.query(`
    CREATE INDEX idx_manifest_app_version_id ON public.manifest (app_version_id);
    CREATE INDEX idx_manifest_file_hash ON public.manifest (file_hash);
    ANALYZE public.app_versions;
    ANALYZE public.manifest;
  `)
}

async function swapToNewIndex(client: Client) {
  await client.query(`
    CREATE INDEX idx_manifest_app_version_id_file_hash
      ON public.manifest (app_version_id, file_hash) INCLUDE (file_size);
    DROP INDEX public.idx_manifest_app_version_id;
    ANALYZE public.manifest;
  `)
}

function planHeadline(explainText: string | null): string {
  if (!explainText)
    return 'no query'
  const scan = explainText.split('\n').find(line => /Scan|Nested Loop|Hash Join|Bitmap/.test(line) && !line.includes('Planning'))
  return (scan ?? explainText.split('\n')[0] ?? '').trim()
}

async function main() {
  assertSafeUrl(DATABASE_URL)
  const client = new Client({ connectionString: DATABASE_URL, statement_timeout: 120_000 })
  await client.connect()
  await client.query('SET jit = off')

  console.log('Seeding…')
  const seedStarted = performance.now()
  await setup(client)
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM public.manifest) AS manifest_rows,
      (SELECT count(*)::int FROM public.app_versions) AS versions
  `)
  console.log(`Seeded in ${Math.round((performance.now() - seedStarted) / 1000)}s`, counts.rows[0])

  const fullFiles = hashes(FILES_PER_VERSION, null)
  const partialFiles = hashes(100, null)
  const perFileVersion = hashes(FILES_PER_VERSION, 1)
  const scenarios: Array<{ name: string, files: ReturnType<typeof hashes>, versionName?: string, versionId?: number }> = [
    { name: 'fallback version id, 2000 hashes', files: fullFiles, versionId: 1 },
    { name: 'fallback version id, 100 hashes', files: partialFiles, versionId: 1 },
    { name: 'fallback version name, 2000 hashes', files: fullFiles, versionName: '1' },
    { name: 'per-file version id, 2000 hashes', files: perFileVersion },
    { name: 'no version, 2000 hashes', files: fullFiles },
  ]

  const reports: ScenarioReport[] = []
  for (const scenario of scenarios) {
    console.log(`BEFORE ${scenario.name}`)
    const params = [JSON.stringify(scenario.files), APP_ID, scenario.versionId ?? null, scenario.versionName ?? null]
    const timing = await timeQuery(client, OLD_SQL, params)
    const plan = await explain(client, OLD_SQL, params)
    reports.push({ name: scenario.name, side: 'before', timing, skipped: null, explain: plan })
    console.log(`  median ${timing.medianMs}ms rows ${timing.rows}`)
  }

  console.log('Building composite index…')
  const indexStarted = performance.now()
  await swapToNewIndex(client)
  console.log(`Index swap ${Math.round(performance.now() - indexStarted)}ms`)

  for (const scenario of scenarios) {
    console.log(`AFTER ${scenario.name}`)
    const lookup = buildManifestSizeLookupQuery(APP_ID, scenario.versionName, scenario.versionId, scenario.files)
    if (!lookup) {
      reports.push({
        name: scenario.name,
        side: 'after',
        timing: null,
        skipped: 'handler returns size_unknown and does not query',
        explain: null,
      })
      console.log('  skipped')
      continue
    }
    const timing = await timeQuery(client, lookup.text, lookup.values)
    const plan = await explain(client, lookup.text, lookup.values)
    reports.push({ name: scenario.name, side: 'after', timing, skipped: null, explain: plan })
    console.log(`  median ${timing.medianMs}ms rows ${timing.rows}`)
  }

  const settings = await client.query(`
    SELECT name, setting, unit
    FROM pg_settings
    WHERE name IN ('shared_buffers', 'work_mem', 'jit', 'server_version')
  `)
  await client.end()

  const lines = [
    '# Manifest size lookup before / after',
    '',
    `Local Postgres ${settings.rows.find((row: { name: string }) => row.name === 'server_version')?.setting ?? '17'}. Not production.`,
    '',
    `Seed: ${TARGET_VERSIONS} versions of \`${APP_ID}\` and ${NOISE_VERSIONS} versions of \`${NOISE_APP_ID}\`, ${FILES_PER_VERSION} identical hashes per version (${((TARGET_VERSIONS + NOISE_VERSIONS) * FILES_PER_VERSION).toLocaleString()} manifest rows). Same hash is repeated on every version so \`idx_manifest_file_hash\` is not selective.`,
    '',
    'Before uses the old `OR` join and `idx_manifest_app_version_id` plus `idx_manifest_file_hash`. After uses the split lookup and `idx_manifest_app_version_id_file_hash (app_version_id, file_hash) INCLUDE (file_size)`. `idx_manifest_file_hash` stays.',
    '',
    `Timings are the median of ${RUNS} hot-cache client round trips after one warmup. \`jit\` is off. \`statement_timeout\` is 120s.`,
    '',
    '| Scenario | Before median | After median | Before rows | After rows |',
    '| --- | ---: | ---: | ---: | ---: |',
  ]

  for (const scenario of scenarios) {
    const before = reports.find(report => report.name === scenario.name && report.side === 'before')
    const after = reports.find(report => report.name === scenario.name && report.side === 'after')
    const afterCell = after?.skipped ? 'no query' : `${after?.timing?.medianMs} ms`
    lines.push(`| ${scenario.name} | ${before?.timing?.medianMs} ms | ${afterCell} | ${before?.timing?.rows ?? ''} | ${after?.skipped ? '0' : after?.timing?.rows ?? ''} |`)
  }

  lines.push('', '## Plans', '')
  for (const report of reports) {
    lines.push(`### ${report.side} — ${report.name}`, '', planHeadline(report.explain), '')
    if (report.explain)
      lines.push('```', report.explain, '```', '')
    else
      lines.push(report.skipped ?? '', '')
  }

  lines.push('## Settings', '', '```', settings.rows.map((row: { name: string, setting: string, unit: string | null }) => `${row.name}=${row.setting}${row.unit ?? ''}`).join('\n'), '```', '')

  const summaryPath = resolve(ROOT, 'scripts/bench/manifest_size_lookup_summary.md')
  writeFileSync(summaryPath, `${lines.join('\n')}\n`)
  writeFileSync(resolve(ROOT, 'scripts/bench/manifest_size_lookup_results.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), counts: counts.rows[0], settings: settings.rows, reports }, null, 2)}\n`)
  console.log(`Wrote ${summaryPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
