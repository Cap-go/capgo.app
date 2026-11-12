import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Tests must never rely on PostgREST (see AGENTS.md, "Never rely on PostgREST
// from tests"). Data access goes through ./sql-data-client (createClient) or
// ./sql-rest-request; raw SQL through executeSQL.

const TESTS_DIR = join(process.cwd(), 'tests')

// Files that may mention the PostgREST path without calling it.
const REST_PATH_ALLOWED: Record<string, string> = {
  'tests/cli-preview-lifecycle.test.ts': 'asserts the CLI does not call PostgREST',
  'tests/console-auth-proxy.unit.test.ts': 'path traversal input for the auth proxy',
  'tests/http-dispatch.unit.test.ts': 'origin parsing input',
  'tests/no-postgrest-in-tests.unit.test.ts': 'this guard',
  'tests/sql-data-client.ts': 'documents the rule',
  'tests/sql-rest-request.ts': 'documents the request shape it replaces',
}

const SUPABASE_JS_CREATE_CLIENT_ALLOWED = new Set(['tests/sql-data-client.ts'])

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === 'node_modules' || entry.name.startsWith('.') ? [] : testFiles(path)
    return /\.(?:ts|mts|js|mjs)$/.test(entry.name) ? [path] : []
  })
}

const files = testFiles(TESTS_DIR).map(path => ({
  name: relative(process.cwd(), path),
  source: readFileSync(path, 'utf8'),
}))

describe('tests never rely on PostgREST', () => {
  it('no test calls a /rest/v1 URL', () => {
    const offenders = files
      .filter(file => !(file.name in REST_PATH_ALLOWED) && /\/rest\/v1\b/.test(file.source))
      .map(file => file.name)
    expect(offenders).toEqual([])
  })

  it('no test builds a supabase-js client whose from()/rpc() would reach PostgREST', () => {
    const valueImport = /import\s+\{[^}]*\bcreateClient\b[^}]*\}\s+from\s+['"]@supabase\/supabase-js['"]/
    const offenders = files
      .filter(file => !SUPABASE_JS_CREATE_CLIENT_ALLOWED.has(file.name) && valueImport.test(file.source))
      .map(file => file.name)
    expect(offenders).toEqual([])
  })
})
