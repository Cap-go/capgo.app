/**
 * Prints the Playwright spec files for one CI shard, balanced by measured duration.
 *
 * Playwright's built-in `--shard` splits by test count, which left one shard with
 * twice the runtime of the other. This assigns whole spec files (specs stay serial
 * and stateful inside a file) with longest-first greedy packing using
 * playwright/spec-durations.json (keys are paths relative to playwright/e2e). Spec files
 * missing from that file use a default estimate, so new specs always run somewhere, and
 * the script warns so the durations file gets updated.
 *
 * Usage: bun scripts/playwright-shard-files.ts <index>/<total>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_SPEC_SECONDS = 10
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const specDir = join(repoRoot, 'playwright', 'e2e')

export function assignSpecsToShards(specs: string[], durations: Record<string, number>, total: number): string[][] {
  const shards = Array.from({ length: total }, () => ({ seconds: 0, specs: [] as string[] }))
  const ordered = [...specs].sort((a, b) => {
    const delta = (durations[b] ?? DEFAULT_SPEC_SECONDS) - (durations[a] ?? DEFAULT_SPEC_SECONDS)
    return delta !== 0 ? delta : a.localeCompare(b)
  })
  for (const spec of ordered) {
    const target = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    target.specs.push(spec)
    target.seconds += durations[spec] ?? DEFAULT_SPEC_SECONDS
  }
  return shards.map(shard => shard.specs.sort())
}

function main() {
  const match = process.argv[2]?.match(/^(\d+)\/(\d+)$/)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || index > total) {
    console.error('Usage: bun scripts/playwright-shard-files.ts <index>/<total>')
    process.exit(2)
  }

  const durations: Record<string, number> = JSON.parse(readFileSync(join(repoRoot, 'playwright', 'spec-durations.json'), 'utf8'))
  const specs = readdirSync(specDir, { recursive: true, encoding: 'utf8' })
    .map(file => file.split(sep).join('/'))
    .filter(file => file.endsWith('.spec.ts'))
  const missing = specs.filter(spec => durations[spec] === undefined)
  const stale = Object.keys(durations).filter(spec => !specs.includes(spec))
  if (missing.length > 0)
    console.error(`::warning::playwright/spec-durations.json has no duration for ${missing.join(', ')}; using ${DEFAULT_SPEC_SECONDS}s. Add measured durations to keep shards balanced.`)
  if (stale.length > 0)
    console.error(`::warning::playwright/spec-durations.json lists missing specs: ${stale.join(', ')}`)
  const shard = assignSpecsToShards(specs, durations, total)[index - 1]
  if (shard.length === 0) {
    console.error(`Shard ${index}/${total} has no spec files`)
    process.exit(1)
  }
  console.log(shard.map(spec => `playwright/e2e/${spec}`).join(' '))
}

if (import.meta.main)
  main()
