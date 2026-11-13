import type { SupabaseClient, SupabaseClientOptions } from '@supabase/supabase-js'
import type { PoolClient } from 'pg'
import type { CatalogFunctionRow, CompiledConsoleQuery, ConsoleQueryOperation, ConsoleQueryRequest, ConsoleQueryResult, QueryCatalog, QueryColumn, QueryForeignKey } from '../supabase/functions/_backend/private/console_query_sql.ts'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient as createSupabaseClient, PostgrestError } from '@supabase/supabase-js'
import { decodeJwt } from 'jose'
import { escapeLiteral, Pool } from 'pg'
import { compileConsoleQuery, ConsoleQueryError, functionFromCatalogRow, shapeConsoleQueryResult } from '../supabase/functions/_backend/private/console_query_sql.ts'

/**
 * Test data access without PostgREST.
 *
 * Tests must never send requests to PostgREST (`/rest/v1`). This client keeps
 * the supabase-js `from()` / `rpc()` builder API, compiles the recorded chain
 * with the backend's console compiler, and runs it on Postgres in one
 * transaction with the context PostgREST would have set: the role from the
 * JWT, `request.jwt.claims`, `request.headers` (RLS reads `capgkey` from it),
 * `request.method` (the `app_versions` SELECT policy reads it), `request.path`
 * and the role's own settings such as `statement_timeout`.
 *
 * `auth` (GoTrue), `storage` and `functions` are not PostgREST and stay on
 * supabase-js; see `withSqlData`.
 */

type DbRole = 'anon' | 'authenticated' | 'service_role'

