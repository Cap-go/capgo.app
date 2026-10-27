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

// One claim per tick. process_function_queue coalesces to one row per queue,
// so a full claim is far above the ~40 routable targets.
export const HTTP_DISPATCH_CLAIM_LIMIT = 500
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
  for (const row of rows) {
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
          headers: { 'Content-Type': 'application/json', 'apisecret': apiSecret },
          body,
        },
      })
    }
  }
  return { requests, rejected }
}
