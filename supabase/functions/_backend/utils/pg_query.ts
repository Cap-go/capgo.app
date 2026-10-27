import type { SQL } from 'drizzle-orm'
import type { ConsoleQueryRequest, ConsoleQueryResult, QueryCatalog, QueryColumn, QueryForeignKey, QueryFunction } from '../private/console_query_sql.ts'
import type { JWTClaims } from './hono.ts'
import type { PgQueryClient } from './pg.ts'
import { sql } from 'drizzle-orm'
import { escapeLiteral } from 'pg'
import { compileConsoleQuery, ConsoleQueryError, consoleQueryFailure, functionFromCatalogRow, shapeConsoleQueryResult } from '../private/console_query_sql.ts'
import { getDrizzleClient, transactionBeginSql } from './pg.ts'
import { readPgErrorField } from './pg_errors.ts'

// Runs a recorded PostgREST builder chain (from/rpc + modifiers) as SQL through
// Drizzle. This replaces PostgREST for the backend, the console and released CLIs:
// - service: the backend's own login role, like the service_role key. One statement.
// - authenticated / anon: the caller's Postgres role with its JWT claims and
//   request headers, so RLS and grants decide exactly as they did behind PostgREST.
// Reads stay on the primary. RLS calls auth.uid() and other functions that
// logical replicas do not have, and PostgREST also read the primary.
export type PgQuerySession
  = | { role: 'service', headers?: Record<string, string> }
    | { role: 'authenticated', claims: JWTClaims, headers?: Record<string, string> }
    | { role: 'anon', headers?: Record<string, string> }

interface FunctionRow {
  name: string
  returns_set: boolean
  arg_count: number
  arg_names: Array<string | null> | null
  arg_modes: string[] | null
  return_kind: string
  arg_types: string[] | null
  default_count: number | string | null
  out_columns?: Array<{ name: string, udt: string }> | null
}

export interface CatalogQueryRow {
  columns: Array<{ table_name: string, column_name: string, udt: string }> | null
  foreign_keys: QueryForeignKey[] | null
  primary_keys?: Array<{ table_name: string, columns: string[] | string }> | null
  functions?: FunctionRow[] | null
}

interface TableCatalog {
  columns: Map<string, QueryColumn[]>
  foreignKeys: QueryForeignKey[]
  primaryKeys: Map<string, string[]>
}

// One statement. A cold isolate pays one round trip, then the result stays in memory.
const TABLE_CATALOG_SQL = `
SELECT
  COALESCE((
    SELECT json_agg(json_build_object(
      'table_name', c.relname,
      'column_name', a.attname,
      'udt', t.typname
    ))
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'v')
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), '[]'::json) AS columns,
  COALESCE((
    SELECT json_agg(json_build_object(
      'name', con.conname,
      'sourceTable', src.relname,
      'sourceColumn', sa.attname,
      'targetTable', dst.relname,
      'targetColumn', da.attname,
      'unique', EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS uniq
        WHERE uniq.conrelid = con.conrelid
          AND uniq.contype IN ('u', 'p')
          AND uniq.conkey = con.conkey
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
    WHERE con.contype = 'f'
      AND sn.nspname = 'public'
      AND dn.nspname = 'public'
      AND cardinality(con.conkey) = 1
  ), '[]'::json) AS foreign_keys,
  COALESCE((
    SELECT json_agg(json_build_object(
      'table_name', c.relname,
      'columns', ARRAY(
        SELECT a.attname::text
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_catalog.pg_attribute AS a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
        ORDER BY k.ord
      )
    ))
    FROM pg_catalog.pg_constraint AS con
    JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE con.contype = 'p'
      AND n.nspname = 'public'
  ), '[]'::json) AS primary_keys
`

