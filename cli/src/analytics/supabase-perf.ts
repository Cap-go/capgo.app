import { AsyncLocalStorage } from 'node:async_hooks'

// --- explicit call-site labels, async-safe across awaits and Promise.all ---
const sourceStore = new AsyncLocalStorage<string>()

/**
 * Tags every Supabase call made inside `fn` with `source`.
 *
 * The Supabase JS query builder is a lazy thenable: it does not call `fetch`
 * until `.then()` is invoked (i.e. when the caller `await`s it). If we only
 * call `run(source, fn)` and return the builder, `.then()` fires *outside* the
 * AsyncLocalStorage context and `getSupabaseSource()` returns `undefined`.
 *
 * To fix this, we wrap the result in `Promise.resolve()` inside the `run()`
 * callback. This schedules the microtask (which calls `.then()` on the builder)
 * while still inside the async context, so the source label propagates through
 * to the actual fetch. For plain Promises and non-thenable values the behaviour
 * is unchanged.
 */
export function withSupabaseSource<T>(source: string, fn: () => T): Promise<Awaited<T>> {
  return sourceStore.run(source, () => Promise.resolve(fn())) as Promise<Awaited<T>>
}

export function getSupabaseSource(): string | undefined {
  return sourceStore.getStore()
}

// --- instrumentation gate: off unless a CLI/MCP entrypoint enables it, so the
//     SDK bundle (which transitively imports createSupabaseClient) stays clean.
let instrumentationEnabled = false

export function enableSupabaseInstrumentation(): void {
  instrumentationEnabled = true
}

export function isSupabaseInstrumentationEnabled(): boolean {
  return instrumentationEnabled
}

// --- the event recorder is injected by track.ts to avoid an import cycle ---
export interface SupabaseCallInfo {
  url: string
  method: string
  status: number
  ok: boolean
  durationMs: number
  source?: string
  apikey?: string
  error?: unknown
}

export type SupabaseCallRecorder = (info: SupabaseCallInfo) => void

let recorder: SupabaseCallRecorder | undefined

export function setSupabaseCallRecorder(fn: SupabaseCallRecorder): void {
  recorder = fn
}

/**
 * Invokes the recorder defensively. A throwing recorder must never change the
 * wrapped request's returned response or rethrown error (the "never altered"
 * contract), so any error here is swallowed.
 */
function safeRecord(info: SupabaseCallInfo): void {
  try {
    recorder?.(info)
  }
  catch {
    // Telemetry must never alter the wrapped request's outcome.
  }
}

/** A Supabase call slower than this is flagged `slow` regardless of status. */
export const SLOW_THRESHOLD_MS = 5000

/**
 * Parses a Supabase REST/RPC/Functions URL into a low-cardinality operation label.
 * Query strings are discarded so filter values never leak and cardinality
 * stays bounded. `/rest/v1/rpc/get_user_id` => `rpc:get_user_id`;
 * `/rest/v1/apps?...` => `GET apps`;
 * `/functions/v1/files/upload_link` => `POST functions:files/upload_link`.
 */
export function deriveSupabaseOperation(url: string, method: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  }
  catch {
    pathname = url.split('?')[0]
  }
  const functionsMarker = '/functions/v1/'
  const functionsIdx = pathname.indexOf(functionsMarker)
  if (functionsIdx >= 0) {
    const functionRoute = pathname.slice(functionsIdx + functionsMarker.length)
    let start = 0
    let end = functionRoute.length
    while (start < end && functionRoute[start] === '/')
      start += 1
    while (end > start && functionRoute[end - 1] === '/')
      end -= 1
    const trimmedRoute = functionRoute.slice(start, end)
    return trimmedRoute ? `${method} functions:${trimmedRoute}` : `${method} functions`
  }

  const marker = '/rest/v1/'
  const idx = pathname.indexOf(marker)
  const after = idx >= 0 ? pathname.slice(idx + marker.length) : pathname.replace(/^\//, '')
  if (after.startsWith('rpc/')) {
    const fn = after.slice('rpc/'.length).split('/')[0]
    return `rpc:${fn}`
  }
  const table = after.split('/')[0] || pathname
  return `${method} ${table}`
}

/**
 * Reads the Capgo API key from a Supabase request's `capgkey` header (set by
 * createSupabaseClient). Lets perf telemetry attribute the call to the exact
 * key used — even when it came from `--apikey` rather than env / a saved file,
 * a case where the global `trackEvent` key-lookup would otherwise find nothing.
 */
function extractCapgkey(init: Parameters<typeof fetch>[1]): string | undefined {
  const headers = init?.headers
  if (!headers)
    return undefined
  const getter = (headers as { get?: (name: string) => string | null }).get
  if (typeof getter === 'function')
    return getter.call(headers, 'capgkey') ?? undefined
  if (Array.isArray(headers))
    return headers.find(([key]) => key.toLowerCase() === 'capgkey')?.[1]
  return (headers as Record<string, string>).capgkey
}

/**
 * A `fetch` wrapper for supabase-js's `global.fetch`. Times the real request
 * (which runs regardless), captures the active source label, and hands the
 * result to the injected recorder. Returns the real Response / rethrows the
 * real error so supabase-js behavior is never altered. Calls `globalThis.fetch`
 * dynamically (not a captured ref) so it is testable and never self-recurses.
 */
export function createTimedFetch(): typeof fetch {
  const timedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const source = getSupabaseSource()
    const apikey = extractCapgkey(init)
    const start = Date.now()
    try {
      const response = await globalThis.fetch(input, init)
      safeRecord({ url, method, status: response.status, ok: response.ok, durationMs: Date.now() - start, source, apikey })
      return response
    }
    catch (error) {
      safeRecord({ url, method, status: 0, ok: false, durationMs: Date.now() - start, source, apikey, error })
      throw error
    }
  }
  return timedFetch as typeof fetch
}
