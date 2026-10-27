import type { ConsoleQueryOperation, ConsoleQueryRequest, ConsoleQueryResult } from '../private/console_query_sql.ts'

// Reads a PostgREST HTTP request (what supabase-js sends to /rest/v1) into the
// recorded builder chain the SQL compiler runs, and shapes the result back into
// the PostgREST HTTP response. No I/O: the legacy CLI endpoint and the test
// helpers both use it.

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/
const RESERVED_PARAMS = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'])
const OBJECT_ACCEPT = 'application/vnd.pgrst.object+json'

export interface PostgrestHttpRequest {
  method: string
  url: URL
  header: (name: string) => string | null | undefined
  /** Raw request body text, if any. */
  body?: string | null
}

interface Prefer {
  return?: string
  count?: string
  resolution?: string
  missing?: string
}

export interface ParsedPostgrestRequest {
  kind: 'table' | 'rpc'
  name: string
  request: ConsoleQueryRequest
  method: string
  prefer: Prefer
  offset: number
}

export interface PostgrestHttpResponse {
  status: number
  headers: Record<string, string>
  /** JSON body, or undefined for an empty body. */
  body?: unknown
}

export class PostgrestHttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }

  response(): PostgrestHttpResponse {
    return { status: this.status, headers: {}, body: { code: this.code, details: null, hint: null, message: this.message } }
  }
}

function invalid(message: string): never {
  throw new PostgrestHttpError(400, 'PGRST100', message)
}

function parsePrefer(header: string | null | undefined): Prefer {
  const prefer: Prefer = {}
  for (const part of (header ?? '').split(',')) {
    const [key, value] = part.trim().split('=')
    if (key === 'return' || key === 'count' || key === 'resolution' || key === 'missing')
      prefer[key] = value
  }
  return prefer
}

// `col.desc.nullslast,other` → order('col', { ascending: false, nullsFirst: false }).
function orderOperations(value: string): ConsoleQueryOperation[] {
  return value.split(',').filter(Boolean).map((item) => {
    const [column, ...modifiers] = item.split('.')
    const options: Record<string, boolean> = { ascending: !modifiers.includes('desc') }
    if (modifiers.includes('nullsfirst'))
      options.nullsFirst = true
    if (modifiers.includes('nullslast'))
      options.nullsFirst = false
    return { method: 'order', args: [column, options] }
  })
}

// `eq.5` → ['eq', '5'], `not.in.(1,2)` → ['not.in', '(1,2)'].
function splitFilter(value: string): [string, string] {
  const negated = value.startsWith('not.')
  const rest = negated ? value.slice(4) : value
  const dot = rest.indexOf('.')
  if (dot <= 0)
    invalid('Invalid filter')
  return [`${negated ? 'not.' : ''}${rest.slice(0, dot)}`, rest.slice(dot + 1)]
}

function unwrapLogic(value: string): string {
  return value.startsWith('(') && value.endsWith(')') ? value.slice(1, -1) : value
}

function filterOperations(params: URLSearchParams): ConsoleQueryOperation[] {
  const operations: ConsoleQueryOperation[] = []
  for (const [key, value] of params) {
    if (RESERVED_PARAMS.has(key))
      continue
    if (key === 'or') {
      operations.push({ method: 'or', args: [unwrapLogic(value)] })
      continue
    }
    if (key === 'and' || key.endsWith('.or') || key.endsWith('.and') || key.endsWith('.order') || key.endsWith('.limit') || key.endsWith('.offset'))
      invalid('Unsupported filter')
    const [operator, operand] = splitFilter(value)
    operations.push({ method: 'filter', args: [key, operator, operand] })
  }
  return operations
}

function pageOperations(params: URLSearchParams, range?: string | null): ConsoleQueryOperation[] {
  const limit = params.get('limit')
  const offset = params.get('offset')
  if (limit === null && offset === null) {
    // `Range: 0-24` (Range-Unit: items) pages like limit/offset.
    const match = range ? /^(\d+)-(\d*)$/.exec(range.trim()) : null
    if (!match)
      return []
    const start = Number(match[1])
    return match[2] === ''
      ? [{ method: 'range', args: [start, start + 999] }]
      : [{ method: 'range', args: [start, Math.max(start, Number(match[2]))] }]
  }
  const size = limit === null ? null : Number(limit)
  const start = offset === null ? 0 : Number(offset)
  if ((size !== null && (!Number.isInteger(size) || size < 0)) || !Number.isInteger(start) || start < 0)
    invalid('Invalid limit or offset')
  if (size === null)
    return [{ method: 'range', args: [start, start + 999] }]
  if (start === 0)
    return [{ method: 'limit', args: [size] }]
  return [{ method: 'range', args: [start, start + size - 1] }]
}

function readBody(text: string | null | undefined): unknown {
  if (!text)
    return undefined
  try {
    return JSON.parse(text)
  }
  catch {
    invalid('Invalid JSON body')
  }
}

function countOption(prefer: Prefer) {
  return prefer.count === 'exact' || prefer.count === 'planned' || prefer.count === 'estimated' ? { count: prefer.count } : {}
}

