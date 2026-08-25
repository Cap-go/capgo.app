/**
 * CRITICAL — Published CLI RPC contract (do not break old CLI)
 *
 * We cannot break already-published @capgo/cli versions that customers still run.
 * This file is the live guard for #3189-style regressions: if a migration revokes
 * anon EXECUTE on an RPC the last published CLI still calls (for example
 * `.rpc('get_user_id', { apikey })`), CI MUST fail here.
 *
 * CI job: CRITICAL — Published CLI / do not break old CLI
 * Do NOT invert these tests to expect permission denied (42501). Success is the contract.
 */
import type { Database } from '../src/types/supabase.types'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  extractPublishedCliRpcCalls,
  formatPublishedCliRpcCall,
  resolveLatestPublishedCliTag,
  resolvePublishedCliNpmInstallVersion,
  rpcCallMatchesOverload,
  type PublishedCliRpcCall,
} from '../scripts/published-cli-contract.ts'
import {
  APIKEY_TEST_ORG_SUPER_ADMIN,
  normalizeLocalhostUrl,
  POSTGRES_URL,
  USER_ID,
} from './test-utils'

const execFileAsync = promisify(execFile)
const SUPABASE_URL = normalizeLocalhostUrl(process.env.SUPABASE_URL)!
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY as string

interface FunctionPrivilegeRow {
  proc: string
  arg_names: string[] | null
  default_count: number
  arg_count: number
  anon_exec: boolean
}

const publishedCliTag = resolveLatestPublishedCliTag()
const publishedCliNpmVersion = resolvePublishedCliNpmInstallVersion(publishedCliTag)
const publishedCliRpcCalls = extractPublishedCliRpcCalls(publishedCliTag)

async function loadFunctionPrivileges(functionName: string): Promise<FunctionPrivilegeRow[]> {
  const pool = new Pool({ connectionString: POSTGRES_URL })
  try {
    const result = await pool.query<FunctionPrivilegeRow>(`
      SELECT
        p.oid::regprocedure::text AS proc,
        p.proargnames AS arg_names,
        COALESCE(p.pronargdefaults, 0) AS default_count,
        p.pronargs AS arg_count,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec
      FROM pg_proc AS p
      INNER JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname = $1
      ORDER BY 1
    `, [functionName])

    return result.rows
  }
  finally {
    await pool.end()
  }
}

function resolveMatchingOverloads(call: PublishedCliRpcCall, rows: FunctionPrivilegeRow[]) {
  return rows.filter(row => rpcCallMatchesOverload(
    call,
    row.arg_names,
    Number(row.default_count),
    Number(row.arg_count),
  ))
}

function createAnonymousApiKeyClient(apikey: string) {
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        capgkey: apikey,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

describe(`CRITICAL published CLI RPC contract (${publishedCliTag})`, () => {
  let pool: Pool

  beforeAll(() => {
    pool = new Pool({ connectionString: POSTGRES_URL })
    expect(publishedCliRpcCalls.length).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent(`keeps anon EXECUTE on every RPC still called by ${publishedCliTag}`, async () => {
    const missing: string[] = []

    for (const call of publishedCliRpcCalls) {
      const overloads = await loadFunctionPrivileges(call.name)
      expect(overloads.length, `${call.name} is missing from public schema`).toBeGreaterThan(0)

      const matches = resolveMatchingOverloads(call, overloads)
      expect(matches.length, `No overload matched ${formatPublishedCliRpcCall(call)}`).toBeGreaterThan(0)

      for (const overload of matches) {
        if (!overload.anon_exec)
          missing.push(`${overload.proc} required by ${formatPublishedCliRpcCall(call)}`)
      }
    }

    expect(missing, `Published CLI ${publishedCliTag} would break in production:\n${missing.join('\n')}`).toEqual([])
  })

  it.concurrent(`published CLI identity RPC get_user_id({ apikey }) MUST succeed for valid API keys`, async () => {
    const client = createAnonymousApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const { data, error } = await client.rpc('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
    })

    expect(error, 'Do not expect permission denied — published CLI customers rely on this RPC').toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent(`published @capgo/cli@${publishedCliNpmVersion} app list MUST succeed against this schema`, async () => {
    const { stdout, stderr } = await execFileAsync('bunx', [
      `@capgo/cli@${publishedCliNpmVersion}`,
      'app',
      'list',
      '-a',
      APIKEY_TEST_ORG_SUPER_ADMIN,
      '--supa-host',
      SUPABASE_URL,
      '--supa-anon',
      SUPABASE_ANON_KEY,
      '--output-text',
    ], {
      timeout: 180_000,
      env: {
        ...process.env,
        CI: 'true',
        NO_COLOR: '1',
      },
    })

    const output = `${stdout}\n${stderr}`
    expect(output).not.toMatch(/permission denied/i)
    expect(output).not.toMatch(/42501/)
    expect(stdout).toContain('Apps (CSV)')
  }, 180_000)
})