interface DbIdentity {
  role: DbRole
  claims: Record<string, unknown>
  headers: Record<string, string>
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE'

interface SqlCatalog extends QueryCatalog {
  primaryKeys: Map<string, string[]>
  roleSettings: Map<string, Array<[string, string]>>
  voidFunctions: Set<string>
  compositeTypes: Set<string>
}

export interface SqlResponse {
  data: unknown
  error: PostgrestError | null
  count: number | null
  status: number
  statusText: string
}

const DEFAULT_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
// One connection per test worker: PostgREST used to share a small pool across
// all workers, and the edge runtime needs slots too.
const POOL_SIZE = 1
const CONNECT_ATTEMPTS = 20
const CONNECT_BACKOFF_MS = 250
const CONNECT_BACKOFF_MAX_MS = 2000
const SEARCH_PATH = 'public, public, extensions'
const WRITE_METHODS = new Set(['insert', 'upsert', 'update', 'delete'])
const FILTER_METHODS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike', 'is', 'in', 'contains', 'containedBy', 'overlaps', 'not', 'or', 'filter', 'match'])
// Type-only helpers on the supabase-js builder. They never reach PostgREST.
const NO_OP_METHODS = new Set(['returns', 'overrideTypes', 'abortSignal', 'setHeader'])

let pool: Pool | null = null
let poolUrl = ''
let catalogTask: Promise<SqlCatalog> | null = null

// scripts/test-db-tinbase.sh passes a placeholder URL: Tinbase's Postgres has
// no TCP port, only a private unix socket whose directory is in postmaster.pid.
const TINBASE_PLACEHOLDER_HOST = 'tinbase-no-tcp'

function tinbaseSocketUrl(): string {
  // The native engine (default on macOS/Linux) keeps its cluster in .tinbase/pgdata.
  const pidFile = resolve(process.cwd(), '.tinbase', 'pgdata', 'postmaster.pid')
  if (!existsSync(pidFile))
    throw new Error(`Tinbase Postgres socket not found (${pidFile} is missing; the wasm engine has no socket)`)
  const socketDir = readFileSync(pidFile, 'utf8').split('\n')[4]?.trim()
  if (!socketDir)
    throw new Error(`Tinbase postmaster.pid has no socket directory: ${pidFile}`)
  return `postgresql://postgres@/postgres?host=${encodeURIComponent(socketDir)}`
}

function databaseUrl(): string {
  const raw = process.env.SUPABASE_DB_URL ?? process.env.DB_URL ?? DEFAULT_DB_URL
  if (raw.includes(TINBASE_PLACEHOLDER_HOST))
    return tinbaseSocketUrl()
  return raw.replace('localhost', '127.0.0.1')
}

function getPool(): Pool {
  const url = databaseUrl()
  if (!pool || poolUrl !== url) {
    pool = new Pool({ connectionString: url, max: POOL_SIZE, idleTimeoutMillis: 2000 })
    poolUrl = url
    catalogTask = null
  }
  return pool
}


const CATALOG_SQL = `
SELECT
  COALESCE((
    SELECT json_agg(json_build_object('table_name', c.relname, 'column_name', a.attname, 'udt', t.typname))
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  ), '[]'::json) AS columns,
  COALESCE((
    SELECT json_agg(json_build_object(
      'name', con.conname,
      'sourceTable', src.relname,
      'sourceColumn', sa.attname,
      'targetTable', dst.relname,
      'targetColumn', da.attname,
      'unique', EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint AS uniq
        WHERE uniq.conrelid = con.conrelid AND uniq.contype IN ('u', 'p') AND uniq.conkey = con.conkey
      )
    ))
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS src ON src.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS sn ON sn.oid = src.relnamespace
    JOIN pg_catalog.pg_class AS dst ON dst.oid = con.confrelid
    JOIN pg_catalog.pg_namespace AS dn ON dn.oid = dst.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) ON true
    JOIN pg_catalog.pg_attribute AS sa ON sa.attrelid = src.oid AND sa.attnum = sk.attnum
    JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS dk(attnum, ord) ON dk.ord = sk.ord
    JOIN pg_catalog.pg_attribute AS da ON da.attrelid = dst.oid AND da.attnum = dk.attnum
    WHERE con.contype = 'f' AND sn.nspname = 'public' AND dn.nspname = 'public' AND cardinality(con.conkey) = 1
  ), '[]'::json) AS foreign_keys,
  COALESCE((
    SELECT json_agg(json_build_object(
      'name', p.proname,
      'returns_set', p.proretset,
      'arg_count', p.pronargs,
      'default_count', p.pronargdefaults,
      'arg_names', p.proargnames,
      'arg_modes', p.proargmodes,
      'return_kind', ret.typtype,
      'arg_types', ARRAY(
        SELECT typ.typname::text
        FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS args(oid, ord)
        JOIN pg_catalog.pg_type AS typ ON typ.oid = args.oid
        ORDER BY args.ord
      )
    ))
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type AS ret ON ret.oid = p.prorettype
    WHERE n.nspname = 'public' AND p.prokind = 'f'
  ), '[]'::json) AS functions,
  COALESCE((
    SELECT json_agg(json_build_object('table_name', c.relname, 'columns', ARRAY(
      SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = k.attnum
      ORDER BY k.ord
    )))
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE con.contype = 'p' AND n.nspname = 'public'
  ), '[]'::json) AS primary_keys,
  COALESCE((
    SELECT json_agg(json_build_object('role', r.rolname, 'settings', s.setconfig))
    FROM pg_catalog.pg_db_role_setting AS s
    JOIN pg_catalog.pg_roles AS r ON r.oid = s.setrole
    WHERE r.rolname IN ('authenticator', 'anon', 'authenticated', 'service_role')
      AND s.setdatabase IN (0, (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()))
  ), '[]'::json) AS role_settings,
  COALESCE((
    SELECT json_agg(DISTINCT p.proname)
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prorettype = 'pg_catalog.void'::regtype
  ), '[]'::json) AS void_functions,
  COALESCE((
    SELECT json_agg(t.typname)
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_class AS c ON c.oid = t.typrelid
    WHERE n.nspname = 'public' AND t.typtype = 'c' AND c.relkind = 'c'
  ), '[]'::json) AS composite_types
`

interface CatalogRow {
  columns: Array<{ table_name: string, column_name: string, udt: string }>
  foreign_keys: QueryForeignKey[]
  functions: CatalogFunctionRow[]
  primary_keys: Array<{ table_name: string, columns: string[] }>
  role_settings: Array<{ role: string, settings: string[] }>
  void_functions: string[]
  composite_types: string[]
}

async function readCatalog(db: Pool): Promise<SqlCatalog> {
  const client = await connect(db)
  let rows: CatalogRow[]
  try {
    rows = (await client.query<CatalogRow>(CATALOG_SQL)).rows
  }
  finally {
    client.release()
  }
  const row = rows[0]
  const columns = new Map<string, QueryColumn[]>()
  for (const column of row.columns) {
    const list = columns.get(column.table_name) ?? []
    columns.set(column.table_name, [...list, { name: column.column_name, udt: column.udt }])
  }
  const functions = row.functions.map(functionFromCatalogRow).filter(fn => fn !== null)
  const primaryKeys = new Map(row.primary_keys.map(key => [key.table_name, key.columns]))
  const roleSettings = new Map<string, Array<[string, string]>>()
  for (const entry of row.role_settings) {
    const pairs = (entry.settings ?? []).map((setting) => {
      const index = setting.indexOf('=')
      return [setting.slice(0, index), setting.slice(index + 1)] as [string, string]
    })
    roleSettings.set(entry.role, [...(roleSettings.get(entry.role) ?? []), ...pairs])
  }
  return { columns, foreignKeys: row.foreign_keys, functions, primaryKeys, roleSettings, voidFunctions: new Set(row.void_functions), compositeTypes: new Set(row.composite_types) }
}

function loadCatalog(db: Pool): Promise<SqlCatalog> {
  if (!catalogTask) {
    catalogTask = readCatalog(db).catch((error: unknown) => {
      catalogTask = null
      throw error
    })
  }
  return catalogTask
}

/** PostgREST's answer to a token it cannot use (PGRST301 malformed, PGRST303 expired). */
export class JwtRejectedError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'JwtRejectedError'
    this.code = code
  }
}

