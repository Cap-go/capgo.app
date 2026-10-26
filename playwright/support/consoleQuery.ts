import type { Page, Request, Response, Route } from '@playwright/test'

/**
 * The console sends every table/RPC read and write to POST /private/console/query
 * as a recorded PostgREST builder chain. These helpers let specs intercept and
 * inspect those requests the way they used to intercept `/rest/v1/*` URLs.
 */
export interface ConsoleQuery {
  kind: 'table' | 'rpc'
  name: string
  args: unknown[]
  operations: { method: string, args: any[] }[]
}

export const CONSOLE_QUERY_ROUTE = '**/private/console/query'

export function parseConsoleQuery(request: Request): ConsoleQuery | null {
  if (!request.url().includes('/private/console/query') || request.method() !== 'POST')
    return null
  const query = request.postDataJSON() as ConsoleQuery | null
  return query && typeof query === 'object' && typeof query.name === 'string' ? query : null
}

export function consoleQueryFromResponse(response: Response): ConsoleQuery | null {
  return parseConsoleQuery(response.request())
}

/** HTTP verb the same chain would have used against PostgREST. */
export function consoleQueryMethod(query: ConsoleQuery): 'GET' | 'POST' | 'PATCH' | 'DELETE' {
  if (query.kind === 'rpc')
    return 'POST'
  for (const { method } of query.operations) {
    if (method === 'insert' || method === 'upsert')
      return 'POST'
    if (method === 'update')
      return 'PATCH'
    if (method === 'delete')
      return 'DELETE'
  }
  return 'GET'
}

/** Body of the write (insert/update/upsert payload) or the RPC arguments. */
export function consoleQueryPayload(query: ConsoleQuery): any {
  if (query.kind === 'rpc')
    return query.args[0]
  return query.operations.find(({ method }) => ['insert', 'update', 'upsert'].includes(method))?.args[0]
}

function wantsSingle(query: ConsoleQuery) {
  return query.operations.some(({ method }) => method === 'single' || method === 'maybeSingle')
}

/**
 * Shape rows like PostgREST would for the chain: an object for single/maybeSingle,
 * an array otherwise. A `single` with no rows yields null here (PostgREST would
 * answer PGRST116); use consoleQueryError to simulate that failure.
 */
export function consoleQueryRows(query: ConsoleQuery, rows: unknown[]): unknown {
  return wantsSingle(query) ? rows[0] ?? null : rows
}

export function consoleQueryJson(data: unknown, count: number | null = null) {
  return { json: { data, error: null, count, status: 200 } }
}

/** A PostgREST-style error the console client surfaces as `{ error }` on the awaited query. */
export function consoleQueryError(status: number, error: { code?: string, message: string }) {
  return { json: { data: null, error: { details: null, hint: null, ...error }, count: null, status } }
}

/** Intercept console queries for one table or RPC; other queries fall through. */
export async function routeConsoleQuery(page: Page, name: string, handler: (route: Route, query: ConsoleQuery) => Promise<unknown> | unknown) {
  await page.route(CONSOLE_QUERY_ROUTE, async (route) => {
    const query = parseConsoleQuery(route.request())
    if (!query || query.name !== name)
      return route.fallback()
    try {
      await handler(route, query)
    }
    catch (error) {
      // Fail the request so the spec reports the handler error instead of hanging.
      await route.abort().catch(() => {})
      throw error
    }
  })
}

/** Let the query reach the API, then rewrite the rows it returned. */
export async function forwardConsoleQuery(route: Route, override: (row: any) => any) {
  const response = await route.fetch()
  const json = await response.json().catch(() => null) as { data?: unknown } | null
  if (!json)
    return route.fulfill({ response })
  const data = json.data
  await route.fulfill({ response, json: { ...json, data: Array.isArray(data) ? data.map(override) : data == null ? data : override(data) } })
}
