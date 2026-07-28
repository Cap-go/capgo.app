#!/usr/bin/env bun
/**
 * Load-test the /updates manifest query hypothesis in a local Postgres.
 *
 * Compares production-shaped SQL paths:
 *   OLD: channel lookup LEFT JOIN manifest + json_agg + GROUP BY
 *        (paid on every check when the app has manifests, including up-to-date)
 *   NEW: light channel lookup, then indexed
 *        SELECT … FROM manifest WHERE app_version_id = $1
 *        (only on the new-version path; overlaps gates in the app code)
 *
 * Usage:
 *   bun scripts/bench_updates_manifest_path.ts
 *   bun scripts/bench_updates_manifest_path.ts --files 5000 --concurrency 50 --requests 1000
 *   DATABASE_URL=postgres://… bun scripts/bench_updates_manifest_path.ts
 *
 * Default DATABASE_URL points at the local docker bench container on :55432.
 *
 * Exit code 1 if the new-version path regresses beyond the gate (see PASS_GATE).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Client, Pool } from 'pg'

interface LatencyStats {
  count: number
  minMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  qps: number
  rowBytesApprox: number
}

interface ScenarioResult {
  name: string
  path: 'old_json_agg' | 'new_deferred'
  scenario: 'up_to_date' | 'new_version'
  files: number
  concurrency: number
  stats: LatencyStats
  explain?: string
}

interface BenchReport {
  generatedAt: string
  gitHead: string
  databaseUrlHost: string
  files: number
  concurrency: number
  requests: number
  warmup: number
  results: ScenarioResult[]
  gates: {
    newVersionP95RegressionPct: number
    newVersionP95DeltaMs: number
    upToDateP95ImprovementPct: number
    passed: boolean
    reasons: string[]
  }
}

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_URL = 'postgres://postgres:postgres@127.0.0.1:55432/manifest_bench'

function argValue(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag)
  if (idx >= 0 && process.argv[idx + 1])
    return process.argv[idx + 1]!
  return fallback
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0)
    return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

function statsOf(samplesMs: number[], wallSec: number, rowBytesApprox: number): LatencyStats {
  const sorted = [...samplesMs].sort((a, b) => a - b)
  const sum = samplesMs.reduce((a, b) => a + b, 0)
  return {
    count: samplesMs.length,
    minMs: sorted[0] ?? 0,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: samplesMs.length ? sum / samplesMs.length : 0,
    qps: wallSec > 0 ? samplesMs.length / wallSec : 0,
    rowBytesApprox,
  }
}

async function setupSchema(client: Client) {
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE app_versions (
      id bigint PRIMARY KEY,
      app_id text NOT NULL,
      name text NOT NULL,
      deleted boolean NOT NULL DEFAULT false,
      r2_path text,
      external_url text,
      checksum text,
      key_id text,
      session_key text,
      manifest_count integer NOT NULL DEFAULT 0
    );

    CREATE TABLE channels (
      id bigint PRIMARY KEY,
      app_id text NOT NULL,
      name text NOT NULL,
      version bigint REFERENCES app_versions(id),
      public boolean NOT NULL DEFAULT true,
      allow_device_self_set boolean NOT NULL DEFAULT false,
      ios boolean NOT NULL DEFAULT true,
      android boolean NOT NULL DEFAULT true,
      electron boolean NOT NULL DEFAULT true
    );

    CREATE TABLE manifest (
      app_version_id bigint NOT NULL REFERENCES app_versions(id) ON DELETE CASCADE,
      file_name text NOT NULL,
      file_hash text NOT NULL,
      s3_path text NOT NULL
    );

    -- Production index used by the deferred path
    CREATE INDEX idx_manifest_app_version_id ON manifest USING btree (app_version_id);
    CREATE INDEX idx_channels_app_name ON channels (app_id, name);
  `)
}

async function seed(client: Client, files: number, noiseVersions = 40) {
  // Live channel points at version 1002. Extra versions fill the table so
  // idx_manifest_app_version_id is selective (prod: millions of rows, many versions).
  const versionRows: string[] = []
  for (let v = 1001; v <= 1001 + noiseVersions; v++) {
    versionRows.push(`(${v}, 'com.bench.manifest', '${(v - 1000)}.0.0', false, NULL, 'checksum-${v}', ${files})`)
  }
  await client.query(`
    INSERT INTO app_versions (id, app_id, name, deleted, r2_path, checksum, manifest_count)
    VALUES ${versionRows.join(',')}
  `)

  await client.query(`
    INSERT INTO channels (id, app_id, name, version, public, ios, android)
    VALUES (1, 'com.bench.manifest', 'production', 1002, true, true, true)
  `)

  const batchSize = 500
  const versionsToFill = Array.from({ length: noiseVersions + 1 }, (_, i) => 1001 + i)
  for (const versionId of versionsToFill) {
    for (let offset = 0; offset < files; offset += batchSize) {
      const values: unknown[] = []
      const placeholders: string[] = []
      const end = Math.min(files, offset + batchSize)
      let p = 1
      for (let i = offset; i < end; i++) {
        placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++})`)
        values.push(
          versionId,
          `assets/file-${i}.js`,
          `hash-${versionId}-${i}`,
          `apps/com.bench.manifest/${versionId}/file-${i}.js`,
        )
      }
      await client.query(
        `INSERT INTO manifest (app_version_id, file_name, file_hash, s3_path) VALUES ${placeholders.join(',')}`,
        values,
      )
    }
  }

  await client.query('ANALYZE app_versions')
  await client.query('ANALYZE channels')
  await client.query('ANALYZE manifest')
}

/** OLD hot path: channel + version + json_agg(manifest) in one statement */
const OLD_CHANNEL_WITH_MANIFEST = `
SELECT
  c.id AS channel_id,
  c.name AS channel_name,
  v.id AS version_id,
  v.name AS version_name,
  COALESCE(json_agg(
    json_build_object(
      'file_name', m.file_name,
      'file_hash', m.file_hash,
      's3_path', m.s3_path
    )
  ) FILTER (WHERE m.file_name IS NOT NULL), '[]'::json) AS manifest_entries
FROM channels c
LEFT JOIN app_versions v
  ON c.version = v.id
 AND (v.deleted = false OR v.name = 'builtin')
LEFT JOIN manifest m
  ON m.app_version_id = v.id
WHERE c.app_id = $1
  AND c.name = $2
  AND c.android = true
  AND (c.public = true OR c.allow_device_self_set = true)
GROUP BY c.id, v.id
ORDER BY c.name, c.id
LIMIT 1
`