/**
 * Claims PostgREST would read from an API key or user JWT. Tokens come from
 * GoTrue or the local stack keys, so only shape and expiry are checked here.
 */
export function identityFromToken(token: string, headers: Record<string, string> = {}): DbIdentity {
  if (token.startsWith('sb_secret_'))
    return { role: 'service_role', claims: { role: 'service_role' }, headers }
  if (token.startsWith('sb_publishable_'))
    return { role: 'anon', claims: { role: 'anon' }, headers }
  let claims: Record<string, unknown>
  try {
    claims = decodeJwt(token) as Record<string, unknown>
  }
  catch {
    throw new JwtRejectedError('PGRST301', 'Expected 3 parts in JWT; got 1')
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now())
    throw new JwtRejectedError('PGRST303', 'JWT expired')
  const role = claims.role
  if (role !== 'anon' && role !== 'authenticated' && role !== 'service_role')
    throw new Error(`Unsupported JWT role for test data access: ${String(role)}`)
  return { role, claims, headers }
}

export function jwtRejectedResponse(error: JwtRejectedError): SqlResponse {
  return toResponse({ data: null, error: { message: error.message, code: error.code, details: null }, count: null, status: 401 }, 401)
}

function methodOf(request: ConsoleQueryRequest): HttpMethod {
  if (request.kind === 'rpc')
    return 'POST'
  const write = request.operations.find(operation => WRITE_METHODS.has(operation.method))?.method
  if (write === 'update')
    return 'PATCH'
  if (write === 'delete')
    return 'DELETE'
  return write ? 'POST' : 'GET'
}

function setupSql(catalog: SqlCatalog, identity: DbIdentity, request: ConsoleQueryRequest): string {
  const path = request.kind === 'rpc' ? `/rpc/${request.name}` : `/${request.name}`
  const settings: Array<[string, string]> = [
    ['search_path', SEARCH_PATH],
    ['role', identity.role],
    // PostgREST's session belongs to authenticator; the impersonated role's own settings win.
    ...(catalog.roleSettings.get('authenticator') ?? []).filter(([name]) => name !== 'session_preload_libraries'),
    ...(catalog.roleSettings.get(identity.role) ?? []),
    ['request.jwt.claims', JSON.stringify(identity.claims)],
    ['request.headers', JSON.stringify(identity.headers)],
    ['request.cookies', '{}'],
    ['request.method', methodOf(request)],
    ['request.path', path],
  ]
  const calls = settings.map(([name, value]) => `pg_catalog.set_config(${escapeLiteral(name)}, ${escapeLiteral(value)}, true)`)
  return `SELECT ${calls.join(', ')}`
}

// supabase-js removes whitespace outside double quotes before sending a select.
function cleanSelect(text: string): string {
  let quoted = false
  return [...text].filter((char) => {
    if (char === '"')
      quoted = !quoted
    return quoted || !/\s/.test(char)
  }).join('')
}

