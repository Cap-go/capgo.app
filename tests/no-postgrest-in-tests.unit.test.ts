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
  'tests/legacy-cli-manifest-warning-snippet.unit.test.ts': 'request URLs for the edge snippet, fetch is stubbed',
  'tests/no-postgrest-in-tests.unit.test.ts': 'this guard',
  'tests/sql-data-client.ts': 'documents the rule',
  'tests/sql-rest-request.ts': 'documents the request shape it replaces',
}

const SUPABASE_JS = String.raw`['"]@supabase/supabase-js['"]`
const SUPABASE_JS_IMPORT = [
  // import ... from / export ... from, type-only included
  new RegExp(String.raw`\b(?:import|export)\b[^;]*?\bfrom\s*${SUPABASE_JS}`),
  // side-effect import, require() and dynamic import()
  new RegExp(String.raw`(?:import|require)\s*\(?\s*${SUPABASE_JS}`),
]

function importsSupabaseJs(source: string): boolean {
  return SUPABASE_JS_IMPORT.some(pattern => pattern.test(source))
}

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

  it('no test imports supabase-js (data goes through ./sql-data-client, auth/storage/functions through ./local-stack-http)', () => {
    const offenders = files
      .filter(file => file.name !== 'tests/no-postgrest-in-tests.unit.test.ts' && importsSupabaseJs(file.source))
      .map(file => file.name)
    expect(offenders).toEqual([])
  })

  it.each([
    'import { createClient } from \'@supabase/supabase-js\'',
    'import { PostgrestError, createClient as make } from "@supabase/supabase-js"',
    'import * as supabase from \'@supabase/supabase-js\'',
    'import supabase from \'@supabase/supabase-js\'',
    'import type { SupabaseClient } from \'@supabase/supabase-js\'',
    'import {\n  type SupabaseClient,\n  createClient,\n} from \'@supabase/supabase-js\'',
    'export type { SupabaseClient } from \'@supabase/supabase-js\'',
    'const { createClient } = require(\'@supabase/supabase-js\')',
    'const supabase = await import(\'@supabase/supabase-js\')',
    'import \'@supabase/supabase-js\'',
    'import{createClient}from\'@supabase/supabase-js\'',
    'export{type SupabaseClient}from"@supabase/supabase-js"',
  ])('flags %s', (source) => {
    expect(importsSupabaseJs(source)).toBe(true)
  })

  it.each([
    'import { createClient } from \'./sql-data-client\'',
    'import type { TestClient } from \'./sql-data-client\'',
    'import { createClient } from \'@supabase/postgrest-js\'',
  ])('allows %s', (source) => {
    expect(importsSupabaseJs(source)).toBe(false)
  })
})
