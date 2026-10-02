/**
 * Prints the Playwright spec files for one CI shard, balanced by measured duration.
 *
 * Playwright's built-in `--shard` splits by test count, which left one shard with
 * twice the runtime of the other. This assigns whole spec files (specs stay serial
 * and stateful inside a file) with longest-first greedy packing using
 * playwright/spec-durations.json. Spec files missing from that file use a default
 * estimate, so new specs always run somewhere.
 *
 * Usage: bun scripts/playwright-shard-files.ts <index>/<total>
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  const specs = readdirSync(specDir).filter(file => file.endsWith('.spec.ts'))
  const shard = assignSpecsToShards(specs, durations, total)[index - 1]
  if (shard.length === 0) {
    console.error(`Shard ${index}/${total} has no spec files`)
    process.exit(1)
  }
  console.log(shard.map(spec => `playwright/e2e/${spec}`).join(' '))
}

if (import.meta.main)
  main()
