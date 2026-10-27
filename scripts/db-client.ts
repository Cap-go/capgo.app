import type { SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js'
import type { ConsoleQueryRequest, ConsoleQueryResult } from '../supabase/functions/_backend/private/console_query_sql.ts'
import type { PgQuerySession } from '../supabase/functions/_backend/utils/pg_query.ts'
import { env } from 'node:process'
import { createClient as createSdkClient } from '@supabase/supabase-js'
import { decodeJwt } from 'jose'
import { Pool } from 'pg'
import { createDbClient } from '../supabase/functions/_backend/utils/db.ts'
import { runPgQuery } from '../supabase/functions/_backend/utils/pg_query.ts'
import { parsePostgrestRequest, PostgrestHttpError, postgrestResponse } from '../supabase/functions/_backend/utils/postgrest_http.ts'

/**
 * supabase-js `createClient` for Node/Bun/Deno tooling (tests, Playwright,
 * ops scripts). PostgREST is not exposed, so `from` / `rpc` run through the
 * backend's SQL runner over a direct Postgres connection to the same project,
 * under the session PostgREST would have derived from the same key, token and
 * headers. Auth, Storage and Functions stay the
 * real supabase-js clients.
 */

/** supabase-js options plus the Postgres URL that backs `supabaseUrl`. */
export type DbClientOptions = SupabaseClientOptions<any> & {
  /** Defaults to SUPABASE_DB_URL / DB_URL, then the local stack (local `supabaseUrl` only). */
  databaseUrl?: string
}

const LOCAL_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const pools = new Map<string, Pool>()

function isLoopback(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'kong'
  }
  catch {
    return false
  }
}

// The database must belong to the same project as `supabaseUrl`. A script that
// targets a remote project must say which database; it never falls back to local.
export function resolveDatabaseUrl(supabaseUrl: string, explicit?: string): string {
  const url = (explicit ?? env.SUPABASE_DB_URL ?? env.DB_URL ?? (isLoopback(supabaseUrl) ? LOCAL_DATABASE_URL : undefined))?.replace('localhost', '127.0.0.1')
  if (!url)
    throw new Error(`No database URL for ${new URL(supabaseUrl).host}: pass databaseUrl (or set SUPABASE_DB_URL) for that project.`)
  if (!isLoopback(supabaseUrl) && isLoopback(url))
    throw new Error(`Refusing to query the local database for ${new URL(supabaseUrl).host}: pass that project's databaseUrl.`)
  return url
}

function getPool(connectionString: string): Pool {
  let pool = pools.get(connectionString)
  if (!pool) {
    pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 1000, allowExitOnIdle: true, application_name: 'capgo-db-client' })
    pools.set(connectionString, pool)
  }
  return pool
}

function serviceKeys(): Set<string> {
  return new Set([env.SUPABASE_SERVICE_KEY, env.SUPABASE_SERVICE_ROLE_KEY, env.SERVICE_ROLE_KEY, env.SECRET_KEY].filter((key): key is string => Boolean(key)))
}

function failure(status: number, code: string, message: string): ConsoleQueryResult {
  return { data: null, error: { message, code, details: null, hint: null }, count: null, status }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers)
    return undefined
  const key = Object.keys(headers).find(item => item.toLowerCase() === name)
  return key ? headers[key] : undefined
}

