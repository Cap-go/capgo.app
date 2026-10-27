import type { SupabaseClient } from '@supabase/supabase-js'
import type { Context } from 'hono'
import type { ConsoleQueryRequest, ConsoleQueryResult } from '../private/console_query_sql.ts'
import type { PgClient, PgQueryClient } from './pg.ts'
import type { PgQueryRunOptions, PgQuerySession } from './pg_query.ts'
import type { Database } from './supabase.types.ts'
import { getRuntimeKey } from 'hono/adapter'
import { cloudlogErr } from './logging.ts'
import { closeClient, getPgClient, getSharedPgPool, isHyperdrivePgClient } from './pg.ts'
import { runPgQuery } from './pg_query.ts'
import { onRequestFinished } from './request_lifecycle.ts'
import { backgroundTask } from './utils.ts'

/**
 * The backend's database client: the supabase-js `from` / `rpc` builder, with the
 * same types and result shape, executed in-process as SQL through Drizzle.
 * Nothing here talks to PostgREST.
 */
export type CapgoDb<T = Database> = Pick<SupabaseClient<T>, 'from' | 'rpc'>

export type DbSessionSource = PgQuerySession | (() => Promise<PgQuerySession | DbQueryFailure>)

export interface DbQueryFailure {
  failure: ConsoleQueryResult
}

// ---------------------------------------------------------------------------
// Connections
//
// PostgREST kept warm connections behind one HTTP keep-alive. Opening a new
// connection per query would be slower, so:
// - Deno / Node (Supabase edge runtime, tests): one bounded pool per isolate,
//   shared across requests, like PostgREST's pool (utils/pg.ts getSharedPgPool).
// - Hyperdrive (Workers): a request reuses the Clients it connected through an
//   idle list. Hyperdrive owns their cleanup when the request ends.
// - Workers without Hyperdrive (local Workers tests): one Pool per request,
//   ended once the request finished and no query is running. Background tasks
//   that query after that get a fresh pool that ends after their last query.
// ---------------------------------------------------------------------------

interface RequestConnections {
  first: Promise<PgClient> | null
  firstClaimed: boolean
  pool: PgClient | null
  idle: PgQueryClient[]
  active: number
  finished: boolean
}

interface Lease {
  client: PgQueryClient
  shared: boolean
  /** Checked out of the isolate pool; only released, never tracked per request. */
  pooled?: boolean
}

const REQUEST_POOL_IDLE_MS = 5000
const connections = new WeakMap<object, RequestConnections>()
const finishedRequests = new WeakSet<object>()

function connectionsFor(c: Context): RequestConnections {
  let entry = connections.get(c)
  if (!entry) {
    entry = { first: null, firstClaimed: false, pool: null, idle: [], active: 0, finished: finishedRequests.has(c) }
    connections.set(c, entry)
  }
  return entry
}

async function acquire(c: Context): Promise<Lease> {
  if (getRuntimeKey() !== 'workerd')
    return { client: await getSharedPgPool(c).connect(), shared: false, pooled: true }
  const entry = connectionsFor(c)
  entry.active++
  try {
    if (entry.pool)
      return { client: await (entry.pool as unknown as { connect: () => Promise<PgQueryClient> }).connect(), shared: false }
    const idle = entry.idle.pop()
    if (idle)
      return { client: idle, shared: true }
    if (!entry.first)
      entry.first = getPgClient(c, false, { idleTimeoutMillis: REQUEST_POOL_IDLE_MS })
    const first = await entry.first.catch((error: unknown) => {
      entry.first = null
      throw error
    })
    if (!isHyperdrivePgClient(first)) {
      entry.pool = first
      return { client: await (first as unknown as { connect: () => Promise<PgQueryClient> }).connect(), shared: false }
    }
    if (!entry.firstClaimed) {
      entry.firstClaimed = true
      return { client: first, shared: true }
    }
    // A concurrent query in the same request needs its own Hyperdrive connection.
    return { client: await getPgClient(c, false) as PgQueryClient, shared: true }
  }
  catch (error) {
    entry.active--
    endWhenIdle(c, entry)
    throw error
  }
}