// PostgREST defaults: upsert resolves on the primary key, and a bulk write
// sends the union of row keys with missing values as null.
function normalizeOperation(catalog: SqlCatalog, table: string, operation: ConsoleQueryOperation): ConsoleQueryOperation {
  if (operation.method === 'select' && typeof operation.args[0] === 'string')
    return { ...operation, args: [cleanSelect(operation.args[0]), ...operation.args.slice(1)] }
  if (operation.method !== 'insert' && operation.method !== 'upsert')
    return operation
  const [body, rawOptions] = operation.args
  const options = { ...(rawOptions as Record<string, unknown> | undefined) }
  if (operation.method === 'upsert' && typeof options.onConflict !== 'string') {
    const key = catalog.primaryKeys.get(table)
    if (key?.length)
      options.onConflict = key.join(',')
  }
  if (!Array.isArray(body))
    return { method: operation.method, args: [body, options] }
  const keys = [...new Set(body.flatMap(row => Object.keys(row as Record<string, unknown>)))]
  const rows = body.map(row => Object.fromEntries(keys.map(key => [key, (row as Record<string, unknown>)[key] ?? null])))
  return { method: operation.method, args: [rows, options] }
}

function normalizeRequest(catalog: SqlCatalog, request: ConsoleQueryRequest): ConsoleQueryRequest {
  if (request.kind === 'rpc')
    return request
  return { ...request, operations: request.operations.map(operation => normalizeOperation(catalog, request.name, operation)) }
}

const ORDER_COLUMN = /^[a-z_][a-z0-9_]*$/

// PostgREST orders a set-returning RPC's rows before paging; the console
// compiler has no RPC ordering, so .order() is applied around its output.
function orderRpcRows(request: ConsoleQueryRequest, compile: (request: ConsoleQueryRequest) => CompiledConsoleQuery): CompiledConsoleQuery {
  // Table reads already compile .order() themselves.
  if (request.kind !== 'rpc')
    return compile(request)
  const orders = request.operations.filter(operation => operation.method === 'order')
  const compiled = compile({ ...request, operations: request.operations.filter(operation => operation.method !== 'order') })
  if (!orders.length)
    return compiled
  const terms = orders.map(({ args }) => {
    const [column, options] = args as [unknown, { ascending?: boolean, nullsFirst?: boolean } | undefined]
    if (typeof column !== 'string' || !ORDER_COLUMN.test(column))
      throw new ConsoleQueryError('PGRST100', 'Invalid order')
    const nulls = options?.nullsFirst === true ? ' NULLS FIRST' : options?.nullsFirst === false ? ' NULLS LAST' : ''
    return `q."${column}" ${options?.ascending === false ? 'DESC' : 'ASC'}${nulls}`
  })
  const page = ' AS q LIMIT '
  if (!compiled.returnsSet || compiled.text.split(page).length !== 2)
    throw new ConsoleQueryError('PGRST100', 'Ordering is only supported on functions returning rows')
  return { ...compiled, text: compiled.text.replace(page, ` AS q ORDER BY ${terms.join(', ')} LIMIT `) }
}

// Same SQLSTATE to HTTP status table as PostgREST.
function statusForSqlState(code: string, role: DbRole): number {
  if (code === '42501')
    return role === 'anon' ? 401 : 403
  if (code === '23503' || code === '23505')
    return 409
  if (code === '42883' || code === '42P01')
    return 404
  if (code === '25006')
    return 405
  if (code === 'P0001')
    return 400
  if (/^(08|53)/.test(code))
    return 503
  if (/^(0L|0P|28)/.test(code))
    return 403
  if (/^(09|25|2D|38|39|3B|40|54|55|57|58|F0|HV|P0|XX)/.test(code) || code === '42P17')
    return 500
  return 400
}

function statusTextFor(status: number): string {
  const texts: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable', 409: 'Conflict', 500: 'Internal Server Error', 503: 'Service Unavailable' }
  return texts[status] ?? ''
}

function successStatus(request: ConsoleQueryRequest, compiled: CompiledConsoleQuery): number {
  const write = request.kind === 'table' ? request.operations.find(operation => WRITE_METHODS.has(operation.method))?.method : undefined
  if (write === 'insert' || write === 'upsert')
    return 201
  if (compiled.minimal)
    return 204
  return 200
}

function toResponse(result: ConsoleQueryResult, status: number, hint: string | null = null): SqlResponse {
  const error = result.error
    ? new PostgrestError({ message: result.error.message, code: result.error.code, details: result.error.details as string, hint: hint as string })
    : null
  const finalStatus = result.error ? result.status : status
  return { data: result.data, error, count: result.count, status: finalStatus, statusText: statusTextFor(finalStatus) }
}

