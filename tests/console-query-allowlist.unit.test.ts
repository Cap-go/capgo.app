// Every table and RPC the console reaches through useConsole() must be on the
// /private/console/query allowlist, otherwise the API answers 403 at runtime.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONSOLE_RPCS, CONSOLE_TABLES } from '../supabase/functions/_backend/utils/console_query_allowlist'

const root = join(import.meta.dirname, '..')

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory())
      walk(path, out)
    else if (/\.(?:ts|vue)$/.test(entry))
      out.push(path)
  }
  return out
}

function collect() {
  const tables = new Set<string>()
  const rpcs = new Set<string>()
  const buckets = new Set<string>()
  for (const file of walk(join(root, 'src'), [])) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\.storage\s*\.from\(\s*[`'"]([a-z0-9_]+)[`'"]\s*\)/g))
      buckets.add(match[1])
    for (const match of source.matchAll(/(?<!storage\s{0,8})\.from\(\s*[`'"]([a-z0-9_]+)[`'"]\s*\)/g)) {
      if (!/\.storage\s*$/.test(source.slice(Math.max(0, match.index! - 40), match.index!)))
        tables.add(match[1])
    }
    for (const match of source.matchAll(/\.rpc\(\s*[`'"]([a-z0-9_]+)[`'"]/g))
      rpcs.add(match[1])
  }
  return { tables, rpcs, buckets }
}

describe('console query allowlist', () => {
  const used = collect()

  it('covers every table the console queries', () => {
    const missing = [...used.tables].filter(table => !CONSOLE_TABLES.has(table)).sort()
    expect(missing).toEqual([])
  })

  it('covers every RPC the console calls', () => {
    const missing = [...used.rpcs].filter(rpc => !CONSOLE_RPCS.has(rpc)).sort()
    expect(missing).toEqual([])
  })

  it('only serves the images storage bucket', () => {
    expect([...used.buckets]).toEqual(['images'])
  })

  it('does not allow more than the console uses', () => {
    const unusedTables = [...CONSOLE_TABLES].filter(table => !used.tables.has(table)).sort()
    const unusedRpcs = [...CONSOLE_RPCS].filter(rpc => !used.rpcs.has(rpc)).sort()
    expect({ unusedTables, unusedRpcs }).toEqual({ unusedTables: [], unusedRpcs: [] })
  })
})
