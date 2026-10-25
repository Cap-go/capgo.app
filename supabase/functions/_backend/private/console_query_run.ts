import type { SQL } from 'drizzle-orm'
import type { Context } from 'hono'
import type { JWTClaims } from '../utils/hono.ts'
import type { PgQueryClient } from '../utils/pg.ts'
import type { ConsoleQueryRequest, ConsoleQueryResult, QueryCatalog, QueryColumn, QueryForeignKey, QueryFunction } from './console_query_sql.ts'
import { sql } from 'drizzle-orm'
import { escapeLiteral } from 'pg'
import { CONSOLE_RPCS } from '../utils/console_query_allowlist.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, withPgTransaction } from '../utils/pg.ts'
import { readPgErrorField } from '../utils/pg_errors.ts'
import { compileConsoleQuery, ConsoleQueryError, consoleQueryFailure, functionFromCatalogRow, shapeConsoleQueryResult } from './console_query_sql.ts'

// Console reads and writes stay on the primary. RLS calls auth.uid() and other
// functions that logical replicas do not have.
export type ConsoleQuerySession = { role: 'authenticated', claims: JWTClaims } | { role: 'anon' }

interface FunctionRow {
  name: string
  returns_set: boolean
  arg_count: number
  arg_names: Array<string | null> | null
  arg_modes: string[] | null
  return_kind: string
  arg_types: string[] | null
  default_count: number | string | null
}

let catalogTask: Promise<QueryCatalog> | null = null

export function clearConsoleQueryCatalogCache() {
  catalogTask = null
}

interface CatalogQueryRow {
  columns: Array<{ table_name: string, column_name: string, udt: string }> | null
  foreign_keys: QueryForeignKey[] | null
  functions: FunctionRow[] | null
}

// One statement. A cold isolate pays one round trip, then the result stays in memory.
const CATALOG_SQL = `
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
    WHERE n.nspname = 'public'
      AND p.proname = ANY($1::text[])
  ), '[]'::json) AS functions
`

export function catalogFromPayload(row: CatalogQueryRow): QueryCatalog {
  const columnMap = new Map<string, QueryColumn[]>()
  for (const column of row.columns ?? []) {
    const list = columnMap.get(column.table_name) ?? []
    list.push({ name: column.column_name, udt: column.udt })
    columnMap.set(column.table_name, list)
  }
  const functions: QueryFunction[] = []
  for (const entry of row.functions ?? []) {
    const fn = functionFromCatalogRow(entry)
    if (fn)
      functions.push(fn)
  }
  return { columns: columnMap, foreignKeys: row.foreign_keys ?? [], functions }
}

async function readCatalog(client: PgQueryClient): Promise<QueryCatalog> {
  const result = await client.query<CatalogQueryRow>(CATALOG_SQL, [[...CONSOLE_RPCS]])
  const row = result.rows[0]
  if (!row)
    throw new Error('console catalog query returned no row')
  return catalogFromPayload(row)
}

function loadCatalog(client: PgQueryClient): Promise<QueryCatalog> {
  // Schema changes show up after the next isolate. A failed read is not cached.
  if (!catalogTask) {
    catalogTask = readCatalog(client).catch((error: unknown) => {
      catalogTask = null
      throw error
    })
  }
  return catalogTask
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

// Connection and node failures stay thrown so a read can retry. Only a driver
// SQLSTATE becomes the PostgREST-shaped body, and never the Drizzle wrapper text.
export function readSqlError(error: unknown): { code: string, message: string } | null {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    const code = readPgErrorField(current, 'code')
    if (typeof code === 'string') {
      if (NODE_ERROR_CODES.has(code) || isInfrastructureSqlState(code))
        return null
      if (isDriverQueryError(current, code))
        return { code, message: driverMessage(current) }
    }
    current = readPgErrorField(current, 'cause')
  }
  return null
}

export function statusForSqlState(code: string, role: ConsoleQuerySession['role']): number {
  // 42501 is "permission denied". An anonymous caller has no session (401).
  // An authenticated caller does, so the same SQLSTATE is forbidden (403).
  if (code === '42501')
    return role === 'authenticated' ? 403 : 401
  if (code.startsWith('23'))
    return 409
  return 400
}

