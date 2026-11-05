import type { ConsoleClient } from '~/services/consoleClient'
import type { Database } from '~/types/database.types'
import { FunctionsFetchError, FunctionsHttpError } from '~/services/consoleClient'
import { useConsole } from './console'

export interface CapgoApiInvokeOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: BodyInit | Record<string, unknown> | null
  headers?: Record<string, string>
  /**
   * Opt into a dated `capgo_api` contract (e.g. `2026-10-22`). Omit to keep the
   * default version so older backends and other clients stay compatible.
   */
  apiVersion?: string
  /** Call without an Authorization header when there is no user session (public bootstrap endpoints). */
  allowAnonymous?: boolean
  /** Prefer caller-provided client for session/auth context. */
  client?: ConsoleClient<Database>
  /**
   * Number of automatic retries for transient failures (network drops, edge
   * timeouts, and 5xx/429 responses from a stressed backend). Defaults to 2 for
   * idempotent requests (GET/HEAD) and 0 otherwise, so mutations are never
   * silently replayed. Pass 0 to opt out entirely.
   */
  retries?: number
}

/** HTTP statuses that indicate a transient, retry-worthy backend failure. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status)
}

/** Only idempotent methods are auto-retried so a retry can't double-apply a mutation. */
function isIdempotentMethod(method: string): boolean {
  const normalized = method.toUpperCase()
  return normalized === 'GET' || normalized === 'HEAD' || normalized === 'OPTIONS'
}

export function defaultRetriesForMethod(method: string): number {
  return isIdempotentMethod(method) ? 2 : 0
}

/**
 * True when an invoke error looks transient and safe to retry: a network-level
 * failure (`Failed to fetch` / `Failed to send a request to the Edge Function`)
 * or a retryable HTTP status. Non-2xx business errors (4xx) are not retried.
 */
export function isRetryableInvokeError(error: unknown): boolean {
  if (error instanceof FunctionsHttpError && error.context instanceof Response)
    return isRetryableStatus(error.context.status)
  if (error instanceof FunctionsFetchError)
    return true
  // Raw browser fetch failures surface as TypeError ("Failed to fetch").
  if (error instanceof TypeError)
    return true
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string'
    && (message.includes('Failed to fetch')
      || message.includes('Failed to send a request to the Edge Function'))
}

/** Uniform fraction in [0, 1) from the crypto RNG (Math.random is flagged by static analysis). */
function jitterFraction(): number {
  const buffer = new Uint32Array(1)
  globalThis.crypto.getRandomValues(buffer)
  return buffer[0] / 2 ** 32
}

/** Exponential backoff with full jitter, capped, so retries don't stampede a recovering backend. */
export function retryBackoffMs(attempt: number): number {
  const exponential = Math.min(3000, 300 * 2 ** attempt)
  return Math.round(exponential / 2 + jitterFraction() * (exponential / 2))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run an invoke attempt, retrying transient failures up to `retries` times with
 * backoff. The attempt must resolve to the `{ data, error }` shape rather than
 * throwing, so every attempt shares the same retry policy.
 */
async function invokeWithRetry<T>(
  attempt: () => Promise<{ data: T | null, error: Error | null }>,
  retries: number,
): Promise<{ data: T | null, error: Error | null }> {
  for (let i = 0; ; i++) {
    const result = await attempt()
    if (!result.error || i >= retries || !isRetryableInvokeError(result.error))
      return result
    await sleep(retryBackoffMs(i))
  }
}

function normalizeApiHost(host = ''): string {
  let end = host.length
  while (end > 0 && host[end - 1] === '/')
    end -= 1
  return host.slice(0, end)
}

function serializeBody(body: CapgoApiInvokeOptions['body']): BodyInit | undefined {
  if (body == null)
    return undefined
  if (
    typeof body === 'string'
    || body instanceof Blob
    || body instanceof FormData
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
  ) {
    return body as BodyInit
  }
  return JSON.stringify(body)
}

function isPostgresUniqueViolation(message: string): boolean {
  return message.includes('23505')
    || /duplicate key value violates unique constraint/i.test(message)
}

/** Prefer Postgres unique-violation codes nested under Capgo API `moreInfo`. */
export async function getCapgoApiErrorCode(error: unknown): Promise<string | undefined> {
  if (error instanceof FunctionsHttpError && error.context instanceof Response) {
    const body = await error.context.clone().json().catch(() => null) as {
      code?: string
      error?: string
      moreInfo?: { code?: string, error?: unknown }
    } | null
    const nestedCode = body?.moreInfo?.code
    if (typeof nestedCode === 'string')
      return nestedCode
    const nestedError = body?.moreInfo?.error
    if (typeof nestedError === 'string' && isPostgresUniqueViolation(nestedError))
      return '23505'
    if (typeof body?.code === 'string')
      return body.code
    if (typeof body?.error === 'string')
      return body.error
  }
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

/** The backend's own error name (`simpleError`'s first argument), ignoring nested provider codes. */
export async function getCapgoApiErrorName(error: unknown): Promise<string | undefined> {
  if (!(error instanceof FunctionsHttpError) || !(error.context instanceof Response))
    return undefined
  const body = await error.context.clone().json().catch(() => null) as { error?: unknown } | null
  return typeof body?.error === 'string' ? body.error : undefined
}

/**
 * Call the Capgo API (VITE_API_HOST) with a { data, error } result shape.
 * Cloud, self-host and local builds all use this single transport; the
 * console never talks to the database or auth provider directly.
 */
export async function invokeCapgoApi<T = any>(
  path: string,
  options: CapgoApiInvokeOptions = {},
): Promise<{ data: T | null, error: Error | null }> {
  const client = options.client ?? useConsole()

  const method = (options.method ?? 'POST').toUpperCase()
  const retries = options.retries ?? defaultRetriesForMethod(method)
  const headers: Record<string, string> = {
    ...options.headers,
  }
  if (options.apiVersion && !Object.keys(headers).some(key => key.toLowerCase() === 'capgo_api'))
    headers.capgo_api = options.apiVersion

  const hasAuthHeader = Object.keys(headers).some(key => key.toLowerCase() === 'authorization')
  if (!hasAuthHeader) {
    const { data: sessionData } = await client.auth.getSession()
    const token = sessionData.session?.access_token
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    else if (!options.allowAnonymous) {
      return {
        data: null,
        error: new Error('Not authenticated'),
      }
    }
  }

  const body = serializeBody(options.body)
  const hasContentType = Object.keys(headers).some(key => key.toLowerCase() === 'content-type')
  if (body != null && !hasContentType && !(body instanceof FormData))
    headers['Content-Type'] = 'application/json'

  const apiHost = normalizeApiHost(import.meta.env.VITE_API_HOST as string)
  const url = `${apiHost}/${path.replace(/^\//, '')}`

  return invokeWithRetry<T>(async () => {
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      })

      if (!response.ok) {
        return {
          data: null,
          error: new FunctionsHttpError(response),
        }
      }

      const contentType = response.headers.get('content-type') ?? ''
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => null)
        : await response.text().catch(() => null)

      return {
        data: payload as T,
        error: null,
      }
    }
    catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error : new Error(String(error)),
      }
    }
  }, retries)
}