function release(c: Context, lease: Lease, error?: unknown) {
  if (lease.pooled) {
    (lease.client as { release: (error?: Error | boolean) => void }).release(error instanceof Error ? error : undefined)
    return
  }
  const entry = connectionsFor(c)
  entry.active--
  if (lease.shared) {
    // A Hyperdrive Client that failed mid-query may be broken; let it go.
    if (!error)
      entry.idle.push(lease.client)
  }
  else if ('release' in lease.client && typeof lease.client.release === 'function') {
    lease.client.release(error instanceof Error ? error : undefined)
  }
  endWhenIdle(c, entry)
}

function endWhenIdle(c: Context, entry: RequestConnections) {
  if (!entry.finished || entry.active > 0 || !entry.pool)
    return
  const pool = entry.pool
  connections.delete(c)
  void closeClient(c, pool)
}

/** Runs once createHono has the response. Ends the request pool when idle. */
function finishRequestDb(c: Context) {
  finishedRequests.add(c)
  const entry = connections.get(c)
  if (!entry)
    return
  entry.finished = true
  endWhenIdle(c, entry)
}

onRequestFinished(finishRequestDb)

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function isRead(request: ConsoleQueryRequest) {
  return request.kind === 'table' && !request.operations.some(operation => operation.method === 'insert' || operation.method === 'update' || operation.method === 'upsert' || operation.method === 'delete')
}

function unavailable(error: unknown): ConsoleQueryResult {
  // What PostgREST answers when it cannot reach the database.
  return {
    data: null,
    error: { message: error instanceof Error ? error.message : 'Database connection error', code: 'PGRST000', details: null, hint: null },
    count: null,
    status: 503,
  }
}

/**
 * Run one builder chain. Never throws for a database or connection problem:
 * like supabase-js, the problem is returned as `error`.
 */
export async function runDbQuery(c: Context, request: ConsoleQueryRequest, session: PgQuerySession): Promise<ConsoleQueryResult> {
  // A service read returns before its COMMIT answers; the connection is only
  // reused once it has, and the request stays alive until then (waitUntil).
  let commit: Promise<unknown> | undefined
  const options: PgQueryRunOptions = {
    onSqlError: code => cloudlogErr({ requestId: c.get('requestId'), message: 'db query failed', kind: request.kind, name: request.name, code }),
    deferCommit: (pending) => {
      commit = pending
    },
  }
  // A read that lost its connection is safe to send once more on a new one.
  const attempts = isRead(request) ? 2 : 1
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    let lease: Lease
    try {
      lease = await acquire(c)
    }
    catch (error) {
      lastError = error
      continue
    }
    let failed: unknown
    try {
      return await runPgQuery(lease.client, request, session, options)
    }
    catch (error) {
      failed = error
      lastError = error
    }
    finally {
      const pending = commit
      commit = undefined
      if (pending && !failed) {
        backgroundTask(c, pending.then(
          () => release(c, lease),
          (error: unknown) => release(c, lease, error instanceof Error ? error : new Error(String(error))),
        ))
      }
      else {
        release(c, lease, failed)
      }
    }
  }
  cloudlogErr({ requestId: c.get('requestId'), message: 'db query connection failed', kind: request.kind, name: request.name, error: lastError })
  return unavailable(lastError)
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Same fields and JSON shape as supabase-js `PostgrestError`. */
export class DbQueryError extends Error {
  readonly code: string
  readonly details: string | null
  readonly hint: string | null

  constructor(failure: NonNullable<ConsoleQueryResult['error']>) {
    super(failure.message)
    this.name = 'PostgrestError'
    this.code = failure.code
    this.details = failure.details ?? null
    this.hint = failure.hint ?? null
  }

  toJSON() {
    return { name: this.name, message: this.message, details: this.details, hint: this.hint, code: this.code }
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  406: 'Not Acceptable',
  409: 'Conflict',
  503: 'Service Unavailable',
}

// Type-only or transport-only modifiers. They change nothing about the SQL.
const PASSTHROUGH = new Set(['returns', 'overrideTypes', 'abortSignal', 'setHeader'])
const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])

