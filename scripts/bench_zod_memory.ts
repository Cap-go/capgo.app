#!/usr/bin/env bun
/**
 * Zod schema memory + import cost bench.
 *
 * Measures heap deltas for importing zod, constructing schemas, and (4.5+)
 * z.compile() overhead. Run before/after version bumps to quantify the
 * 4.5 memory footprint reduction and compile JIT cost.
 *
 * Usage:
 *   bun scripts/bench_zod_memory.ts
 *   bun scripts/bench_zod_memory.ts --save scripts/bench/zod_memory_baseline_4.4.3.json
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')

interface MemRow {
  name: string
  heapUsedDeltaBytes: number
  heapUsedDeltaMB: number
  rssDeltaBytes: number
  rssDeltaMB: number
  heapUsedMB: number
}

interface MemReport {
  generatedAt: string
  zodVersion: string
  rows: MemRow[]
}

function parseArgs(argv: string[]) {
  let savePath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--save')
      savePath = argv[++i]
  }
  return { savePath }
}

function forceGc() {
  if (typeof Bun !== 'undefined' && 'gc' in Bun && typeof Bun.gc === 'function')
    Bun.gc(true)
  else if (globalThis.gc)
    globalThis.gc()
}

function measure(name: string, fn: () => void): MemRow {
  forceGc()
  const before = process.memoryUsage()
  fn()
  forceGc()
  const after = process.memoryUsage()
  const heapUsedDeltaBytes = after.heapUsed - before.heapUsed
  const rssDeltaBytes = after.rss - before.rss
  return {
    name,
    heapUsedDeltaBytes,
    heapUsedDeltaMB: heapUsedDeltaBytes / 1024 / 1024,
    rssDeltaBytes,
    rssDeltaMB: rssDeltaBytes / 1024 / 1024,
    heapUsedMB: after.heapUsed / 1024 / 1024,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const zodPkg = await import(pathToFileURL(resolve(ROOT, 'node_modules/zod/package.json')).href) as { version?: string }
  const zodVersion = zodPkg.version ?? 'unknown'

  const { z } = await import('zod')

  const deviceIdRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const reverseDomainRegex = /^[a-z0-9]+(\.[\w-]+)+$/i
  const commonSemverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

  const updateSchema = z.object({
    app_id: z.string().regex(reverseDomainRegex),
    device_id: z.string().max(36).regex(deviceIdRegex),
    version_name: z.string().min(1),
    version_build: z.string().min(1),
    is_emulator: z.boolean(),
    is_prod: z.boolean(),
    platform: z.enum(['ios', 'android', 'electron']),
    plugin_version: z.string().regex(commonSemverRegex),
    defaultChannel: z.string().optional(),
    install_source: z.string().max(64).optional(),
    key_id: z.string().max(20).optional(),
  })

  const rows: MemRow[] = []

  rows.push(measure('import_zod_module', () => {
    void z
  }))

  rows.push(measure('bare_z_string_schema', () => {
    for (let i = 0; i < 100; i++)
      z.string()
  }))

  rows.push(measure('update_request_object_schema', () => {
    void updateSchema
  }))

  if (typeof z.compile === 'function') {
    rows.push(measure('z_compile_update_request', () => {
      z.compile(updateSchema)
    }))

    const compiled = z.compile(updateSchema)
    rows.push(measure('compiled_schema_80k_valid_parse', () => {
      const payload = {
        app_id: 'com.demo.app',
        device_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        version_name: '1.2.3',
        version_build: '1.2.3',
        is_emulator: false,
        is_prod: true,
        platform: 'ios' as const,
        plugin_version: '6.8.1',
      }
      for (let i = 0; i < 80_000; i++)
        compiled.safeParse(payload)
    }))
  }

  const report: MemReport = {
    generatedAt: new Date().toISOString(),
    zodVersion,
    rows,
  }

  console.log(`\n=== Zod memory bench (zod@${zodVersion}) ===`)
  console.log('lower heapUsedDeltaMB is better for one-time schema setup')
  for (const row of rows) {
    console.log(
      `${row.name.padEnd(36)} heap Δ ${row.heapUsedDeltaMB.toFixed(3).padStart(8)} MB | rss Δ ${row.rssDeltaMB.toFixed(3).padStart(8)} MB | heap ${row.heapUsedMB.toFixed(2)} MB`,
    )
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