function tableOperations(http: PostgrestHttpRequest, prefer: Prefer, single: boolean): ConsoleQueryOperation[] {
  const params = http.url.searchParams
  const method = http.method
  const operations: ConsoleQueryOperation[] = []
  const select = params.get('select')
  if (method === 'GET' || method === 'HEAD') {
    operations.push({ method: 'select', args: [select ?? '*', { ...countOption(prefer), head: method === 'HEAD' }] })
  }
  else if (method === 'POST') {
    const body = readBody(http.body)
    const options = { ...countOption(prefer), defaultToNull: prefer.missing !== 'default' }
    if (prefer.resolution === 'merge-duplicates' || prefer.resolution === 'ignore-duplicates') {
      operations.push({
        method: 'upsert',
        args: [body, { ...options, onConflict: params.get('on_conflict') ?? undefined, ignoreDuplicates: prefer.resolution === 'ignore-duplicates' }],
      })
    }
    else {
      operations.push({ method: 'insert', args: [body, options] })
    }
  }
  else if (method === 'PATCH') {
    operations.push({ method: 'update', args: [readBody(http.body), countOption(prefer)] })
  }
  else if (method === 'DELETE') {
    operations.push({ method: 'delete', args: [countOption(prefer)] })
  }
  else {
    invalid('Unsupported method')
  }
  if (method !== 'GET' && method !== 'HEAD' && prefer.return === 'representation')
    operations.push({ method: 'select', args: [select ?? '*'] })
  operations.push(...filterOperations(params))
  if (params.get('order'))
    operations.push(...orderOperations(params.get('order')!))
  operations.push(...pageOperations(params, http.header('range')))
  if (single)
    operations.push({ method: 'single', args: [] })
  return operations
}

function rpcArgs(http: PostgrestHttpRequest): Record<string, unknown> {
  if (http.method === 'POST') {
    const body = readBody(http.body)
    if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)))
      invalid('Invalid RPC arguments')
    return (body ?? {}) as Record<string, unknown>
  }
  if (http.method === 'GET' || http.method === 'HEAD') {
    const args: Record<string, unknown> = {}
    for (const [key, value] of http.url.searchParams) {
      if (!RESERVED_PARAMS.has(key))
        args[key] = value
    }
    return args
  }
  invalid('Unsupported method')
}

/** Parse `/rest/v1/<table>` or `/rest/v1/rpc/<fn>` (any prefix before /rest/v1). */
export function parsePostgrestRequest(http: PostgrestHttpRequest): ParsedPostgrestRequest {
  const marker = http.url.pathname.indexOf('/rest/v1/')
  if (marker === -1)
    throw new PostgrestHttpError(404, 'PGRST125', 'Invalid path specified in request URL')
  const resource = decodeURIComponent(http.url.pathname.slice(marker + '/rest/v1/'.length)).replace(/\/$/, '')
  const kind = resource.startsWith('rpc/') ? 'rpc' : 'table'
  const name = kind === 'rpc' ? resource.slice(4) : resource
  if (!IDENTIFIER.test(name))
    throw new PostgrestHttpError(404, 'PGRST125', 'Invalid path specified in request URL')
  const method = http.method.toUpperCase()
  const prefer = parsePrefer(http.header('prefer'))
  const single = (http.header('accept') ?? '').includes(OBJECT_ACCEPT)
  const normalized = { ...http, method }
  let request: ConsoleQueryRequest
  if (kind === 'rpc') {
    const select = http.url.searchParams.get('select')
    if (select && select !== '*')
      invalid('Unsupported RPC select')
    const operations: ConsoleQueryOperation[] = [...pageOperations(http.url.searchParams, http.header('range'))]
    if (single)
      operations.push({ method: 'single', args: [] })
    request = { kind, name, args: [rpcArgs(normalized)], operations }
  }
  else {
    request = { kind, name, args: [], operations: tableOperations(normalized, prefer, single) }
  }
  return { kind, name, request, method, prefer, offset: Number(http.url.searchParams.get('offset') ?? 0) }
}

function contentRange(result: ConsoleQueryResult, offset: number): string {
  const rows = Array.isArray(result.data) ? result.data.length : (result.data == null ? 0 : 1)
  const total = result.count ?? '*'
  return rows === 0 ? `*/${total}` : `${offset}-${offset + rows - 1}/${total}`
}

/** The HTTP response PostgREST sends for this result. */
export function postgrestResponse(parsed: ParsedPostgrestRequest, result: ConsoleQueryResult): PostgrestHttpResponse {
  if (result.error) {
    return {
      status: result.status,
      headers: {},
      body: { code: result.error.code, details: result.error.details ?? null, hint: result.error.hint ?? null, message: result.error.message },
    }
  }
  const { kind, method, prefer } = parsed
  const headers: Record<string, string> = {}
  if (kind === 'table' && (method === 'GET' || method === 'HEAD' || prefer.count))
    headers['Content-Range'] = contentRange(result, parsed.offset)
  if (method === 'HEAD')
    return { status: 200, headers }
  if (kind === 'table' && method !== 'GET' && prefer.return !== 'representation')
    return { status: method === 'POST' ? 201 : 204, headers }
  return { status: kind === 'table' && method === 'POST' ? 201 : 200, headers, body: result.data }
}