// Thrown inside the transaction so withPgTransaction rolls the statement back.
// PostgREST does the same when .single() / .maybeSingle() rejects the row count:
// the caller sees the error and the mutation does not stay committed.
export class ConsoleQueryRollback extends Error {
  readonly result: ConsoleQueryResult

  constructor(result: ConsoleQueryResult) {
    super(result.error?.message ?? 'console query failed')
    this.name = 'ConsoleQueryRollback'
    this.result = result
  }
}

export function finishConsoleQuery(result: ConsoleQueryResult): ConsoleQueryResult {
  if (result.error)
    throw new ConsoleQueryRollback(result)
  return result
}

// Claims are escaped literals in one simple query with BEGIN. A parameterized
// multi-statement query is rejected by Postgres. The role word is one of the
// two fixed roles, never a value from the token.
export function consoleRoleSetupSql(session: ConsoleQuerySession): string {
  const claims = session.role === 'authenticated'
    ? { ...session.claims, sub: session.claims.sub, role: 'authenticated' }
    : { role: 'anon' }
  const role = session.role === 'anon' ? 'anon' : 'authenticated'
  return `SELECT
    pg_catalog.set_config('request.jwt.claims', ${escapeLiteral(JSON.stringify(claims))}, true),
    pg_catalog.set_config('request.jwt.claim.sub', ${escapeLiteral(session.role === 'authenticated' ? session.claims.sub : '')}, true),
    pg_catalog.set_config('request.jwt.claim.role', ${escapeLiteral(role)}, true),
    pg_catalog.set_config('request.jwt.claim.email', ${escapeLiteral(session.role === 'authenticated' ? session.claims.email ?? '' : '')}, true),
    pg_catalog.set_config('request.jwt.claim.aal', ${escapeLiteral(session.role === 'authenticated' ? session.claims.aal ?? '' : '')}, true),
    pg_catalog.set_config('request.headers', ${escapeLiteral('{}')}, true);
SET LOCAL ROLE ${role};
SET LOCAL row_security = on`
}

async function executeCompiled(client: PgQueryClient, compiled: ReturnType<typeof compileConsoleQuery>): Promise<ConsoleQueryResult> {
  // Filters carry emails and search text. Keep them out of the query log.
  const db = getDrizzleClient(client, { logger: false })
  const result = await db.execute(drizzleFrom(compiled.text, compiled.values))
  return finishConsoleQuery(shapeConsoleQueryResult(compiled, rowsOf(result)))
}

export async function runConsoleQuery(c: Context, request: ConsoleQueryRequest, session: ConsoleQuerySession): Promise<ConsoleQueryResult> {
  const pool = await getPgClient(c, false)
  // Hosted Supabase does not make the postgres login a superuser, and
  // SET SESSION AUTHORIZATION requires one. SET LOCAL ROLE is the switch this
  // database already allows: it changes current_user and drops BYPASSRLS.
  // session_user stays the login role. The request role GUC above is what
  // user-facing checks must read. Fail closed if the role cannot be assumed.
  const setupSql = consoleRoleSetupSql(session)
  try {
    // The catalog read must run as the login role, before SET LOCAL ROLE.
    // A warm isolate already has it, so the role switch shares the BEGIN round trip.
    if (catalogTask) {
      const compiled = compileConsoleQuery(await catalogTask, request)
      return await withPgTransaction(pool, client => executeCompiled(client, compiled), { appendSql: setupSql })
    }
    return await withPgTransaction(pool, async (client) => {
      const compiled = compileConsoleQuery(await loadCatalog(client), request)
      await client.query(setupSql)
      return executeCompiled(client, compiled)
    })
  }
  catch (error) {
    if (error instanceof ConsoleQueryRollback)
      return error.result
    if (error instanceof ConsoleQueryError)
      return consoleQueryFailure(error)
    const sqlError = readSqlError(error)
    if (!sqlError)
      throw error
    cloudlogErr({ requestId: c.get('requestId'), message: 'console query failed', code: sqlError.code })
    return {
      data: null,
      error: { message: sqlError.message, code: sqlError.code, details: null },
      count: null,
      status: statusForSqlState(sqlError.code, session.role),
    }
  }
  finally {
    await closeClient(c, pool)
  }
}
