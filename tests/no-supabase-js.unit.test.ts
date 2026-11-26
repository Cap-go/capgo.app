// Guard: the Supabase JS SDK is gone from the repo and must not come back, in any
// package.json, deno.json import map, lockfile or source file. Data goes through
// Capgo's own clients (pg / drizzle, the gotrueAuth fetch helper, the console API).
// `@supabase/postgrest-js` (ConsoleDataClient types) and the `supabase` CLI are a
// different package and stay allowed.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')
const SDK = '@supabase/supabase-js'

// Tracked files that may name the package without depending on it.
const ALLOWED: Array<{ path: RegExp, reason: string }> = [
  { path: /^tests\/no-supabase-js\.unit\.test\.ts$/, reason: 'this guard' },
  { path: /^tests\/no-postgrest-in-tests\.unit\.test\.ts$/, reason: 'import-detection fixtures' },
  { path: /^docs\//, reason: 'historical plans and notes' },
  { path: /^scripts\/bench\/plugin_worker_runtime_[a-z]+\.json$/, reason: 'recorded bench measurements' },
]

function filesNamingSdk(): string[] {
  try {
    // -I skips binary files, -F matches the literal name.
    return execFileSync('git', ['grep', '-l', '-I', '-F', SDK], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
  }
  catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1)
      return []
    throw error
  }
}

describe('supabase-js is not used anywhere in the repo', () => {
  const files = filesNamingSdk()

  it('the scan sees tracked files (this guard names the package)', () => {
    expect(files).toContain('tests/no-supabase-js.unit.test.ts')
  })

  it('no dependency, import map, lockfile or source file names the package', () => {
    const offenders = files.filter(file => !ALLOWED.some(({ path }) => path.test(file)))
    expect(offenders).toEqual([])
  })
})