/** NEW light channel lookup (no manifest join) */
const NEW_CHANNEL_LIGHT = `
SELECT
  c.id AS channel_id,
  c.name AS channel_name,
  v.id AS version_id,
  v.name AS version_name
FROM channels c
LEFT JOIN app_versions v
  ON c.version = v.id
 AND (v.deleted = false OR v.name = 'builtin')
WHERE c.app_id = $1
  AND c.name = $2
  AND c.android = true
  AND (c.public = true OR c.allow_device_self_set = true)
ORDER BY c.name, c.id
LIMIT 1
`

/** NEW deferred indexed manifest fetch */
const NEW_MANIFEST_BY_VERSION = `
SELECT file_name, file_hash, s3_path
FROM manifest
WHERE app_version_id = $1
`

async function runOldPathMeasured(pool: Pool, appId: string, channel: string): Promise<{ ms: number, bytes: number, files: number }> {
  const start = performance.now()
  const res = await pool.query(OLD_CHANNEL_WITH_MANIFEST, [appId, channel])
  const entries = res.rows[0]?.manifest_entries ?? []
  return {
    ms: performance.now() - start,
    bytes: JSON.stringify(entries).length,
    files: Array.isArray(entries) ? entries.length : 0,
  }
}

async function runNewUpToDate(pool: Pool, appId: string, channel: string): Promise<{ ms: number, bytes: number, files: number }> {
  const start = performance.now()
  const res = await pool.query(NEW_CHANNEL_LIGHT, [appId, channel])
  return {
    ms: performance.now() - start,
    bytes: JSON.stringify(res.rows[0] ?? {}).length,
    files: 0,
  }
}

async function runNewVersion(pool: Pool, appId: string, channel: string): Promise<{ ms: number, bytes: number, files: number }> {
  const start = performance.now()
  // App code overlaps these with gates; here we measure the DB critical path as
  // light channel + indexed select (sequential worst case for DB time).
  const channelRes = await pool.query(NEW_CHANNEL_LIGHT, [appId, channel])
  const versionId = channelRes.rows[0]?.version_id
  const manifestRes = await pool.query(NEW_MANIFEST_BY_VERSION, [versionId])
  return {
    ms: performance.now() - start,
    bytes: JSON.stringify(manifestRes.rows).length,
    files: manifestRes.rows.length,
  }
}