// Only the functions a request names. 500+ public functions would make every
// cold isolate download all of them; each RPC costs one lookup per isolate instead.
const FUNCTION_CATALOG_SQL = `
SELECT COALESCE((
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
    ),
    'out_columns', CASE
      WHEN ret.typtype = 'c' THEN (
        SELECT json_agg(json_build_object('name', a.attname, 'udt', t.typname) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_type AS t ON t.oid = a.atttypid
        WHERE a.attrelid = ret.typrelid AND a.attnum > 0 AND NOT a.attisdropped
      )
      WHEN p.proallargtypes IS NOT NULL THEN (
        SELECT json_agg(json_build_object('name', x.name, 'udt', t.typname) ORDER BY x.ord)
        FROM unnest(p.proallargtypes, p.proargmodes, p.proargnames) WITH ORDINALITY AS x(oid, mode, name, ord)
        JOIN pg_catalog.pg_type AS t ON t.oid = x.oid
        WHERE x.mode IN ('o', 't', 'b')
      )
    END
  ))
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_type AS ret ON ret.oid = p.prorettype
  WHERE n.nspname = 'public'
    AND p.proname = ANY($1::text[])
), '[]'::json) AS functions
`

let tableCatalogTask: Promise<TableCatalog> | null = null
const functionTasks = new Map<string, Promise<QueryFunction[]>>()

export function clearPgQueryCatalogCache() {
  tableCatalogTask = null
  functionTasks.clear()
}

function readTextList(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value))
    return value.map(String)
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}'))
    return value.slice(1, -1).split(',').filter(Boolean).map(item => item.replace(/^"|"$/g, ''))
  return []
}

export function catalogFromPayload(row: CatalogQueryRow): QueryCatalog {
  const columnMap = new Map<string, QueryColumn[]>()
  for (const column of row.columns ?? []) {
    const list = columnMap.get(column.table_name) ?? []
    list.push({ name: column.column_name, udt: column.udt })
    columnMap.set(column.table_name, list)
  }
  const primaryKeys = new Map<string, string[]>()
  for (const key of row.primary_keys ?? [])
    primaryKeys.set(key.table_name, readTextList(key.columns))
  const functions: QueryFunction[] = []
  for (const entry of row.functions ?? []) {
    const fn = functionFromCatalogRow(entry)
    if (fn)
      functions.push(fn)
  }
  return { columns: columnMap, foreignKeys: row.foreign_keys ?? [], primaryKeys, functions }
}

async function readTableCatalog(client: PgQueryClient): Promise<TableCatalog> {
  const result = await client.query<CatalogQueryRow>(TABLE_CATALOG_SQL)
  const row = result.rows[0]
  if (!row)
    throw new Error('table catalog query returned no row')
  const catalog = catalogFromPayload(row)
  return { columns: catalog.columns, foreignKeys: catalog.foreignKeys, primaryKeys: catalog.primaryKeys ?? new Map() }
}

function loadTableCatalog(client: PgQueryClient): Promise<TableCatalog> {
  // Schema changes show up after the next isolate. A failed read is not cached.
  if (!tableCatalogTask) {
    tableCatalogTask = readTableCatalog(client).catch((error: unknown) => {
      tableCatalogTask = null
      throw error
    })
  }
  return tableCatalogTask
}

function loadFunctions(client: PgQueryClient, name: string): Promise<QueryFunction[]> {
  let task = functionTasks.get(name)
  if (!task) {
    task = client.query<{ functions: FunctionRow[] | null }>(FUNCTION_CATALOG_SQL, [[name]])
      .then(result => (result.rows[0]?.functions ?? []).map(functionFromCatalogRow).filter((fn): fn is QueryFunction => fn !== null))
      .catch((error: unknown) => {
        functionTasks.delete(name)
        throw error
      })
    functionTasks.set(name, task)
  }
  return task
}

async function loadCatalog(client: PgQueryClient, request: ConsoleQueryRequest): Promise<QueryCatalog> {
  const tables = await loadTableCatalog(client)
  const functions = request.kind === 'rpc' ? await loadFunctions(client, request.name) : []
  return { columns: tables.columns, foreignKeys: tables.foreignKeys, primaryKeys: tables.primaryKeys, functions }
}

