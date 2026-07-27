#!/usr/bin/env bun
/**
 * Comparative validation CPU bench for plugin request bodies.
 *
 * Contenders (same logical update payload shape):
 * 1) handrolled Standard Schema (current plugin production path)
 * 2) zod runtime
 * 3) zod-compiler AOT (`--emit bag`)
 *
 * Measures process.cpuUsage() user+system ms (exact CPU, not wall guess).
 *
 * Usage:
 *   bun scripts/bench_plugin_validation_cpu.ts
 *   bun scripts/bench_plugin_validation_cpu.ts --save scripts/bench/plugin_validation_cpu_results.json
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const ROOT = resolve(import.meta.dirname, '..')

interface CpuBenchRow {
  name: string
  iterations: number
  wallMs: number
  cpuMs: number
  nsCpuPerOp: number
  successCount: number
  failCount: number
}

function parseArgs(argv: string[]) {
  let savePath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--save')
      savePath = argv[++i]
  }
  return { savePath }
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

function validPayload() {
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

function invalidPayload() {
  return {
    ...validPayload(),
    app_id: 'not a domain',
    device_id: 'bad',
    plugin_version: 'nope',
  }
}

function benchCpu(name: string, iterations: number, fn: (input: unknown) => boolean, inputs: unknown[]): CpuBenchRow {
  for (let i = 0; i < Math.min(2000, iterations); i++)
    fn(inputs[i % inputs.length])

  let successCount = 0
  let failCount = 0
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  for (let i = 0; i < iterations; i++) {
    if (fn(inputs[i % inputs.length]))
      successCount++
    else
      failCount++
  }
  const wallMs = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  const cpuMs = (cpu.user + cpu.system) / 1000
  return {
    name,
    iterations,
    wallMs,
    cpuMs,
    nsCpuPerOp: (cpuMs * 1e6) / iterations,
    successCount,
    failCount,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  ensureCompiledZod()

  const handrolled = await import(pathToFileURL(resolve(ROOT, 'supabase/functions/_backend/plugin_runtime/utils/plugin_validation.ts')).href)
  const { safeParseSchema } = await import(pathToFileURL(resolve(ROOT, 'supabase/functions/_backend/utils/schema_validation.ts')).href)
  const zodRuntime = await import(pathToFileURL(resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.ts')).href)
  const zodCompiled = await import(pathToFileURL(resolve(ROOT, 'scripts/bench/validation/plugin_schemas.zod.compiled.ts')).href)

  const prodIs = await import(pathToFileURL(resolve(ROOT, 'supabase/functions/_backend/plugin_runtime/utils/plugin_schemas/update_request.is.ts')).href)
  const validators = {
    handrolled: (input: unknown) => safeParseSchema(handrolled.updateRequestSchema, input).success,
    production_is_predicate: (input: unknown) => prodIs.isUpdateRequestBody(input),
    zod_runtime: (input: unknown) => zodRuntime.updateRequestSchemaZod.safeParse(input).success,
    zod_compiler_safeParse: (input: unknown) => zodCompiled.updateRequestSchemaZod.safeParse(input).success,
    zod_compiler_is: (input: unknown) => zodCompiled.updateRequestSchemaZod.is(input),
  }

  const valid = validPayload()
  const invalid = invalidPayload()
  const mixed = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? invalid : valid))
  const iterations = 80_000

  const agreement = {
    valid: Object.fromEntries(Object.entries(validators).map(([k, fn]) => [k, fn(valid)])),
    invalid: Object.fromEntries(Object.entries(validators).map(([k, fn]) => [k, fn(invalid)])),
  }

  const rows: CpuBenchRow[] = []
  for (const [name, fn] of Object.entries(validators)) {
    rows.push(benchCpu(`${name}_valid`, iterations, fn, [valid]))
    rows.push(benchCpu(`${name}_mixed`, iterations, fn, mixed))
  }

  console.log('\n=== Plugin validation CPU bench ===')
  console.log('agreement', JSON.stringify(agreement, null, 2))
  console.log('\nlower cpuMs / nsCpuPerOp is better')
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(34)} cpu ${row.cpuMs.toFixed(2).padStart(8)} ms | ${row.nsCpuPerOp.toFixed(1).padStart(8)} ns/op | wall ${row.wallMs.toFixed(2).padStart(8)} ms | ok/fail ${row.successCount}/${row.failCount}`,
    )
  }

  const byName = Object.fromEntries(rows.map(row => [row.name, row]))
  const comparisons = [
    ['zod_runtime_valid', 'handrolled_valid'],
    ['zod_compiler_is_valid', 'handrolled_valid'],
    ['zod_compiler_is_valid', 'zod_runtime_valid'],
  ]
  console.log('\n=== Comparative deltas (A → B, negative means B faster) ===')
  for (const [a, b] of comparisons) {
    const left = byName[a]
    const right = byName[b]
    if (!left || !right)
      continue
    const pct = ((right.cpuMs - left.cpuMs) / left.cpuMs) * 100
    console.log(`${a} → ${b}: ${left.nsCpuPerOp.toFixed(1)} → ${right.nsCpuPerOp.toFixed(1)} ns/op (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% cpu)`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    iterations,
    agreement,
    rows,
  }

  if (args.savePath) {
    const abs = resolve(ROOT, args.savePath)
    mkdirSync(resolve(abs, '..'), { recursive: true })
    writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nSaved ${abs}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