async function loadScenario(
  pool: Pool,
  name: string,
  path: ScenarioResult['path'],
  scenario: ScenarioResult['scenario'],
  files: number,
  concurrency: number,
  requests: number,
  warmup: number,
  fn: () => Promise<{ ms: number, bytes: number, files: number }>,
): Promise<ScenarioResult> {
  for (let i = 0; i < warmup; i++)
    await fn()

  const samples: number[] = []
  let bytes = 0
  let fileCount = 0
  let next = 0
  const wallStart = performance.now()

  async function worker() {
    while (true) {
      const i = next++
      if (i >= requests)
        return
      const r = await fn()
      samples.push(r.ms)
      bytes = r.bytes
      fileCount = r.files
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const wallSec = (performance.now() - wallStart) / 1000
  const s = statsOf(samples, wallSec, bytes)

  console.log(
    `[${name}] n=${s.count} conc=${concurrency} files=${fileCount}/${files} `
    + `p50=${s.p50Ms.toFixed(2)}ms p95=${s.p95Ms.toFixed(2)}ms p99=${s.p99Ms.toFixed(2)}ms `
    + `max=${s.maxMs.toFixed(2)}ms qps=${s.qps.toFixed(1)} payload~${Math.round(bytes / 1024)}KB`,
  )

  return { name, path, scenario, files, concurrency, stats: s }
}

async function explain(client: Client, sql: string, params: unknown[]): Promise<string> {
  const res = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params)
  return res.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n')
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || DEFAULT_URL
  const files = Number(argValue('--files', '5000'))
  const concurrency = Number(argValue('--concurrency', '50'))
  const requests = Number(argValue('--requests', '800'))
  const warmup = Number(argValue('--warmup', '20'))
  const noiseVersions = Number(argValue('--noise-versions', '40'))
  const savePath = argValue('--save', 'scripts/bench/updates_manifest_path_results.json')

  console.log(`DB=${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`)
  console.log(`files=${files} noiseVersions=${noiseVersions} concurrency=${concurrency} requests=${requests} warmup=${warmup}`)

  const admin = new Client({ connectionString: databaseUrl })
  await admin.connect()
  console.log('Setting up schema + seed…')
  await setupSchema(admin)
  await seed(admin, files, noiseVersions)
  const countRes = await admin.query('SELECT count(*)::int AS n FROM manifest')
  console.log(`Seeded manifest rows: ${countRes.rows[0].n} (live version=${files}, table≈${files * (noiseVersions + 1)})`)

  const oldExplain = await explain(admin, OLD_CHANNEL_WITH_MANIFEST, ['com.bench.manifest', 'production'])
  const lightExplain = await explain(admin, NEW_CHANNEL_LIGHT, ['com.bench.manifest', 'production'])
  const manifestExplain = await explain(admin, NEW_MANIFEST_BY_VERSION, [1002])
  console.log('\n--- EXPLAIN OLD channel+json_agg ---\n', oldExplain)
  console.log('\n--- EXPLAIN NEW channel light ---\n', lightExplain)
  console.log('\n--- EXPLAIN NEW manifest by version ---\n', manifestExplain)

  const pool = new Pool({
    connectionString: databaseUrl,
    max: Math.max(concurrency, 10),
    idleTimeoutMillis: 10000,
  })

  const appId = 'com.bench.manifest'
  const channel = 'production'

  // Sanity: both paths return same file count for new_version
  const oldOnce = await runOldPathMeasured(pool, appId, channel)
  const newOnce = await runNewVersion(pool, appId, channel)
  if (oldOnce.files !== files || newOnce.files !== files) {
    throw new Error(`Sanity failed: old files=${oldOnce.files} new files=${newOnce.files} expected=${files}`)
  }
  console.log(`Sanity OK: both paths return ${files} files`)

  const results: ScenarioResult[] = []

  results.push(await loadScenario(
    pool,
    'OLD up_to_date (still pays json_agg)',
    'old_json_agg',
    'up_to_date',
    files,
    concurrency,
    requests,
    warmup,
    () => runOldPathMeasured(pool, appId, channel),
  ))

  results.push(await loadScenario(
    pool,
    'NEW up_to_date (channel only)',
    'new_deferred',
    'up_to_date',
    files,
    concurrency,
    requests,
    warmup,
    () => runNewUpToDate(pool, appId, channel),
  ))

  results.push(await loadScenario(
    pool,
    'OLD new_version (json_agg)',
    'old_json_agg',
    'new_version',
    files,
    concurrency,
    requests,
    warmup,
    () => runOldPathMeasured(pool, appId, channel),
  ))

  results.push(await loadScenario(
    pool,
    'NEW new_version (light + indexed)',
    'new_deferred',
    'new_version',
    files,
    concurrency,
    requests,
    warmup,
    () => runNewVersion(pool, appId, channel),
  ))

  // Attach explains to first matching results
  results[0]!.explain = oldExplain
  results[1]!.explain = lightExplain
  results[3]!.explain = `${lightExplain}\n---\n${manifestExplain}`

  const oldNew = results.find(r => r.path === 'old_json_agg' && r.scenario === 'new_version')!
  const newNew = results.find(r => r.path === 'new_deferred' && r.scenario === 'new_version')!
  const oldUtd = results.find(r => r.path === 'old_json_agg' && r.scenario === 'up_to_date')!
  const newUtd = results.find(r => r.path === 'new_deferred' && r.scenario === 'up_to_date')!

  const newVersionP95RegressionPct = oldNew.stats.p95Ms > 0
    ? ((newNew.stats.p95Ms - oldNew.stats.p95Ms) / oldNew.stats.p95Ms) * 100
    : 0
  const newVersionP95DeltaMs = newNew.stats.p95Ms - oldNew.stats.p95Ms
  const upToDateP95ImprovementPct = oldUtd.stats.p95Ms > 0
    ? ((oldUtd.stats.p95Ms - newUtd.stats.p95Ms) / oldUtd.stats.p95Ms) * 100
    : 0

  // PASS GATE (new-version path must not be destroyed):
  // Fail if NEW new_version p95 is >30% slower AND more than +25ms worse than OLD.
  // Also require up-to-date p95 improvement >= 50% (why we deferred).
  const reasons: string[] = []
  const newVersionDestroyed = newVersionP95RegressionPct > 30 && newVersionP95DeltaMs > 25
  if (newVersionDestroyed) {
    reasons.push(
      `NEW new_version p95 regressed ${newVersionP95RegressionPct.toFixed(1)}% `
      + `(${oldNew.stats.p95Ms.toFixed(2)} → ${newNew.stats.p95Ms.toFixed(2)} ms)`,
    )
  }
  if (upToDateP95ImprovementPct < 50) {
    reasons.push(
      `NEW up_to_date p95 improvement only ${upToDateP95ImprovementPct.toFixed(1)}% `
      + `(expected >= 50%; ${oldUtd.stats.p95Ms.toFixed(2)} → ${newUtd.stats.p95Ms.toFixed(2)} ms)`,
    )
  }
  // Absolute: new_version must return correct file count under load (already checked once)
  if (newNew.stats.p99Ms > Math.max(oldNew.stats.p99Ms * 1.5, oldNew.stats.p99Ms + 50)) {
    reasons.push(
      `NEW new_version p99 too high: ${newNew.stats.p99Ms.toFixed(2)} ms vs OLD ${oldNew.stats.p99Ms.toFixed(2)} ms`,
    )
  }

  const passed = reasons.length === 0

  const gitHead = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    gitHead,
    databaseUrlHost: new URL(databaseUrl).host,
    files,
    concurrency,
    requests,
    warmup,
    results,
    gates: {
      newVersionP95RegressionPct,
      newVersionP95DeltaMs,
      upToDateP95ImprovementPct,
      passed,
      reasons,
    },
  }

  const out = resolve(ROOT, savePath)
  mkdirSync(resolve(out, '..'), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

  console.log('\n=== GATE SUMMARY ===')
  console.log(`new_version p95: OLD ${oldNew.stats.p95Ms.toFixed(2)}ms → NEW ${newNew.stats.p95Ms.toFixed(2)}ms `
    + `(${newVersionP95RegressionPct >= 0 ? '+' : ''}${newVersionP95RegressionPct.toFixed(1)}% / ${newVersionP95DeltaMs >= 0 ? '+' : ''}${newVersionP95DeltaMs.toFixed(2)}ms)`)
  console.log(`up_to_date p95:  OLD ${oldUtd.stats.p95Ms.toFixed(2)}ms → NEW ${newUtd.stats.p95Ms.toFixed(2)}ms `
    + `(improvement ${upToDateP95ImprovementPct.toFixed(1)}%)`)
  console.log(passed ? 'PASS: new-version path not destroyed; up-to-date improved' : `FAIL:\n- ${reasons.join('\n- ')}`)
  console.log(`Wrote ${out}`)

  await pool.end()
  await admin.end()
  process.exit(passed ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