function bindValue(value: unknown): SQL {
  // sql`${array}` becomes a parenthesized list of parameters. `.in()` needs one array value.
  return Array.isArray(value) ? sql`${sql.param(value)}` : sql`${value}`
}

// Placeholders are $N outside quotes. A $N inside a literal or identifier
// (a JSON key "$1", or the characters $1 in a quoted label) is text.
export function drizzleFrom(text: string, values: unknown[]): SQL {
  const chunks: SQL[] = []
  let raw = ''
  const pushRaw = () => {
    if (!raw)
      return
    chunks.push(sql.raw(raw))
    raw = ''
  }
  const takeQuote = (quote: '\'' | '"', from: number): number => {
    raw += quote
    for (let index = from; index < text.length; index++) {
      raw += text[index]
      if (text[index] !== quote)
        continue
      if (text[index + 1] === quote) {
        raw += text[index + 1]
        index++
        continue
      }
      return index
    }
    return text.length - 1
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char === '\'' || char === '"') {
      index = takeQuote(char, index + 1)
      continue
    }
    if (char === '$') {
      const dollarQuote = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(index))
      if (dollarQuote) {
        const closer = dollarQuote[0]
        const end = text.indexOf(closer, index + closer.length)
        const stop = end === -1 ? text.length : end + closer.length
        raw += text.slice(index, stop)
        index = stop - 1
        continue
      }
      const placeholder = /^\$(\d+)/.exec(text.slice(index))
      if (placeholder) {
        pushRaw()
        chunks.push(bindValue(values[Number(placeholder[1]) - 1]))
        index += placeholder[0].length - 1
        continue
      }
    }
    raw += char
  }
  pushRaw()
  if (chunks.length === 1)
    return chunks[0]
  if (!chunks.length)
    return sql.raw('')
  return sql.join(chunks, sql.raw(''))
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result))
    return result as Array<Record<string, unknown>>
  if (result && typeof result === 'object' && 'rows' in result && Array.isArray((result as { rows: unknown }).rows))
    return (result as { rows: Array<Record<string, unknown>> }).rows
  return []
}

const NODE_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
])

function isInfrastructureSqlState(code: string): boolean {
  // Connection, capacity, and shutdown. A statement timeout (57014) stays a query result.
  return code.startsWith('08') || code.startsWith('53') || code === '57P01' || code === '57P02' || code === '57P03'
}

function isDriverQueryError(error: unknown, code: string): boolean {
  if (!/^[0-9A-Z]{5}$/.test(code))
    return false
  const severity = readPgErrorField(error, 'severity')
  if (typeof severity === 'string' && /^(?:ERROR|FATAL|PANIC|WARNING)$/i.test(severity))
    return true
  if (readPgErrorField(error, 'routine') !== undefined)
    return true
  return readPgErrorField(error, 'name') === 'DatabaseError'
}

function driverMessage(error: unknown): string {
  const message = readPgErrorField(error, 'message')
  if (typeof message === 'string' && message.length > 0 && !message.startsWith('Failed query:'))
    return message
  return 'Database error'
}

function driverText(error: unknown, field: 'detail' | 'hint'): string | null {
  const value = readPgErrorField(error, field)
  return typeof value === 'string' && value.length > 0 ? value : null
}

// Connection and node failures stay thrown so a read can retry. Only a driver
// SQLSTATE becomes the PostgREST-shaped body, and never the Drizzle wrapper text.
export function readSqlError(error: unknown): { code: string, message: string, details: string | null, hint: string | null } | null {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    const code = readPgErrorField(current, 'code')
    if (typeof code === 'string') {
      if (NODE_ERROR_CODES.has(code) || isInfrastructureSqlState(code))
        return null
      if (isDriverQueryError(current, code))
        return { code, message: driverMessage(current), details: driverText(current, 'detail'), hint: driverText(current, 'hint') }
    }
    current = readPgErrorField(current, 'cause')
  }
  return null
}

