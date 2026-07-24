#!/usr/bin/env bun
/**
 * Plugin worker isolate CPU bench (cold start + hot request path).
 *
 * Builds the plugin worker with wrangler dry-run, boots ONE Miniflare isolate,
 * and measures process.cpuUsage() around dispatchFetch:
 * 1) Cold first /ok (includes module evaluation)
 * 2) Warm /ok
 * 3) Warm invalid /updates validation path (no DB)
 *
 * Usage:
 *   bun scripts/bench_plugin_worker_cpu.ts
 *   bun scripts/bench_plugin_worker_cpu.ts --save scripts/bench/plugin_worker_cpu_results.json
 *   bun scripts/bench_plugin_worker_cpu.ts --baseline-script scripts/bench/bundles/plugin_worker_baseline_main.js
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Miniflare } from 'miniflare'

const ROOT = resolve(import.meta.dirname, '..')

interface Sample {
  name: string
  wallMs: number
  cpuMs: number
  status: number
}

function parseArgs(argv: string[]) {
  let savePath: string | undefined
  let baselineScript: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--save')
      savePath = argv[++i]
    else if (argv[i] === '--baseline-script')
      baselineScript = argv[++i]
  }
  return { savePath, baselineScript }
}

function buildPlugin(outDir: string) {
  mkdirSync(outDir, { recursive: true })
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
  if (result.status !== 0)
    throw new Error(`wrangler dry-run failed:\n${result.stdout}\n${result.stderr}`)
  const uploadMatch = result.stdout.match(/Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/)
  return {
    uploadKiB: uploadMatch ? Number.parseFloat(uploadMatch[1]) : null,
    gzipKiB: uploadMatch ? Number.parseFloat(uploadMatch[2]) : null,
    scriptPath: join(outDir, 'index.js'),
  }
}

function createMiniflare(scriptPath: string) {
  return new Miniflare({
    compatibilityDate: '2026-04-21',
    compatibilityFlags: ['nodejs_compat', 'nodejs_compat_populate_process_env'],
    modules: [
      {
        type: 'ESModule',
        path: 'index.js',
        contents: readFileSync(scriptPath, 'utf8'),
      },
    ],
    bindings: {
      ENV_NAME: 'capgo_plugin-local',
      CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
    },
  })
}

async function measureRequest(mf: Miniflare, name: string, request: Request): Promise<Sample> {
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const response = await mf.dispatchFetch(request)
  await response.arrayBuffer()
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  return {
    name,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    status: response.status,
  }
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function measureScript(scriptPath: string, label: string) {
  const mf = createMiniflare(scriptPath)
  try {
    const cold = await measureRequest(mf, `${label}_cold_ok`, new Request('http://local/ok'))

    const warmOk: Sample[] = []
    for (let i = 0; i < 25; i++)
      warmOk.push(await measureRequest(mf, `${label}_warm_ok_${i}`, new Request('http://local/ok')))

    const invalidBody = JSON.stringify({
      app_id: 'not a domain',
      device_id: 'bad',
      version_name: '1.0.0',
      version_build: '1.0.0',
      is_emulator: false,
      is_prod: true,
      platform: 'ios',
      plugin_version: 'nope',
    })
    const warmInvalid: Sample[] = []
    for (let i = 0; i < 25; i++) {
      warmInvalid.push(await measureRequest(
        mf,
        `${label}_warm_updates_invalid_${i}`,
        new Request('http://local/updates', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: invalidBody,
        }),
      ))
    }

    return {
      label,
      bytes: readFileSync(scriptPath).byteLength,
      coldOk: {
        wallMs: cold.wallMs,
        cpuMs: cold.cpuMs,
        status: cold.status,
      },
      warmOk: {
        medianWallMs: median(warmOk.map(s => s.wallMs)),
        medianCpuMs: median(warmOk.map(s => s.cpuMs)),
        statuses: [...new Set(warmOk.map(s => s.status))],
      },
      warmUpdatesInvalid: {
        medianWallMs: median(warmInvalid.map(s => s.wallMs)),
        medianCpuMs: median(warmInvalid.map(s => s.cpuMs)),
        statuses: [...new Set(warmInvalid.map(s => s.status))],
      },
    }
  }
  finally {
    // Hard-exit path: dispose can hang on this workerd version; rely on process exit.
    void mf.dispose().catch(() => {})
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = mkdtempSync(join(tmpdir(), 'capgo-plugin-cpu-'))
  console.log(`Building plugin worker into ${outDir}`)
  const built = buildPlugin(outDir)
  console.log(`upload ${built.uploadKiB} KiB / gzip ${built.gzipKiB} KiB`)

  let baseline = null as Awaited<ReturnType<typeof measureScript>> | null
  if (args.baselineScript)
    baseline = await measureScript(resolve(ROOT, args.baselineScript), 'baseline')
  const current = await measureScript(built.scriptPath, 'current')

  console.log('\n=== Plugin worker isolate CPU ===')
  console.log(`[current] cold /ok: wall ${current.coldOk.wallMs.toFixed(2)} ms | cpu ${current.coldOk.cpuMs.toFixed(2)} ms | status ${current.coldOk.status}`)
  console.log(`[current] warm /ok: wall ${current.warmOk.medianWallMs.toFixed(2)} ms | cpu ${current.warmOk.medianCpuMs.toFixed(2)} ms | status ${current.warmOk.statuses.join(',')}`)
  console.log(`[current] warm invalid /updates: wall ${current.warmUpdatesInvalid.medianWallMs.toFixed(2)} ms | cpu ${current.warmUpdatesInvalid.medianCpuMs.toFixed(2)} ms | status ${current.warmUpdatesInvalid.statuses.join(',')}`)

  if (baseline) {
    const pct = (a: number, b: number) => {
      const v = ((b - a) / a) * 100
      return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
    }
    console.log('\n=== Comparative (baseline → current) ===')
    console.log(`bytes: ${baseline.bytes} → ${current.bytes}`)
    console.log(`cold cpu: ${baseline.coldOk.cpuMs.toFixed(2)} → ${current.coldOk.cpuMs.toFixed(2)} ms (${pct(baseline.coldOk.cpuMs, current.coldOk.cpuMs)})`)
    console.log(`warm /ok cpu: ${baseline.warmOk.medianCpuMs.toFixed(2)} → ${current.warmOk.medianCpuMs.toFixed(2)} ms (${pct(baseline.warmOk.medianCpuMs, current.warmOk.medianCpuMs)})`)
    console.log(`warm invalid /updates cpu: ${baseline.warmUpdatesInvalid.medianCpuMs.toFixed(2)} → ${current.warmUpdatesInvalid.medianCpuMs.toFixed(2)} ms (${pct(baseline.warmUpdatesInvalid.medianCpuMs, current.warmUpdatesInvalid.medianCpuMs)})`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    bundle: {
      uploadKiB: built.uploadKiB,
      gzipKiB: built.gzipKiB,
    },
    current,
    baseline,
  }

  if (args.savePath) {
    const abs = resolve(ROOT, args.savePath)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nSaved ${abs}`)
  }

  // Miniflare/workerd dispose can hang; force exit after reporting.
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
