import type { ConsoleQueryOperation, ConsoleQueryRequest } from '../supabase/functions/_backend/private/console_query_sql.ts'
import type { SqlResponse } from './sql-data-client'
import { executeDataRequest, identityFromToken, JwtRejectedError, jwtRejectedResponse } from './sql-data-client'

/**
 * For tests that assert on raw HTTP responses (status, JSON body) of table and
 * RPC requests. Takes the request a test used to send to PostgREST, minus the
 * `/rest/v1/` prefix (`'apps?select=id&app_id=eq.x'`, `'rpc/fn'`), and answers
 * with a `Response` built from the SQL data client. No request leaves the test.
 */
interface SqlRestInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}

type Prefer = Record<string, string>

function lowerHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
}

function parsePrefer(value: string | undefined): Prefer {
  const prefer: Prefer = {}
  for (const part of (value ?? '').split(',')) {
    const [key, setting] = part.trim().split('=')
    if (key && setting)
      prefer[key] = setting
  }
  return prefer
}

function orderOperations(value: string): ConsoleQueryOperation[] {
  return value.split(',').map((item) => {
    const [column, ...modifiers] = item.trim().split('.')
    const options: Record<string, unknown> = { ascending: !modifiers.includes('desc') }
    if (modifiers.includes('nullsfirst'))
      options.nullsFirst = true
    if (modifiers.includes('nullslast'))
      options.nullsFirst = false
    return { method: 'order', args: [column, options] }
  })
}

function filterOperation(column: string, value: string): ConsoleQueryOperation {
  if (column === 'or')
    return { method: 'or', args: [value.replace(/^\(/, '').replace(/\)$/, '')] }
  const negate = value.startsWith('not.')
  const rest = negate ? value.slice(4) : value
  const dot = rest.indexOf('.')
  const operator = rest.slice(0, dot)
  return { method: 'filter', args: [column, negate ? `not.${operator}` : operator, rest.slice(dot + 1)] }
}

const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])

// A `Range: 0-9` request header pages like limit/offset.
function rangeHeader(value: string | undefined): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(value?.trim() ?? '')
  return match ? [Number(match[1]), Number(match[2])] : null
}

function tableRequest(name: string, method: string, query: URLSearchParams, prefer: Prefer, body: unknown, single: boolean, range: [number, number] | null): ConsoleQueryRequest {
  const operations: ConsoleQueryOperation[] = []
  const countOptions = prefer.count ? { count: prefer.count } : {}
  const isWrite = method !== 'GET' && method !== 'HEAD'
  const wantsRows = !isWrite || prefer.return === 'representation'
  if (wantsRows || method === 'HEAD')
    operations.push({ method: 'select', args: [query.get('select') ?? '*', { ...countOptions, ...(method === 'HEAD' ? { head: true } : {}) }] })
  if (method === 'POST') {
    const upsert = prefer.resolution === 'merge-duplicates' || prefer.resolution === 'ignore-duplicates'
    const options: Record<string, unknown> = {}
    if (query.get('on_conflict'))
      options.onConflict = query.get('on_conflict')
    if (prefer.resolution === 'ignore-duplicates')
      options.ignoreDuplicates = true
    operations.push({ method: upsert ? 'upsert' : 'insert', args: [body, options] })
  }
  else if (method === 'PATCH') {
    operations.push({ method: 'update', args: [body] })
  }
  else if (method === 'DELETE') {
    operations.push({ method: 'delete', args: [] })
  }
  for (const [key, value] of query.entries()) {
    if (!RESERVED_PARAMS.has(key))
      operations.push(filterOperation(key, value))
  }
  if (query.get('order'))
    operations.push(...orderOperations(query.get('order')!))
  const limit = query.get('limit')
  const offset = Number(query.get('offset') ?? 0)
  if (limit !== null && Number(limit) === 0)
    operations.push({ method: 'limit', args: [0] })
  else if (limit !== null)
    operations.push({ method: 'range', args: [offset, offset + Number(limit) - 1] })
  else if (range)
    operations.push({ method: 'range', args: range })
  else if (offset > 0)
    operations.push({ method: 'range', args: [offset, offset + 999] })
  if (single)
    operations.push({ method: 'single', args: [] })
  return { kind: 'table', name, args: [], operations }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal)
    return promise
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('This operation was aborted', 'AbortError'))
    if (signal.aborted)
      return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

async function execute(request: ConsoleQueryRequest, token: string, headers: Record<string, string>): Promise<SqlResponse> {
  try {
    return await executeDataRequest(request, identityFromToken(token, headers))
  }
  catch (error) {
    if (error instanceof JwtRejectedError)
      return jwtRejectedResponse(error)
    throw error
  }
}

export async function sqlRestRequest(path: string, init: SqlRestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const headers = lowerHeaders(init.headers)
  const url = new URL(path.replace(/^\//, ''), 'http://sql.local/')
  const name = url.pathname.slice(1)
  const prefer = parsePrefer(headers.prefer)
  const single = (headers.accept ?? '').includes('application/vnd.pgrst.object+json')
  const body = init.body ? JSON.parse(init.body) : undefined
  const token = headers.authorization?.replace(/^Bearer\s+/i, '') || headers.apikey
  if (!token)
    throw new Error('sqlRestRequest needs an apikey or Authorization header')
  const request: ConsoleQueryRequest = name.startsWith('rpc/')
    ? { kind: 'rpc', name: name.slice(4), args: body === undefined ? [] : [body], operations: single ? [{ method: 'single', args: [] }] : [] }
    : tableRequest(name, method, url.searchParams, prefer, body, single, rangeHeader(headers.range))
  const result = await withAbort(execute(request, token, headers), init.signal)

  const responseHeaders = new Headers({ 'content-type': 'application/json; charset=utf-8' })
  if (result.count !== null)
    responseHeaders.set('content-range', `*/${result.count}`)
  if (result.error) {
    const { code, details, hint, message } = result.error
    return new Response(JSON.stringify({ code, details, hint, message }), { status: result.status, headers: responseHeaders })
  }
  if (result.status === 204 || method === 'HEAD' || (request.kind === 'table' && method !== 'GET' && prefer.return !== 'representation'))
    return new Response(null, { status: result.status === 200 && method !== 'HEAD' ? 204 : result.status, headers: responseHeaders })
  return new Response(JSON.stringify(result.data), { status: result.status, headers: responseHeaders })
}