function sqlErrorResponse(error: unknown, role: DbRole): SqlResponse | null {
  const pgError = error as { code?: unknown, message?: unknown, detail?: unknown, hint?: unknown, severity?: unknown }
  if (typeof pgError?.code !== 'string' || typeof pgError.severity !== 'string')
    return null
  const status = statusForSqlState(pgError.code, role)
  const result: ConsoleQueryResult = {
    data: null,
    error: { message: String(pgError.message ?? ''), code: pgError.code, details: (pgError.detail as string | undefined) ?? null },
    count: null,
    status,
  }
  return toResponse(result, status, (pgError.hint as string | undefined) ?? null)
}

// PostgREST queues behind its own pool, so the caller never sees "too many connections".
async function connect(db: Pool): Promise<PoolClient> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.connect()
    }
    catch (error) {
      if ((error as { code?: string }).code !== '53300' || attempt >= CONNECT_ATTEMPTS)
        throw error
      const delay = Math.min(CONNECT_BACKOFF_MS * attempt, CONNECT_BACKOFF_MAX_MS) + Math.floor(Math.random() * CONNECT_BACKOFF_MS)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
}

async function runInTransaction(db: Pool, setup: string, compiled: CompiledConsoleQuery): Promise<ConsoleQueryResult> {
  const client = await connect(db)
  let open = false
  try {
    await client.query('BEGIN')
    open = true
    await client.query(setup)
    const { rows } = await client.query(compiled.text, compiled.values)
    const shaped = shapeConsoleQueryResult(compiled, rows)
    // PostgREST rolls back a write whose .single() / .maybeSingle() check failed.
    await client.query(shaped.error ? 'ROLLBACK' : 'COMMIT')
    open = false
    return shaped
  }
  finally {
    if (open)
      await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

// The compiler binds every value as $N::type. node-pg cannot send a JS object
// as a composite, so composite values (app_versions.manifest) go in as JSON and
// are rebuilt with jsonb_populate_record, the same way PostgREST reads a body.
const PARAM_CAST = /\$(\d+)::(_?)([a-z_][a-z0-9_]*)(?![\w[])/g

function bindComposites(catalog: SqlCatalog, compiled: CompiledConsoleQuery): CompiledConsoleQuery {
  const values = [...compiled.values]
  const text = compiled.text.replace(PARAM_CAST, (match, index: string, array: string, type: string) => {
    if (!catalog.compositeTypes.has(type))
      return match
    const position = Number(index) - 1
    values[position] = JSON.stringify(values[position])
    return array
      ? `ARRAY(SELECT jsonb_populate_record(NULL::public.${type}, e) FROM jsonb_array_elements($${index}::jsonb) AS e)`
      : `jsonb_populate_record(NULL::public.${type}, $${index}::jsonb)`
  })
  return { ...compiled, text, values }
}

// PostgREST's authenticator preloads pg-safeupdate: an UPDATE or DELETE without a filter fails.
function unfilteredWrite(request: ConsoleQueryRequest): ConsoleQueryResult | null {
  if (request.kind !== 'table')
    return null
  const verb = request.operations.find(operation => operation.method === 'update' || operation.method === 'delete')?.method
  if (!verb || request.operations.some(operation => FILTER_METHODS.has(operation.method)))
    return null
  const message = `${verb.toUpperCase()} requires a WHERE clause`
  return { data: null, error: { message, code: '21000', details: null }, count: null, status: 400 }
}

export async function executeDataRequest(request: ConsoleQueryRequest, identity: DbIdentity): Promise<SqlResponse> {
  const db = getPool()
  try {
    const catalog = await loadCatalog(db)
    const normalized = normalizeRequest(catalog, request)
    const refused = unfilteredWrite(normalized)
    if (refused)
      return toResponse(refused, refused.status)
    const compiled = bindComposites(catalog, orderRpcRows(normalized, next => compileConsoleQuery(catalog, next)))
    const result = await runInTransaction(db, setupSql(catalog, identity, normalized), compiled)
    // A void function answers 204 with no body; supabase-js reports data null.
    if (normalized.kind === 'rpc' && catalog.voidFunctions.has(normalized.name) && !result.error)
      return toResponse({ ...result, data: null }, 204)
    return toResponse(result, successStatus(normalized, compiled))
  }
  catch (error) {
    if (error instanceof ConsoleQueryError) {
      const result: ConsoleQueryResult = { data: null, error: { message: error.message, code: error.code, details: error.details }, count: null, status: error.status }
      return toResponse(result, error.status)
    }
    const response = sqlErrorResponse(error, identity.role)
    if (response)
      return response
    throw error
  }
}

// Bodies and filter values travel as JSON in a PostgREST request.
function asJson(values: unknown[]): unknown[] {
  return values.map(value => value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
}

function createBuilder(kind: ConsoleQueryRequest['kind'], name: string, args: unknown[], identity: () => Promise<DbIdentity>): any {
  const request: ConsoleQueryRequest = { kind, name, args: asJson(args), operations: [] }
  let execution: Promise<SqlResponse> | undefined
  const run = (): Promise<SqlResponse> => {
    execution ??= identity()
      .then(resolved => executeDataRequest(request, resolved), (error: unknown) => {
        if (error instanceof JwtRejectedError)
          return jwtRejectedResponse(error)
        throw error
      })
      .then((response) => {
        if (response.error && request.operations.some(operation => operation.method === 'throwOnError'))
          throw response.error
        return response
      })
    return execution
  }
  const builder: any = new Proxy({}, {
    get(_target, method: string | symbol) {
      if (typeof method === 'symbol')
        return undefined
      if (method === 'then' || method === 'catch' || method === 'finally') {
        const promise = run()
        return promise[method].bind(promise)
      }
      if (NO_OP_METHODS.has(method))
        return () => builder
      return (...operationArgs: unknown[]) => {
        const recorded = [...operationArgs]
        while (recorded.length && recorded[recorded.length - 1] === undefined)
          recorded.pop()
        request.operations.push({ method, args: asJson(recorded) })
        return builder
      }
    },
  })
  return builder
}

interface SqlDataClient {
  from: (table: string) => any
  rpc: (fn: string, args?: Record<string, unknown>, options?: Record<string, unknown>) => any
}

function createSqlDataClient(identity: () => Promise<DbIdentity> | DbIdentity): SqlDataClient {
  const resolve = async () => identity()
  return {
    from: (table: string) => createBuilder('table', table, [], resolve),
    rpc: (fn: string, args?: Record<string, unknown>) => createBuilder('rpc', fn, args === undefined ? [] : [args], resolve),
  }
}

function headerRecord(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object')
    return {}
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers as Record<string, unknown>)
  return Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase(), String(value)]))
}