// The arguments supabase-js would have put on the wire: JSON drops undefined
// keys and turns a Date into its ISO string. Trailing undefined arguments are
// SDK defaults, not values.
function wire(args: unknown[]): unknown[] {
  const list = [...args]
  while (list.length && list[list.length - 1] === undefined)
    list.pop()
  return list.length ? JSON.parse(JSON.stringify(list)) as unknown[] : []
}

function successStatus(request: ConsoleQueryRequest, result: ConsoleQueryResult): number {
  if (request.kind !== 'table')
    return result.status
  const write = request.operations.find(operation => WRITES.has(operation.method))?.method
  if (write === 'insert' || write === 'upsert')
    return 201
  if (write && result.data === null && result.count === null)
    return 204
  return result.status
}

export type DbQueryRunner = (request: ConsoleQueryRequest) => Promise<ConsoleQueryResult>

async function execute(run: DbQueryRunner, request: ConsoleQueryRequest) {
  const result = await run(request)
  const error = result.error ? new DbQueryError(result.error) : null
  if (error && request.operations.some(operation => operation.method === 'throwOnError'))
    throw error
  const status = error ? result.status : successStatus(request, result)
  return { data: error ? null : result.data, error, count: result.count, status, statusText: STATUS_TEXT[status] ?? '' }
}

function record(run: DbQueryRunner, kind: ConsoleQueryRequest['kind'], name: string, args: unknown[]) {
  const request: ConsoleQueryRequest = { kind, name, args: wire(args), operations: [] }
  const builder: any = new Proxy({}, {
    get(_target, method) {
      if (typeof method !== 'string')
        return undefined
      if (method === 'then') {
        // Like supabase-js, the request is sent when then() is called (each
        // await), not when the property is read, and every await sends it
        // again, so a retry loop can re-await the same builder.
        return (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => execute(run, request).then(onFulfilled, onRejected)
      }
      if (PASSTHROUGH.has(method))
        return () => builder
      return (...operationArgs: unknown[]) => {
        request.operations.push({ method, args: wire(operationArgs) })
        return builder
      }
    },
  })
  return builder
}

/** The supabase-js builder over any runner. Tests use it with their own connection. */
export function createDbClient(run: DbQueryRunner): CapgoDb {
  return {
    from: ((name: string) => record(run, 'table', name, [])) as CapgoDb['from'],
    rpc: ((name: string, ...args: unknown[]) => record(run, 'rpc', name, args)) as CapgoDb['rpc'],
  }
}

export function createDb(c: Context, source: DbSessionSource): CapgoDb {
  return createDbClient(async (request) => {
    const session = typeof source === 'function' ? await source() : source
    return 'failure' in session ? session.failure : runDbQuery(c, request, session)
  })
}

function jwtFailure(message: string): DbQueryFailure {
  return { failure: { data: null, error: { message, code: 'PGRST301', details: null, hint: null }, count: null, status: 401 } }
}

/** The session PostgREST would have built from this bearer token. Verified first. */
export function jwtSession(c: Context, authorization: string): () => Promise<PgQuerySession | DbQueryFailure> {
  let task: Promise<PgQuerySession | DbQueryFailure> | undefined
  return () => {
    // Loaded on first use: hono_jwt pulls in the Hono middleware factory, which
    // every module importing utils/supabase.ts would otherwise load eagerly.
    task ??= import('./hono_jwt.ts').then(({ getClaimsFromJWT }) => getClaimsFromJWT(c, authorization)).then((claims): PgQuerySession | DbQueryFailure => {
      if (!claims)
        return jwtFailure('JWT could not be verified')
      if (claims.role === 'service_role')
        return { role: 'service' }
      if (claims.role === 'anon' || !claims.sub)
        return { role: 'anon' }
      return { role: 'authenticated', claims }
    })
    return task
  }
}