export function statusForSqlState(code: string, role: PgQuerySession['role']): number {
  // 42501 is "permission denied". An anonymous caller has no session (401).
  // A caller with a role does, so the same SQLSTATE is forbidden (403).
  if (code === '42501')
    return role === 'anon' ? 401 : 403
  if (code.startsWith('23'))
    return 409
  // PostgREST answers a raised exception (P0001) and a timeout (57014) like this too.
  return 400
}

// Thrown inside the transaction so it rolls the statement back.
// PostgREST does the same when .single() / .maybeSingle() rejects the row count:
// the caller sees the error and the mutation does not stay committed.
export class ConsoleQueryRollback extends Error {
  readonly result: ConsoleQueryResult

  constructor(result: ConsoleQueryResult) {
    super(result.error?.message ?? 'query failed')
    this.name = 'ConsoleQueryRollback'
    this.result = result
  }
}

export function finishConsoleQuery(result: ConsoleQueryResult): ConsoleQueryResult {
  if (result.error)
    throw new ConsoleQueryRollback(result)
  return result
}

// PostgREST applies the impersonated role's settings (anon 3s, authenticated 8s)
// on top of the authenticator login (8s statement and lock timeout).
const ROLE_STATEMENT_TIMEOUT = { anon: '3s', authenticated: '8s' } as const
const ROLE_LOCK_TIMEOUT = '8s'

// Claims are escaped literals in one simple query with BEGIN. A parameterized
// multi-statement query is rejected by Postgres. The role word is one of the
// two fixed roles, never a value from the token.
// A service request that carries headers (an API key resolving its own identity)
// sees them in request.headers, as service_role did behind PostgREST. No role switch.
export function serviceHeadersSetupSql(headers: Record<string, string>): string {
  return `SELECT
    pg_catalog.set_config('request.jwt.claims', ${escapeLiteral(JSON.stringify({ role: 'service_role' }))}, true),
    pg_catalog.set_config('request.jwt.claim.role', 'service_role', true),
    pg_catalog.set_config('request.headers', ${escapeLiteral(JSON.stringify(headers))}, true)`
}

export function consoleRoleSetupSql(session: Exclude<PgQuerySession, { role: 'service' }>): string {
  const claims = session.role === 'authenticated'
    ? { ...session.claims, sub: session.claims.sub, role: 'authenticated' }
    : { role: 'anon' }
  const role = session.role === 'anon' ? 'anon' : 'authenticated'
  const headers = session.headers ?? {}
  return `SELECT
    pg_catalog.set_config('request.jwt.claims', ${escapeLiteral(JSON.stringify(claims))}, true),
    pg_catalog.set_config('request.jwt.claim.sub', ${escapeLiteral(session.role === 'authenticated' ? session.claims.sub : '')}, true),
    pg_catalog.set_config('request.jwt.claim.role', ${escapeLiteral(role)}, true),
    pg_catalog.set_config('request.jwt.claim.email', ${escapeLiteral(session.role === 'authenticated' ? session.claims.email ?? '' : '')}, true),
    pg_catalog.set_config('request.jwt.claim.aal', ${escapeLiteral(session.role === 'authenticated' ? session.claims.aal ?? '' : '')}, true),
    pg_catalog.set_config('request.headers', ${escapeLiteral(JSON.stringify(headers))}, true);
SET LOCAL ROLE ${role};
SET LOCAL row_security = on;
SET LOCAL statement_timeout = '${ROLE_STATEMENT_TIMEOUT[role]}';
SET LOCAL lock_timeout = '${ROLE_LOCK_TIMEOUT}'`
}

