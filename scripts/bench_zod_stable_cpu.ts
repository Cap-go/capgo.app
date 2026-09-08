#!/usr/bin/env bun
/**
 * Stable CPU + memory bench for Zod version bumps (no z.compile).
 *
 * Measures existing validation paths only:
 * - production `.is` predicate
 * - zod-compiler AOT `.is`
 * - Zod runtime `safeParse`
 * - representative backend org schema `safeParse`
 *
 * Usage:
 *   bun scripts/bench_zod_stable_cpu.ts
 *   BENCH_RUNS=5 bun scripts/bench_zod_stable_cpu.ts /workspace
 */

import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(process.argv[2] ?? resolve(import.meta.dirname, '..'))
const RUNS = Math.max(1, Number.parseInt(process.env.BENCH_RUNS ?? '1', 10) || 1)
const ITERATIONS = 80_000

interface CpuRow {
  name: string
  runs: number
  iterations: number
  nsCpuPerOp: number
  nsCpuPerOpStd: number
}

interface MemRow {
  name: string
  runs: number
  heapUsedDeltaMB: number
  rssDeltaMB: number
}

function forceGc() {
  if (typeof Bun !== 'undefined' && 'gc' in Bun && typeof Bun.gc === 'function')
    Bun.gc(true)
  else if (globalThis.gc)
    globalThis.gc()
}

function ensureCompiledZod() {
  const out = resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.compiled.ts')
  const src = resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.ts')
  const result = spawnSync('bunx', ['zod-compiler', 'generate', src, '-o', out, '--emit', 'bag'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  if (result.status !== 0)
    throw new Error(`zod-compiler generate failed:\n${result.stdout}\n${result.stderr}`)
}

function validUpdatePayload() {
  return {
    app_id: 'com.demo.app',
    device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    version_name: '1.2.3',
    version_build: '1.2.3',
    is_emulator: false,
    is_prod: true,
    platform: 'ios' as const,
    plugin_version: '6.8.1',
    defaultChannel: 'production',
    key_id: 'key_1',
  }
}

function invalidUpdatePayload() {
  return {
    ...validUpdatePayload(),
    app_id: 'not a domain',
    device_id: 'bad',
    plugin_version: 'nope',
  }
}

function validOrgPayload() {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    created_by: '22222222-2222-4222-8222-222222222222',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    logo: null,
    name: 'Example Org',
    management_email: 'org-admin@example.com',
    customer_id: null,
    website: null,
  }
}

function mixedUpdateInputs(validRatio = 0.75) {
  const valid = validUpdatePayload()
  const invalid = invalidUpdatePayload()
  const invalidEvery = Math.max(1, Math.round(1 / (1 - validRatio)))
  return Array.from({ length: 16 }, (_, i) => (i % invalidEvery === 0 ? invalid : valid))
}

function benchCpuOnce(name: string, iterations: number, fn: (input: unknown) => boolean, inputs: unknown[]) {
  for (let i = 0; i < Math.min(2000, iterations); i++)
    fn(inputs[i % inputs.length])

  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++)
    fn(inputs[i % inputs.length])
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  const cpuMs = (cpu.user + cpu.system) / 1000
  return {
    name,
    iterations,
    wallMs,
    cpuMs,
    nsCpuPerOp: (cpuMs * 1e6) / iterations,
  }
}

function summarizeCpu(name: string, iterations: number, samples: number[]) {
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length
  const variance = samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length
  return {
    name,
    runs: samples.length,
    iterations,
    nsCpuPerOp: mean,
    nsCpuPerOpStd: Math.sqrt(variance),
  }
}

function measureMemOnce(name: string, fn: () => void) {
  forceGc()
  const before = process.memoryUsage()
  fn()
  forceGc()
  const after = process.memoryUsage()
  return {
    name,
    heapUsedDeltaMB: (after.heapUsed - before.heapUsed) / 1024 / 1024,
    rssDeltaMB: (after.rss - before.rss) / 1024 / 1024,
  }
}

