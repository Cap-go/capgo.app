// HTTP wakeups the database writes to public.http_dispatch_outbox when a target
// is routed away from pg_net (see 20261027220420_durable_object_http_dispatch).

export interface HttpDispatchRow {
  id: string
  target: string
  url: string
  body: unknown
  timeout_ms: number
  calls: number
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
RETURNING id::text, target, url, body, timeout_ms, calls`

/**
 * Identical wakeups add nothing over one: keep one row per request with the
 * largest call count and timeout, like pg_net would have sent the latest tick.
 */
export function coalesceHttpDispatchRows(rows: readonly HttpDispatchRow[]): HttpDispatchRow[] {
  const byRequest = new Map<string, HttpDispatchRow>()
  for (const row of rows) {
    const key = JSON.stringify([row.target, row.url, row.body])
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

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  }
  catch {
    return null
  }
}

/** The dispatcher attaches the API secret, so it only calls origins we own. */
export function isAllowedDispatchUrl(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = originOf(url)
  return origin !== null && allowedOrigins.includes(origin)
}

export function dispatchAllowedOrigins(urls: readonly (string | undefined)[]): string[] {
  return [...new Set(urls.map(url => (url ? originOf(url) : null)).filter((origin): origin is string => origin !== null))]
}

export function buildHttpDispatchRequests(
  rows: readonly HttpDispatchRow[],
  apiSecret: string,
  allowedOrigins: readonly string[],
): { requests: HttpDispatchRequest[], rejected: HttpDispatchRow[] } {
  const requests: HttpDispatchRequest[] = []
  const rejected: HttpDispatchRow[] = []
  for (const row of coalesceHttpDispatchRows(rows)) {
    if (!isAllowedDispatchUrl(row.url, allowedOrigins)) {
      rejected.push(row)
      continue
    }
    const body = JSON.stringify(row.body)
    const calls = Math.min(Math.max(Math.trunc(row.calls), 1), HTTP_DISPATCH_MAX_CALLS_PER_ROW)
    for (let i = 0; i < calls; i++) {
      requests.push({
        target: row.target,
        url: row.url,
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