async function executeCompiled(client: PgQueryClient, compiled: ReturnType<typeof compileConsoleQuery>, text = compiled.text): Promise<ConsoleQueryResult> {
  // Filters carry emails, API keys and search text. Keep them out of the query log.
  const db = getDrizzleClient(client, { logger: false })
  const result = await db.execute(drizzleFrom(text, compiled.values))
  return shapeConsoleQueryResult(compiled, rowsOf(result))
}

function isWrite(request: ConsoleQueryRequest): boolean {
  return request.kind === 'table' && request.operations.some(operation => operation.method === 'insert' || operation.method === 'update' || operation.method === 'upsert' || operation.method === 'delete')
}

function sqlFailure(sqlError: NonNullable<ReturnType<typeof readSqlError>>, role: PgQuerySession['role']): ConsoleQueryResult {
  return {
    data: null,
    error: { message: sqlError.message, code: sqlError.code, details: sqlError.details, hint: sqlError.hint },
    count: null,
    status: statusForSqlState(sqlError.code, role),
  }
}

// PostgREST ran service_role on the authenticator login, which carries an 8s
// statement and lock timeout. The backend login has none, so a query stuck
// behind a lock would hold its Hyperdrive origin connection indefinitely.
const SERVICE_TIMEOUTS_SQL = `SET LOCAL statement_timeout = '8s'; SET LOCAL lock_timeout = '${ROLE_LOCK_TIMEOUT}'`

async function inTransaction(client: PgQueryClient, appendSql: string | undefined, run: () => Promise<ConsoleQueryResult>, options: { readOnly?: boolean } = {}): Promise<ConsoleQueryResult> {
  try {
    await client.query(transactionBeginSql('read write', appendSql))
    const result = finishConsoleQuery(await run())
    if (options.readOnly) {
      // A read has its rows already. The COMMIT is queued on this connection
      // ahead of anything its next user sends, so the caller skips that round trip.
      client.query('COMMIT').catch(() => {})
      return result
    }
    await client.query('COMMIT')
    return result
  }
  catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  }
}

export interface PgQueryRunOptions {
  /** Called once with the SQLSTATE when a query fails inside Postgres. */
  onSqlError?: (code: string) => void
}

/**
 * Execute one recorded builder chain on a checked-out connection.
 *
 * Round trips on a warm isolate, the caller waits for:
 * - service table read: 2 (BEGIN + timeouts, statement; COMMIT is not awaited)
 * - service RPC / write: 3 (BEGIN + timeouts, statement, COMMIT)
 * - authenticated / anon: 3 (BEGIN + role setup, statement, COMMIT)
 */
export async function runPgQuery(client: PgQueryClient, request: ConsoleQueryRequest, session: PgQuerySession, options: PgQueryRunOptions = {}): Promise<ConsoleQueryResult> {
  try {
    // The catalog read must run as the login role, before SET LOCAL ROLE.
    // A warm isolate already has it and pays no round trip.
    const catalog = await loadCatalog(client, request)
    const compiled = compileConsoleQuery(catalog, request)
    if (session.role === 'service') {
      // Every service statement runs with PostgREST's timeouts, set on the BEGIN
      // round trip. A row-count check after a write rolls the write back, as
      // PostgREST does. Inside a transaction Hyperdrive never serves a cached read.
      const headers = session.headers && Object.keys(session.headers).length ? `${serviceHeadersSetupSql(session.headers)}; ` : ''
      const readOnly = !isWrite(request) && request.kind === 'table'
      return await inTransaction(client, `${headers}${SERVICE_TIMEOUTS_SQL}`, () => executeCompiled(client, compiled), { readOnly })
    }
    return await inTransaction(client, consoleRoleSetupSql(session), () => executeCompiled(client, compiled))
  }
  catch (error) {
    if (error instanceof ConsoleQueryRollback)
      return error.result
    if (error instanceof ConsoleQueryError)
      return consoleQueryFailure(error)
    const sqlError = readSqlError(error)
    if (!sqlError)
      throw error
    options.onSqlError?.(sqlError.code)
    return sqlFailure(sqlError, session.role)
  }
}