async function sessionFor(sdk: SupabaseClient<any>, key: string, headers: Record<string, string> | undefined): Promise<PgQuerySession | ConsoleQueryResult> {
  const explicit = headerValue(headers, 'authorization')
  let token = explicit?.replace(/^Bearer\s+/i, '')
  if (!token) {
    const { data } = await sdk.auth.getSession()
    token = data.session?.access_token ?? key
  }
  const capgkey = headerValue(headers, 'capgkey')
  const requestHeaders = capgkey ? { capgkey } : undefined
  if (serviceKeys().has(token) || token.startsWith('sb_secret_'))
    return { role: 'service', headers: requestHeaders }
  if (token.startsWith('sb_publishable_'))
    return { role: 'anon', headers: requestHeaders }
  let role: unknown
  try {
    role = decodeJwt(token).role
  }
  catch {
    return failure(401, 'PGRST301', 'Expected 3 parts in JWT; got 1')
  }
  if (role === 'anon' && token === key)
    return { role: 'anon', headers: requestHeaders }
  // Same check PostgREST makes: the signature must verify before the role counts.
  const { data, error } = await sdk.auth.getClaims(token)
  if (error || !data?.claims)
    return failure(401, 'PGRST303', error?.message ?? 'JWT could not be verified')
  const claims = data.claims as { sub?: string, role?: string, email?: string, aal?: string }
  if (claims.role === 'service_role')
    return { role: 'service', headers: requestHeaders }
  if (claims.role !== 'authenticated' || !claims.sub)
    return { role: 'anon', headers: requestHeaders }
  return { role: 'authenticated', claims: { ...claims, sub: claims.sub }, headers: requestHeaders }
}

export async function runTestQuery(request: ConsoleQueryRequest, session: PgQuerySession, connectionString = resolveDatabaseUrl('http://127.0.0.1')): Promise<ConsoleQueryResult> {
  const client = await getPool(connectionString).connect()
  let failed: Error | undefined
  try {
    return await runPgQuery(client, request, session)
  }
  catch (error) {
    failed = error instanceof Error ? error : new Error(String(error))
    return failure(503, 'PGRST000', failed.message)
  }
  finally {
    client.release(failed)
  }
}

export function createClient<Database = any>(supabaseUrl: string, supabaseKey: string, options?: DbClientOptions): SupabaseClient<Database> {
  const { databaseUrl, ...sdkOptions } = options ?? {}
  const connectionString = resolveDatabaseUrl(supabaseUrl, databaseUrl)
  const sdk = createSdkClient<Database>(supabaseUrl, supabaseKey, sdkOptions as SupabaseClientOptions<any>) as unknown as SupabaseClient<any>
  const headers = sdkOptions.global?.headers as Record<string, string> | undefined
  const db = createDbClient(async (request) => {
    const session = await sessionFor(sdk, supabaseKey, headers)
    return 'role' in session ? runTestQuery(request, session, connectionString) : session
  })
  return new Proxy(sdk, {
    get(target, property, receiver) {
      if (property === 'from')
        return db.from
      if (property === 'rpc')
        return db.rpc
      return Reflect.get(target, property, receiver)
    },
  }) as unknown as SupabaseClient<Database>
}

/**
 * What `fetch(`${SUPABASE_URL}/rest/v1/...`)` returned when PostgREST was exposed,
 * answered in-process: same request parsing, same session rules, same response.
 */
export async function fetchPostgrest(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input))
  const requestHeaders = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  let parsed
  try {
    parsed = parsePostgrestRequest({
      method,
      url,
      header: name => requestHeaders.get(name),
      body: typeof init.body === 'string' ? init.body : null,
    })
  }
  catch (error) {
    if (!(error instanceof PostgrestHttpError))
      throw error
    const response = error.response()
    return new Response(JSON.stringify(response.body), { status: response.status, headers: { 'Content-Type': 'application/json' } })
  }
  const key = requestHeaders.get('apikey') ?? ''
  const headerRecord = Object.fromEntries(requestHeaders.entries())
  const sdk = createSdkClient(url.origin, key || 'anon', { auth: { persistSession: false } }) as unknown as SupabaseClient<any>
  const session = await sessionFor(sdk, key, headerRecord)
  const result = 'role' in session ? await runTestQuery(parsed.request, session, resolveDatabaseUrl(url.origin)) : session
  const response = postgrestResponse(parsed, result)
  const body = response.body === undefined ? null : JSON.stringify(response.body)
  return new Response(body, {
    status: response.status,
    headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), ...response.headers },
  })
}
