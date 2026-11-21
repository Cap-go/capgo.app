// HTTP wakeups the database writes to public.http_dispatch_outbox when a target
// is routed away from pg_net (see 20261027220420_durable_object_http_dispatch
// and 20261121125521_http_dispatch_cloudflare_runtime).

/**
 * Where a routed target runs. 'supabase' sends the stored Edge Function URL.
 * 'cloudflare' runs it on the API worker: queue wakeups are relayed into
 * Cloudflare Queues by the claim, other wakeups go to the same route on
 * CLOUDFLARE_FUNCTION_URL. Rows claimed before the column existed have none.
 */
export type HttpDispatchRuntime = 'supabase' | 'cloudflare'

export interface HttpDispatchRow {
  id: string
  target: string
  url: string
  body: unknown
  timeout_ms: number
  calls: number
  runtime?: string | null
}

export interface HttpDispatchRequest {
  target: string
  url: string
  timeoutMs: number
  init: RequestInit
}

// Rows are append-only (one per wakeup, including one per cache-purge business
// write), so a claim must drain a dispatcher outage backlog quickly; rows are
// tiny and coalesced right after the claim.
export const HTTP_DISPATCH_CLAIM_LIMIT = 5000
// Same ceiling process_function_queue applies to calls_needed.
export const HTTP_DISPATCH_MAX_CALLS_PER_ROW = 10

// A top-level DELETE is never served from the Hyperdrive query cache, and
// SKIP LOCKED lets an overlapping claim take the remaining rows.
export const HTTP_DISPATCH_CLAIM_SQL = `
DELETE FROM public.http_dispatch_outbox
WHERE id IN (
  SELECT id FROM public.http_dispatch_outbox
  ORDER BY id
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING id::text, target, url, body, timeout_ms, calls, runtime`

export function httpDispatchRuntime(row: Pick<HttpDispatchRow, 'runtime'>): HttpDispatchRuntime {
  return row.runtime === 'cloudflare' ? 'cloudflare' : 'supabase'
}

// Outbox URLs are get_db_url() || '/functions/v1/<route>'; the API worker
// mounts the same routes without the prefix.
const SUPABASE_FUNCTIONS_PREFIX = '/functions/v1/'
export const QUEUE_CONSUMER_SYNC_ROUTE = '/triggers/queue_consumer/sync'

/** The API worker route of a Supabase function URL, or null for anything else. */
export function cloudflareRoute(url: string): string | null {
  const parsed = parseUrl(url)
  if (!parsed?.pathname.startsWith(SUPABASE_FUNCTIONS_PREFIX))
    return null
  return `${parsed.pathname.slice(SUPABASE_FUNCTIONS_PREFIX.length - 1)}${parsed.search}`
}

/** A process_function_queue wakeup routed to Cloudflare, which the claim relays instead of returning. */
export function isCloudflareQueueWakeup(row: HttpDispatchRow): boolean {
  return httpDispatchRuntime(row) === 'cloudflare' && parseUrl(row.url)?.pathname === `/functions/v1${QUEUE_CONSUMER_SYNC_ROUTE}`
}

/**
 * Identical wakeups add nothing over one: keep one row per request with the
 * largest call count and timeout, like pg_net would have sent the latest tick.
 */
export function coalesceHttpDispatchRows(rows: readonly HttpDispatchRow[]): HttpDispatchRow[] {
  const byRequest = new Map<string, HttpDispatchRow>()
  for (const row of rows) {
    const key = JSON.stringify([row.target, row.url, row.body, httpDispatchRuntime(row)])
    const existing = byRequest.get(key)
    if (!existing) {
      byRequest.set(key, { ...row })
      continue
    }
    existing.calls = Math.max(existing.calls, row.calls)
    existing.timeout_ms = Math.max(existing.timeout_ms, row.timeout_ms)
  }
  return [...byRequest.values()]
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  }
  catch {
    return null
  }
}

function originOf(url: string): string | null {
  return parseUrl(url)?.origin ?? null
}

/** The dispatcher attaches the API secret, so it only calls origins we own. */
export function isAllowedDispatchUrl(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url)
  return origin !== null && allowedOrigins.includes(origin)
}

export function dispatchAllowedOrigins(urls: readonly (string | undefined)[]): string[] {
  return [...new Set(urls.map(url => (url ? originOf(url) : null)).filter((origin): origin is string => origin !== null))]
}

/**
 * Where a claimed row is sent: the stored URL, or for runtime 'cloudflare' the
 * same route on the API worker. Without CLOUDFLARE_FUNCTION_URL the stored URL
 * still works, because those Supabase functions forward to Cloudflare.
 */
export function httpDispatchUrl(row: HttpDispatchRow, cloudflareFunctionUrl: string | undefined): string {
  if (httpDispatchRuntime(row) !== 'cloudflare' || !cloudflareFunctionUrl || !parseUrl(cloudflareFunctionUrl))
    return row.url
  const route = cloudflareRoute(row.url)
  return route ? `${cloudflareFunctionUrl.replace(/\/$/, '')}${route}` : row.url
}

export function buildHttpDispatchRequests(
  rows: readonly HttpDispatchRow[],
  apiSecret: string,
  allowedOrigins: readonly string[],
  cloudflareFunctionUrl?: string,
): { requests: HttpDispatchRequest[], rejected: HttpDispatchRow[] } {
  const requests: HttpDispatchRequest[] = []
  const rejected: HttpDispatchRow[] = []
  for (const row of coalesceHttpDispatchRows(rows)) {
    // Checked on the stored URL for both runtimes: only rows our own database
    // wrote are sent, and the Cloudflare URL comes from the worker's own env.
    if (!isAllowedDispatchUrl(row.url, allowedOrigins)) {
      rejected.push(row)
      continue
    }
    const url = httpDispatchUrl(row, cloudflareFunctionUrl)
    const body = JSON.stringify(row.body)
    const calls = Math.min(Math.max(Math.trunc(row.calls), 1), HTTP_DISPATCH_MAX_CALLS_PER_ROW)
    for (let i = 0; i < calls; i++) {
      requests.push({
        target: row.target,
        url,
        timeoutMs: row.timeout_ms,
        init: {
          method: 'POST',
          // fetch keeps custom headers across cross-origin redirects, so a
          // redirect would carry the API secret past the allowlist. pg_net
          // does not follow redirects either.
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json', 'apisecret': apiSecret },
          body,
        },
      })
    }
  }
  return { requests, rejected }
}
