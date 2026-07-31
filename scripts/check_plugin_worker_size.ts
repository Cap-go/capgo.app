#!/usr/bin/env bun
/**
 * Guard Cloudflare plugin worker bundle size against the committed baseline.
 *
 * Builds with `wrangler deploy --dry-run --minify` (same path as production
 * plugin deploys) and compares Total Upload / gzip against
 * `scripts/bench/plugin_worker_size_baseline.json`.
 *
 * - Increase >5%: warning on stdout (still exits 0)
 * - Increase >15%: fails (exit 1) so PRs cannot silently bloat the hot-path worker
 *
 * Usage:
 *   bun run check:plugin-worker-size
 *   bun run check:plugin-worker-size -- --update-baseline
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const BASELINE_PATH = join(ROOT, 'scripts/bench/plugin_worker_size_baseline.json')
const WARN_PCT = 5
const FAIL_PCT = 15

interface SizeBaseline {
  generatedAt: string
  gitHead: string
  note?: string
  uploadBytes: number
  gzipBytes: number
}

interface MeasuredSize {
  uploadBytes: number
  gzipBytes: number
  uploadKiB: number
  gzipKiB: number
}

function parseArgs(argv: string[]) {
  return { updateBaseline: argv.includes('--update-baseline') }
}

function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

function measurePluginWorkerSize(): MeasuredSize {
  const outDir = mkdtempSync(join(tmpdir(), 'capgo-plugin-size-'))
  const result = spawnSync('bunx', [
    'wrangler',
    'deploy',
    '--config',
    'cloudflare_workers/plugin/wrangler.jsonc',
    '--env=local',
    '--dry-run',
    '--minify',
    `--outdir=${outDir}`,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.status !== 0) {
    throw new Error(`wrangler dry-run failed:\n${result.stdout}\n${result.stderr}`)
  }
  const uploadMatch = result.stdout.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/)
  if (!uploadMatch) {
    throw new Error(`Could not parse wrangler upload size from output:\n${result.stdout}`)
  }
  const uploadKiB = Number.parseFloat(uploadMatch[1])
  const gzipKiB = Number.parseFloat(uploadMatch[2])
  return {
    uploadKiB,
    gzipKiB,
    uploadBytes: Math.round(uploadKiB * 1024),
    gzipBytes: Math.round(gzipKiB * 1024),
  }
}

function loadBaseline(): SizeBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as SizeBaseline
}

function pctChange(before: number, after: number): number {
  if (before <= 0)
    return after === 0 ? 0 : Infinity
  return ((after - before) / before) * 100
}

function formatPct(value: number): string {
  if (!Number.isFinite(value))
    return 'n/a'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} KiB`
}

function writeBaseline(measured: MeasuredSize) {
  mkdirSync(resolve(BASELINE_PATH, '..'), { recursive: true })
  const baseline: SizeBaseline = {
    generatedAt: new Date().toISOString(),
    gitHead: gitHead(),
    note: 'Committed CF plugin worker size budget (wrangler dry-run --minify, env=local). Update with: bun run check:plugin-worker-size -- --update-baseline',
    uploadBytes: measured.uploadBytes,
    gzipBytes: measured.gzipBytes,
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log(`Updated baseline at ${BASELINE_PATH}`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log('Building Cloudflare plugin worker (dry-run --minify)...')
  const measured = measurePluginWorkerSize()

  if (args.updateBaseline) {
    writeBaseline(measured)
    console.log(`upload ${kib(measured.uploadBytes)} / gzip ${kib(measured.gzipBytes)}`)
    return
  }

  const baseline = loadBaseline()
  const uploadDelta = pctChange(baseline.uploadBytes, measured.uploadBytes)
  const gzipDelta = pctChange(baseline.gzipBytes, measured.gzipBytes)
  const maxDelta = Math.max(uploadDelta, gzipDelta)

  console.log('Plugin worker size vs baseline:')
  console.log(`  upload: ${kib(baseline.uploadBytes)} → ${kib(measured.uploadBytes)} (${formatPct(uploadDelta)})`)
  console.log(`  gzip:   ${kib(baseline.gzipBytes)} → ${kib(measured.gzipBytes)} (${formatPct(gzipDelta)})`)
  console.log(`  baseline: ${BASELINE_PATH} (git ${baseline.gitHead})`)
  console.log(`  thresholds: warn >${WARN_PCT}% | fail >${FAIL_PCT}%`)

  if (maxDelta > FAIL_PCT) {
    console.error(`\nFAIL: plugin worker size grew ${formatPct(maxDelta)} (limit +${FAIL_PCT}%).`)
    console.error('Keep the plugin isolate light. Revert heavy imports or raise the budget intentionally with:')
    console.error('  bun run check:plugin-worker-size -- --update-baseline')
    console.error('and justify the baseline bump in the PR.')
    process.exit(1)
  }

  if (maxDelta > WARN_PCT) {
    console.warn(`\nWARNING: plugin worker size grew ${formatPct(maxDelta)} (warn >${WARN_PCT}%).`)
    console.warn('Prefer keeping growth near zero on the hot plugin worker path.')
  }
  else if (maxDelta > 0) {
    console.log(`\nOK: size increase ${formatPct(maxDelta)} is under the ${WARN_PCT}% warning threshold.`)
  }
  else if (maxDelta < 0) {
    console.log(`\nOK: plugin worker got smaller (${formatPct(maxDelta)}). Consider --update-baseline.`)
  }
  else {
    console.log('\nOK: plugin worker size unchanged vs baseline.')
  }
}

main()
