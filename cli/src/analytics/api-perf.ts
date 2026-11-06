import { AsyncLocalStorage } from 'node:async_hooks'

// --- explicit call-site labels, async-safe across awaits and Promise.all ---
const sourceStore = new AsyncLocalStorage<string>()

/**
 * Tags every Capgo API call made inside `fn` with `source`. The result is wrapped
 * in `Promise.resolve()` inside `run()` so lazy thenables still start their fetch
 * inside the async context.
 */
export function withApiCallSource<T>(source: string, fn: () => T): Promise<Awaited<T>> {
  return sourceStore.run(source, () => Promise.resolve(fn())) as Promise<Awaited<T>>
}

export function getApiCallSource(): string | undefined {
  return sourceStore.getStore()
}

// --- instrumentation gate: off unless a CLI/MCP entrypoint enables it, so the
//     SDK bundle (which transitively imports invokeCapgoCliApi) stays clean.
let instrumentationEnabled = false

export function enableApiInstrumentation(): void {
  instrumentationEnabled = true
}

export function isApiInstrumentationEnabled(): boolean {
  return instrumentationEnabled
}

// --- the event recorder is injected by track.ts to avoid an import cycle ---
export interface ApiCallInfo {
  url: string
  /** Capgo API route relative to the API host, e.g. `private/cli/preflight`. */
  route?: string
  method: string
  status: number
  ok: boolean
  durationMs: number
  source?: string
  apikey?: string
  error?: unknown
}

export type ApiCallRecorder = (info: ApiCallInfo) => void

let recorder: ApiCallRecorder | undefined

export function setApiCallRecorder(fn: ApiCallRecorder): void {
  recorder = fn
}

/**
 * Invokes the recorder defensively. A throwing recorder must never change the
 * wrapped request's returned response or rethrown error (the "never altered"
 * contract), so any error here is swallowed.
 */
function safeRecord(info: ApiCallInfo): void {
  try {
    recorder?.(info)
  }
  catch {
    // Telemetry must never alter the wrapped request's outcome.
  }
}

/** An API call slower than this is flagged `slow` regardless of status. */
export const SLOW_THRESHOLD_MS = 5000

/**
 * Turns a Capgo API route into a low-cardinality operation label. Query strings
 * are discarded and only leading static segments are kept, so ids (app ids, etc.)
 * never become labels: `private/cli/preflight` => `POST private/cli/preflight`.
 */
export function deriveApiOperation(route: string, method: string): string {
  let pathname: string
  try {
    pathname = new URL(route).pathname
  }
  catch {
    pathname = route.split('?')[0]!
  }
  const segments: string[] = []
  for (const segment of pathname.split('/').filter(Boolean)) {
    // Letters only (plus the static `2fa` route) so ids/app ids never become labels.
    if (segments.length >= 4 || !/^(?:[a-z_-]+|2fa)$/.test(segment))
      break
    segments.push(segment)
  }
  return `${method} ${segments.join('/') || pathname}`
}

/**
 * Reads the Capgo API key from a request's `capgkey` header (set by
 * invokeCapgoCliApi). Lets perf telemetry attribute the call to the exact
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
 * A `fetch` wrapper for Capgo API calls. Times the real request (which runs
 * regardless), captures the active source label, and hands the result to the
 * injected recorder. Returns the real Response / rethrows the real error so the
 * caller's behavior is never altered. Calls `globalThis.fetch` dynamically (not
 * a captured ref) so it is testable and never self-recurses.
 */
export function createTimedFetch(route?: string): typeof fetch {
  const timedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const source = getApiCallSource()
    const apikey = extractCapgkey(init)
    const start = Date.now()
    try {
      const response = await globalThis.fetch(input, init)
      safeRecord({ url, route, method, status: response.status, ok: response.ok, durationMs: Date.now() - start, source, apikey })
      return response
    }
    catch (error) {
      safeRecord({ url, route, method, status: 0, ok: false, durationMs: Date.now() - start, source, apikey, error })
      throw error
    }
  }
  return timedFetch as typeof fetch
}
