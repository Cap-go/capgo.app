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
  resolvePublishedCliRpcSourceTag,
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
  argNames: string[] | null
  defaultCount: number
  argCount: number
  anonExec: boolean
}

interface PublishedCliContractContext {
  tag: string
  npmVersion: string
  rpcSourceTag: string
  rpcCalls: PublishedCliRpcCall[]
}

let publishedCliContract: PublishedCliContractContext | undefined

function loadPublishedCliContract(): PublishedCliContractContext {
  if (!publishedCliContract) {
    const tag = resolveLatestPublishedCliTag()
    const npmVersion = resolvePublishedCliNpmInstallVersion(tag)
    const rpcSourceTag = resolvePublishedCliRpcSourceTag(tag, npmVersion)
    publishedCliContract = {
      tag,
      npmVersion,
      rpcSourceTag,
      rpcCalls: extractPublishedCliRpcCalls(rpcSourceTag),
    }
  }

  return publishedCliContract
}

async function loadFunctionPrivileges(pool: Pool, functionName: string): Promise<FunctionPrivilegeRow[]> {
  const result = await pool.query<FunctionPrivilegeRow>(`
    SELECT
      p.oid::regprocedure::text AS proc,
      CASE
        WHEN p.proargnames IS NULL THEN NULL
        WHEN p.proargmodes IS NULL THEN p.proargnames
        ELSE ARRAY(
          SELECT name
          FROM unnest(p.proargnames, p.proargmodes) AS a(name, mode)
          WHERE a.mode IN ('i', 'b', 'v')
        )
      END AS "argNames",
      COALESCE(p.pronargdefaults, 0) AS "defaultCount",
      p.pronargs AS "argCount",
      has_function_privilege('anon', p.oid, 'EXECUTE') AS "anonExec"
    FROM pg_proc AS p
    INNER JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname = $1
    ORDER BY 1
  `, [functionName])

  return result.rows
}

function resolveMatchingOverloads(call: PublishedCliRpcCall, rows: FunctionPrivilegeRow[]) {
  if (call.argKeys === null)
    return rows

  return rows.filter(row => rpcCallMatchesOverload(
    call,
    row.argNames,
    Number(row.defaultCount),
    Number(row.argCount),
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

describe('CRITICAL published CLI RPC contract', () => {
  let pool: Pool
  let contract: PublishedCliContractContext

  beforeAll(() => {
    contract = loadPublishedCliContract()
    pool = new Pool({ connectionString: POSTGRES_URL })
    expect(contract.rpcCalls.length, `No RPC calls extracted from ${contract.rpcSourceTag}`).toBeGreaterThan(0)
  })

  afterAll(async () => {
    await pool.end()
  })

  it.concurrent('keeps anon EXECUTE on every RPC still called by the published CLI', async () => {
    const missing: string[] = []

    for (const call of contract.rpcCalls) {
      const overloads = await loadFunctionPrivileges(pool, call.name)
      expect(overloads.length, `${call.name} is missing from public schema`).toBeGreaterThan(0)

      const matches = resolveMatchingOverloads(call, overloads)
      if (call.argKeys !== null)
        expect(matches.length, `No overload matched ${formatPublishedCliRpcCall(call)}`).toBeGreaterThan(0)

      const overloadsToCheck = call.argKeys === null ? overloads : matches
      const hasAnonExec = overloadsToCheck.some(overload => overload.anonExec)

      if (!hasAnonExec) {
        const procList = overloadsToCheck
          .map(overload => overload.proc)
          .join(', ')
        missing.push(`${procList || call.name} required by ${formatPublishedCliRpcCall(call)}`)
      }
    }

    expect(missing, `Published CLI ${contract.rpcSourceTag} would break in production:\n${missing.join('\n')}`).toEqual([])
  })

  it.concurrent(`published CLI identity RPC get_user_id({ apikey }) MUST succeed for valid API keys`, async () => {
    const client = createAnonymousApiKeyClient(APIKEY_TEST_ORG_SUPER_ADMIN)

    const { data, error } = await client.rpc('get_user_id', {
      apikey: APIKEY_TEST_ORG_SUPER_ADMIN,
    })

    expect(error, 'Do not expect permission denied — published CLI customers rely on this RPC').toBeNull()
    expect(data).toBe(USER_ID)
  })

  it.concurrent('published @capgo/cli app list MUST succeed against this schema', async () => {
    const { stdout, stderr } = await execFileAsync('bunx', [
      `@capgo/cli@${contract.npmVersion}`,
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
  }, 180_000)
})
