import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEGACY_CLI_RPCS, LEGACY_CLI_TABLES } from '../supabase/functions/_backend/private/legacy_supabase.ts'
import { MIN_CLI_VERSION } from '../supabase/functions/_backend/utils/cliMinVersion.ts'

// PostgREST is off. These checks keep it that way: nothing may build a client
// that talks to /rest/v1, and released CLIs keep a working Supabase-shaped host.

const ROOT = join(import.meta.dirname, '..')
const BACKEND = join(ROOT, 'supabase/functions/_backend')
// The last CLI that still shipped the Supabase SDK. 8.90.1 calls only the Capgo API.
const LAST_SDK_CLI = '8.90.0'

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory())
      return name === 'node_modules' ? [] : sourceFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  }
  catch {
    return null
  }
}

function cliSource(tag: string): string | null {
  const files = git(['ls-tree', '-r', '--name-only', tag, 'cli/src'])
  if (files === null)
    return null
  return files.split('\n').filter(file => file.endsWith('.ts')).map(file => git(['show', `${tag}:${file}`]) ?? '').join('\n')
}

describe('no PostgREST', () => {
  it('turns the Data API off locally', () => {
    const config = readFileSync(join(ROOT, 'supabase/config.toml'), 'utf8')
    const api = config.slice(config.indexOf('[api]'), config.indexOf('[api.tls]'))
    expect(api).toMatch(/^enabled = false$/m)
    expect(api).toMatch(/^schemas = \[\]$/m)
  })

  it('builds supabase-js clients only for Auth and Storage in the backend', () => {
    const allowed = new Set(['utils/supabase.ts', 'utils/hono_jwt.ts'])
    const offenders = sourceFiles(BACKEND)
      .filter(file => /import\s*\{[^}]*\bcreateClient\b[^}]*\}\s*from\s*['"](?:npm:)?@supabase\/supabase-js/.test(readFileSync(file, 'utf8')))
      .map(file => relative(BACKEND, file))
      .filter(file => !allowed.has(file))
    expect(offenders).toEqual([])
  })

  it('names /rest/v1 only where released CLIs are served', () => {
    const allowed = new Set(['private/legacy_supabase.ts', 'utils/postgrest_http.ts'])
    const offenders = sourceFiles(BACKEND)
      .filter(file => readFileSync(file, 'utf8').includes('/rest/v1'))
      .map(file => relative(BACKEND, file))
      .filter(file => !allowed.has(file))
    expect(offenders).toEqual([])
  })

  for (const version of [MIN_CLI_VERSION, LAST_SDK_CLI]) {
    const source = cliSource(`cli-${version}`)
    it.skipIf(source === null)(`serves every table and RPC CLI ${version} calls`, () => {
      const rpcs = new Set([...source!.matchAll(/\.rpc\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)].map(match => match[1]))
      // `.storage.from('images')` is Storage, relayed as is.
      const tables = new Set([...source!.matchAll(/(\.storage\s*)?\.from\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)]
        .filter(match => !match[1])
        .map(match => match[2]))
      expect([...rpcs].filter(name => !LEGACY_CLI_RPCS.has(name))).toEqual([])
      expect([...tables].filter(name => !LEGACY_CLI_TABLES.has(name))).toEqual([])
    })
  }
})