function summarizeMem(name: string, samples: Array<{ heapUsedDeltaMB: number, rssDeltaMB: number }>) {
  const heapUsedDeltaMB = samples.reduce((sum, row) => sum + row.heapUsedDeltaMB, 0) / samples.length
  const rssDeltaMB = samples.reduce((sum, row) => sum + row.rssDeltaMB, 0) / samples.length
  return {
    name,
    runs: samples.length,
    heapUsedDeltaMB,
    rssDeltaMB,
  }
}

async function main() {
  ensureCompiledZod()

  const prodIs = await import(pathToFileURL(resolve(ROOT, 'supabase/functions/_backend/plugin_runtime/utils/plugin_schemas/update_request.is.ts')).href)
  const zodRuntime = await import(pathToFileURL(resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.ts')).href)
  const zodCompiled = await import(pathToFileURL(resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.compiled.ts')).href)
  const { z } = await import('zod')

  const orgSchema = z.object({
    id: z.uuid(),
    created_by: z.uuid(),
    created_at: z.union([z.string(), z.date()]),
    updated_at: z.union([z.string(), z.date()]),
    logo: z.string().nullable(),
    name: z.string(),
    management_email: z.email(),
    customer_id: z.string().nullable(),
    website: z.string().nullable(),
  })

  const valid = validUpdatePayload()
  const mixed = mixedUpdateInputs(0.75)
  const orgValid = validOrgPayload()

  const cpuCases: Array<{ name: string, fn: (input: unknown) => boolean, inputs: unknown[] }> = [
    {
      name: 'plugin_is_predicate_valid',
      fn: input => prodIs.isUpdateRequestBody(input),
      inputs: [valid],
    },
    {
      name: 'zod_compiler_is_valid',
      fn: input => zodCompiled.updateRequestSchemaZod.is(input),
      inputs: [valid],
    },
    {
      name: 'zod_runtime_safeParse_valid',
      fn: input => zodRuntime.updateRequestSchemaZod.safeParse(input).success,
      inputs: [valid],
    },
    {
      name: 'zod_runtime_safeParse_mixed_75pct_valid',
      fn: input => zodRuntime.updateRequestSchemaZod.safeParse(input).success,
      inputs: mixed,
    },
    {
      name: 'backend_org_schema_safeParse_valid',
      fn: input => orgSchema.safeParse(input).success,
      inputs: [orgValid],
    },
  ]

  const cpuRows: CpuRow[] = []
  for (const testCase of cpuCases) {
    const samples: number[] = []
    for (let run = 0; run < RUNS; run++)
      samples.push(benchCpuOnce(testCase.name, ITERATIONS, testCase.fn, testCase.inputs).nsCpuPerOp)
    cpuRows.push(summarizeCpu(testCase.name, ITERATIONS, samples))
  }

  const memCases: Array<{ name: string, fn: () => void }> = [
    {
      name: '80k_runtime_parse_heap_rss',
      fn: () => {
        for (let i = 0; i < ITERATIONS; i++)
          zodRuntime.updateRequestSchemaZod.safeParse(valid)
      },
    },
    {
      name: '100x_z_string_heap',
      fn: () => {
        for (let i = 0; i < 100; i++)
          z.string()
      },
    },
  ]

  const memRows: MemRow[] = []
  for (const testCase of memCases) {
    const samples = []
    for (let run = 0; run < RUNS; run++)
      samples.push(measureMemOnce(testCase.name, testCase.fn))
    memRows.push(summarizeMem(testCase.name, samples))
  }

  const zodPkg = await import(pathToFileURL(resolve(ROOT, 'node_modules/zod/package.json')).href) as { version?: string }

  console.log(`\n=== Zod stable CPU + memory bench (zod@${zodPkg.version ?? 'unknown'}, runs=${RUNS}) ===`)
  console.log('\nCPU (lower ns/op is better):')
  for (const row of cpuRows) {
    console.log(
      `${row.name.padEnd(40)} ${row.nsCpuPerOp.toFixed(1).padStart(10)} ns/op ± ${row.nsCpuPerOpStd.toFixed(1)}`,
    )
  }

  console.log('\nMemory (lower delta is better):')
  for (const row of memRows) {
    console.log(
      `${row.name.padEnd(40)} heap Δ ${row.heapUsedDeltaMB.toFixed(3).padStart(8)} MB | rss Δ ${row.rssDeltaMB.toFixed(3).padStart(8)} MB`,
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