/**
 * Wraps a supabase-js client: `from()` / `rpc()` run as SQL with the identity
 * PostgREST would have derived from the request (signed-in session, the
 * Authorization header, or the API key); everything else (`auth`, `storage`,
 * `functions`) is the original supabase-js client.
 */
function withSqlData<T extends SupabaseClient<any, any, any>>(client: T, apiKey: string, options: { global?: { headers?: unknown } } = {}): T {
  const globalHeaders = headerRecord(options.global?.headers)
  const identity = async (): Promise<DbIdentity> => {
    let token: string | undefined = globalHeaders.authorization?.replace(/^Bearer\s+/i, '')
    if (!token) {
      const { data } = await client.auth.getSession()
      token = data.session?.access_token
    }
    const headers: Record<string, string> = { apikey: apiKey, ...globalHeaders }
    if (token)
      headers.authorization = `Bearer ${token}`
    return identityFromToken(token ?? apiKey, headers)
  }
  const data = createSqlDataClient(identity)
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'from')
        return data.from
      if (property === 'rpc')
        return data.rpc
      if (property === 'schema')
        throw new Error('Tests must not query other schemas through PostgREST; use executeSQL')
      return Reflect.get(target, property, receiver)
    },
  })
}

/**
 * Drop-in for supabase-js `createClient` in tests: same signature and the same
 * client, except `from()` / `rpc()` run as SQL instead of going to PostgREST.
 */
export function createClient<Database = any>(url: string, key: string, options?: SupabaseClientOptions<any>): SupabaseClient<Database> {
  const client = createSupabaseClient<Database>(url, key, options as any)
  return withSqlData(client as SupabaseClient<any, any, any>, key, options as { global?: { headers?: unknown } }) as unknown as SupabaseClient<Database>
}
