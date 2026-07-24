#!/usr/bin/env bun
/**
 * Comparative runtime cost bench for the Capgo plugin Cloudflare Worker.
 *
 * Measures (no guessing):
 * 1) Retained minified bundle bytes per package via `wrangler deploy --dry-run --metafile`
 * 2) Node import CPU ms + heap/RSS deltas for heavy libraries
 * 3) Hot-path microbenches (LIMITED_APPS parse, stats action membership)
 *
 * For isolate/request CPU ms and validation library CPU comparisons, also run:
 *   bun run bench:plugin-worker-cpu
 *   bun run bench:plugin-validation-cpu
 *
 * Usage:
 *   bun scripts/bench_plugin_worker_runtime.ts
 *   bun scripts/bench_plugin_worker_runtime.ts --save scripts/bench/plugin_worker_runtime_results.json
 *   bun scripts/bench_plugin_worker_runtime.ts --compare scripts/bench/plugin_worker_runtime_baseline.json
 *   bun run bench:plugin-worker-runtime
 *
 * The committed baseline JSON is captured from main before optimizations.
 * Note: top-level scripts/*.json is gitignored; keep artifacts under scripts/bench/.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

interface PackageBytes {
  [key: string]: number
}

interface BundleReport {
  uploadBytes: number
  gzipBytes: number | null
  outputBytes: number
  topPackagesBytesInOutput: PackageBytes
  focusPackagesBytesInOutput: PackageBytes
}

interface ImportCost {
  specifier: string
  ms: number
  heapUsedDeltaMB: number
  rssDeltaMB: number
  heapUsedMB: number
  rssMB: number
  error?: string
}

interface MicroBench {
  name: string
  iterations: number
  ms: number
  nsPerOp: number
  opsPerSec: number
  checksum: number
}

interface BenchReport {
  generatedAt: string
  gitHead: string
  bundle: BundleReport
  importCosts: ImportCost[]
  microBenches: MicroBench[]
}

const ROOT = resolve(import.meta.dirname, '..')
const FOCUS_PACKAGE_MATCHERS = [
  'npm:stripe',
  'npm:zod',
  'npm:dayjs',
  'npm:drizzle-orm',
  'npm:cron-schedule',
  'npm:pg',
  'npm:hono',
  'npm:@supabase/supabase-js',
  'npm:@supabase/auth-js',
  'npm:@supabase/postgrest-js',
  'npm:@supabase/realtime-js',
  'npm:@supabase/storage-js',
  'npm:@jsr/bradenmacdonald__s3-lite-client',
  'npm:@jsr/std__semver',
  'backend:utils/stripe.ts',
  'backend:utils/schema_validation.ts',
  'backend:utils/cloudflare.ts',
  'backend:utils/supabase.ts',
  'backend:utils/pg.ts',
]

const HEAVY_IMPORTS = [
  'zod',
  'stripe',
  'drizzle-orm',
  'dayjs',
  '@supabase/supabase-js',
  'pg',
  'cron-schedule',
  'hono',
]

function parseArgs(argv: string[]) {
  let savePath: string | undefined
  let comparePath: string | undefined
  let outDir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--save')
      savePath = argv[++i]
    else if (arg === '--compare')
      comparePath = argv[++i]
    else if (arg === '--outdir')
      outDir = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: bun scripts/bench_plugin_worker_runtime.ts [--save path] [--compare path] [--outdir path]`)
      process.exit(0)
    }
  }
  return { savePath, comparePath, outDir }
}

function run(cmd: string[], cwd = ROOT) {
  const result = spawnSync(cmd[0], cmd.slice(1), {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd.join(' ')}):\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function gitHead() {
  try {
    return run(['git', 'rev-parse', 'HEAD']).trim()
  }
  catch {
    return 'unknown'
  }
}

function classifyPath(path: string): string {
  if (path.includes('node_modules') || path.includes('.bun')) {
    const jsr = path.match(/node_modules\/@jsr\/([^/]+)/)
    if (jsr)
      return `npm:@jsr/${jsr[1]}`

    // Bun install cache paths look like:
    //   .../.bun/<cache-entry>/node_modules/<package>/...
    // Prefer the nested package name so we don't collapse everything into npm:.bun.
    const bunNested = path.match(/\.bun\/[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
    if (bunNested)
      return `npm:${bunNested[1]}`

    const bun = path.match(/\.bun\/((?:@[^/]+\/)?[^/@]+)@/)
    if (bun)
      return `npm:${bun[1]}`

    const nm = path.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/)
    if (nm)
      return `npm:${nm[1]}`
    return 'npm:?'
  }
  if (path.includes('_backend'))
    return `backend:${path.replace(/^.*_backend\//, '')}`
  return `other:${path.replace(/^.*\//, '')}`
}

function buildPluginBundle(outDir: string): BundleReport {
  mkdirSync(outDir, { recursive: true })
  const metaPath = join(outDir, 'metafile.json')
  const stdout = run([
    'bunx',
    'wrangler',
    'deploy',
    '--config',
    'cloudflare_workers/plugin/wrangler.jsonc',
    '--env=local',
    '--dry-run',
    '--minify',
    `--outdir=${outDir}`,
    `--metafile=${metaPath}`,
  ])

  const uploadMatch = stdout.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/)
  const uploadBytes = uploadMatch ? Math.round(Number.parseFloat(uploadMatch[1]) * 1024) : 0
  const gzipBytes = uploadMatch ? Math.round(Number.parseFloat(uploadMatch[2]) * 1024) : null

  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as {
    outputs: Record<string, { bytes: number, inputs?: Record<string, { bytesInOutput?: number }> }>
  }
  const jsOutputEntry = Object.entries(meta.outputs).find(([key]) => key.endsWith('index.js') && !key.endsWith('.map'))
  if (!jsOutputEntry)
    throw new Error('metafile missing index.js output')

  const [, jsOutput] = jsOutputEntry
  const packagesBytesInOutput: PackageBytes = {}
  for (const [path, info] of Object.entries(jsOutput.inputs || {})) {
    const key = classifyPath(path)
    packagesBytesInOutput[key] = (packagesBytesInOutput[key] || 0) + (info.bytesInOutput || 0)
  }

  // Also aggregate supabase / zod ecosystems for clearer reporting
  let supabaseEcosystem = 0
  let zodEcosystem = 0
  let stripeEcosystem = 0
  for (const [path, info] of Object.entries(jsOutput.inputs || {})) {
    const bytes = info.bytesInOutput || 0
    if (path.includes('@supabase') || path.includes('supabase-js') || path.includes('iceberg-js'))
      supabaseEcosystem += bytes
    if (path.includes('/zod') || path.includes('zod@'))
      zodEcosystem += bytes
    if (path.includes('/stripe') || path.includes('stripe@') || path.endsWith('utils/stripe.ts'))
      stripeEcosystem += bytes
  }
  packagesBytesInOutput['ecosystem:@supabase'] = supabaseEcosystem
  packagesBytesInOutput['ecosystem:zod'] = zodEcosystem
  packagesBytesInOutput['ecosystem:stripe'] = stripeEcosystem

  const focusPackagesBytesInOutput: PackageBytes = {}
  for (const key of [
    ...FOCUS_PACKAGE_MATCHERS,
    'ecosystem:@supabase',
    'ecosystem:zod',
    'ecosystem:stripe',
  ]) {
    if (packagesBytesInOutput[key] != null)
      focusPackagesBytesInOutput[key] = packagesBytesInOutput[key]
  }

  // Exclude synthetic ecosystem:* aggregates — they double-count real packages
  // and hide the true largest inputs. Ecosystem totals stay in focusPackagesBytesInOutput.
  const topPackagesBytesInOutput = Object.fromEntries(
    Object.entries(packagesBytesInOutput)
      .filter(([key]) => !key.startsWith('ecosystem:'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40),
  )

  return {
    uploadBytes,
    gzipBytes,
    outputBytes: jsOutput.bytes,
    topPackagesBytesInOutput,
    focusPackagesBytesInOutput,
  }
}

function measureImport(specifier: string): ImportCost {
  // Always use system node so --expose-gc + heap deltas are reliable (bun's execPath differs).
  const nodeBin = process.env.CAPGO_BENCH_NODE || 'node'
  const code = `
if (global.gc) global.gc();
const { performance } = require('node:perf_hooks');
const beforeMem = process.memoryUsage();
const t0 = performance.now();
try {
  require(${JSON.stringify(specifier)});
  const t1 = performance.now();
  const afterMem = process.memoryUsage();
  console.log(JSON.stringify({
    specifier: ${JSON.stringify(specifier)},
    ms: t1 - t0,
    heapUsedDeltaMB: (afterMem.heapUsed - beforeMem.heapUsed) / 1024 / 1024,
    rssDeltaMB: (afterMem.rss - beforeMem.rss) / 1024 / 1024,
    heapUsedMB: afterMem.heapUsed / 1024 / 1024,
    rssMB: afterMem.rss / 1024 / 1024,
  }));
} catch (error) {
  console.log(JSON.stringify({
    specifier: ${JSON.stringify(specifier)},
    ms: 0,
    heapUsedDeltaMB: 0,
    rssDeltaMB: 0,
    heapUsedMB: 0,
    rssMB: 0,
    error: String(error && error.message ? error.message : error),
  }));
}
`
  const result = spawnSync(nodeBin, ['--expose-gc', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  const line = (result.stdout || '').trim().split('\n').pop()
  if (!line)
    return { specifier, ms: 0, heapUsedDeltaMB: 0, rssDeltaMB: 0, heapUsedMB: 0, rssMB: 0, error: result.stderr || 'no output' }
  return JSON.parse(line) as ImportCost
}

function bench(name: string, iterations: number, fn: () => unknown): MicroBench {
  // warmup
  for (let i = 0; i < Math.min(1000, iterations); i++)
    fn()
  let checksum = 0
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) {
    const value = fn()
    // Keep results observable so V8 cannot DCE the benchmark body.
    if (typeof value === 'boolean')
      checksum = (checksum + (value ? 1 : 0)) | 0
    else if (typeof value === 'number')
      checksum = (checksum + (value | 0)) | 0
    else if (typeof value === 'string')
      checksum = (checksum + value.length) | 0
    else if (value != null)
      checksum = (checksum + 1) | 0
  }
  const ms = performance.now() - t0
  return {
    name,
    iterations,
    ms,
    nsPerOp: (ms * 1e6) / iterations,
    opsPerSec: iterations / (ms / 1000),
    checksum,
  }
}

function runMicroBenches(): MicroBench[] {
  const actions = [
    'ping', 'get', 'set', 'delete', 'download_complete', 'needPlanUpgrade',
    'disableAutoUpdateToMajor', 'webview_javascript_error', 'native_app_version_changed',
    'app_moved_to_foreground', 'checksum_fail', 'NoChannelOrOverride', 'rateLimited',
  ]
  // Expand to ~90 entries like production list shape
  while (actions.length < 90)
    actions.push(`action_${actions.length}`)

  const actionSet = new Set(actions)
  const limitsJson = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({
    id: `com.example.app${i}`,
    ignore: i % 5 === 0 ? 1 : 0.1,
  })))

  let cachedKey: string | undefined
  let cachedMap: Map<string, { id: string, ignore: number }> | undefined
  function getCached(limits: string) {
    if (limits === cachedKey && cachedMap)
      return cachedMap
    const apps = JSON.parse(limits) as Array<{ id: string, ignore: number }>
    cachedKey = limits
    cachedMap = new Map(apps.map(app => [app.id, app]))
    return cachedMap
  }

  const targetAction = 'native_app_version_changed'
  const targetApp = 'com.example.app42'
  const iterations = 200_000

  return [
    bench('stats_action_array_includes', iterations, () => actions.includes(targetAction)),
    bench('stats_action_set_has', iterations, () => actionSet.has(targetAction)),
    bench('limited_apps_json_parse_every_call', iterations, () => {
      const apps = JSON.parse(limitsJson) as Array<{ id: string, ignore: number }>
      return apps.find(app => app.id === targetApp)?.id ?? ''
    }),
    bench('limited_apps_cached_map_lookup', iterations, () => {
      return getCached(limitsJson).get(targetApp)?.id ?? ''
    }),
    bench('allowed_actions_join_every_error', 20_000, () => actions.join(', ')),
    (() => {
      let list: string | undefined
      const getList = () => (list ??= actions.join(', '))
      return bench('allowed_actions_join_cached', 20_000, () => getList())
    })(),
  ]
}

function kib(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function pct(before: number, after: number) {
  if (before === 0)
    return after === 0 ? '0%' : '+inf'
  const delta = ((after - before) / before) * 100
  const sign = delta > 0 ? '+' : ''
  return `${sign}${delta.toFixed(1)}%`
}

function printReport(report: BenchReport) {
  console.log('\n=== Plugin worker runtime bench ===')
  console.log(`git: ${report.gitHead}`)
  console.log(`generatedAt: ${report.generatedAt}`)
  console.log('\n-- Bundle --')
  console.log(`upload: ${kib(report.bundle.uploadBytes)}` + (report.bundle.gzipBytes != null ? ` / gzip ${kib(report.bundle.gzipBytes)}` : ''))
  console.log(`output JS: ${kib(report.bundle.outputBytes)}`)
  console.log('\nFocus retained bytes (esbuild bytesInOutput):')
  const focus = Object.entries(report.bundle.focusPackagesBytesInOutput).sort((a, b) => b[1] - a[1])
  for (const [key, bytes] of focus)
    console.log(`  ${kib(bytes).padStart(10)}  ${key}`)

  console.log('\n-- Import CPU / RAM (fresh node process per package) --')
  for (const row of report.importCosts) {
    if (row.error) {
      console.log(`  ${row.specifier}: ERROR ${row.error}`)
      continue
    }
    console.log(`  ${row.specifier.padEnd(28)} ${row.ms.toFixed(2).padStart(8)} ms | heap Δ ${row.heapUsedDeltaMB.toFixed(2).padStart(6)} MB | rss Δ ${row.rssDeltaMB.toFixed(2).padStart(6)} MB`)
  }

  console.log('\n-- Hot-path microbenches --')
  for (const row of report.microBenches) {
    console.log(`  ${row.name.padEnd(36)} ${row.ms.toFixed(2).padStart(8)} ms | ${row.nsPerOp.toFixed(1).padStart(8)} ns/op | ${Math.round(row.opsPerSec).toLocaleString()} ops/s | checksum ${row.checksum}`)
  }
}

function compareReports(baseline: BenchReport, current: BenchReport) {
  console.log('\n=== Comparative results (baseline → current) ===')
  console.log(`baseline git: ${baseline.gitHead}`)
  console.log(`current  git: ${current.gitHead}`)
  console.log('\nBundle size:')
  console.log(`  upload: ${kib(baseline.bundle.uploadBytes)} → ${kib(current.bundle.uploadBytes)} (${pct(baseline.bundle.uploadBytes, current.bundle.uploadBytes)})`)
  if (baseline.bundle.gzipBytes != null && current.bundle.gzipBytes != null) {
    console.log(`  gzip:   ${kib(baseline.bundle.gzipBytes)} → ${kib(current.bundle.gzipBytes)} (${pct(baseline.bundle.gzipBytes, current.bundle.gzipBytes)})`)
  }
  console.log(`  output: ${kib(baseline.bundle.outputBytes)} → ${kib(current.bundle.outputBytes)} (${pct(baseline.bundle.outputBytes, current.bundle.outputBytes)})`)

  const keys = new Set([
    ...Object.keys(baseline.bundle.focusPackagesBytesInOutput),
    ...Object.keys(current.bundle.focusPackagesBytesInOutput),
  ])
  console.log('\nFocus package retained bytes:')
  for (const key of [...keys].sort((a, b) => {
    const da = (current.bundle.focusPackagesBytesInOutput[a] || 0) - (baseline.bundle.focusPackagesBytesInOutput[a] || 0)
    const db = (current.bundle.focusPackagesBytesInOutput[b] || 0) - (baseline.bundle.focusPackagesBytesInOutput[b] || 0)
    return da - db
  })) {
    const before = baseline.bundle.focusPackagesBytesInOutput[key] || 0
    const after = current.bundle.focusPackagesBytesInOutput[key] || 0
    if (before === 0 && after === 0)
      continue
    console.log(`  ${key.padEnd(42)} ${kib(before).padStart(10)} → ${kib(after).padStart(10)} (${pct(before, after)})`)
  }

  console.log('\nImport CPU / RAM (machine-local; compare directionally):')
  const importKeys = new Set([
    ...baseline.importCosts.map(row => row.specifier),
    ...current.importCosts.map(row => row.specifier),
  ])
  const baselineImports = new Map(baseline.importCosts.map(row => [row.specifier, row]))
  const currentImports = new Map(current.importCosts.map(row => [row.specifier, row]))
  for (const specifier of [...importKeys].sort()) {
    const before = baselineImports.get(specifier)
    const after = currentImports.get(specifier)
    if (!before && !after)
      continue
    console.log(`  ${specifier}`)
    const beforeOk = Boolean(before && !before.error)
    const afterOk = Boolean(after && !after.error)
    if (!beforeOk || !afterOk) {
      const beforeLabel = !before ? 'missing' : (before.error ? `error: ${before.error}` : `${before.ms.toFixed(2)} ms`)
      const afterLabel = !after ? 'missing' : (after.error ? `error: ${after.error}` : `${after.ms.toFixed(2)} ms`)
      console.log(`    unavailable for delta (baseline=${beforeLabel}; current=${afterLabel})`)
      continue
    }
    console.log(`    cpu  ${before!.ms.toFixed(2)} ms → ${after!.ms.toFixed(2)} ms (${pct(before!.ms, after!.ms)})`)
    console.log(`    heap ${before!.heapUsedDeltaMB.toFixed(2)} MB → ${after!.heapUsedDeltaMB.toFixed(2)} MB (${pct(before!.heapUsedDeltaMB, after!.heapUsedDeltaMB)})`)
    console.log(`    rss  ${before!.rssDeltaMB.toFixed(2)} MB → ${after!.rssDeltaMB.toFixed(2)} MB (${pct(before!.rssDeltaMB, after!.rssDeltaMB)})`)
  }

  console.log('\nMicrobench method comparison (lower ns/op is better):')
  const byName = new Map(current.microBenches.map(row => [row.name, row]))
  const pairs: Array<[string, string]> = [
    ['stats_action_array_includes', 'stats_action_set_has'],
    ['limited_apps_json_parse_every_call', 'limited_apps_cached_map_lookup'],
    ['allowed_actions_join_every_error', 'allowed_actions_join_cached'],
  ]
  for (const [oldName, newName] of pairs) {
    const oldRow = byName.get(oldName)
    const newRow = byName.get(newName)
    if (!oldRow || !newRow)
      continue
    console.log(`  ${oldName} → ${newName}`)
    console.log(`    ${oldRow.nsPerOp.toFixed(1)} ns/op → ${newRow.nsPerOp.toFixed(1)} ns/op (${pct(oldRow.nsPerOp, newRow.nsPerOp)}) | checksum ${oldRow.checksum}/${newRow.checksum}`)
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args.outDir || join(tmpdir(), `capgo-plugin-bench-${Date.now()}`)
  console.log(`Building plugin worker into ${outDir} ...`)
  const bundle = buildPluginBundle(outDir)
  const importCosts = HEAVY_IMPORTS.map(measureImport)
  const microBenches = runMicroBenches()
  const report: BenchReport = {
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    bundle,
    importCosts,
    microBenches,
  }

  printReport(report)

  if (args.savePath) {
    const abs = resolve(ROOT, args.savePath)
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nSaved report to ${abs}`)
  }

  if (args.comparePath) {
    const abs = resolve(ROOT, args.comparePath)
    const baseline = JSON.parse(readFileSync(abs, 'utf8')) as BenchReport
    compareReports(baseline, report)
  }
}

main()

