import type { Context } from 'hono'
import type { GotrueAdmin, GotrueUser } from '../supabase/functions/_backend/utils/gotrue_admin.ts'
import { gotrueAdmin } from '../supabase/functions/_backend/utils/gotrue_admin.ts'

/**
 * The non-PostgREST parts of a supabase-js client for tests, over plain fetch
 * to the local stack: GoTrue (`/auth/v1`), Storage (`/storage/v1`) and Edge
 * Functions (`/functions/v1`). Each sends the requests and headers supabase-js
 * sends and answers with the same `{ data, error }` shapes, so tests only swap
 * the client. `createClient` in ./sql-data-client puts them next to `from()` /
 * `rpc()`.
 */

export interface AuthSession {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  expires_at?: number
  user: GotrueUser
}

/** Field-compatible with supabase-js `AuthApiError` / `StorageApiError` / `FunctionsHttpError`. */
export class LocalStackError extends Error {
  constructor(name: string, message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = name
  }
}

type AuthResult
  = | { data: { user: GotrueUser | null, session: AuthSession | null }, error: null }
    | { data: { user: null, session: null }, error: LocalStackError }

interface Credentials {
  email: string
  password: string
}

interface RawResult {
  status: number
  payload: any
  error: LocalStackError | null
}

// Same precedence as auth-js / storage-js.
function errorMessage(payload: any, fallback: string): string {
  for (const key of ['msg', 'message', 'error_description', 'error']) {
    if (typeof payload?.[key] === 'string')
      return payload[key]
  }
  return fallback
}

function parseJson(text: string): any {
  try {
    return text ? JSON.parse(text) : null
  }
  catch {
    return null
  }
}

function responseError(errorName: string, response: Response, text: string): LocalStackError {
  const payload = parseJson(text)
  const code = typeof payload?.error_code === 'string' ? payload.error_code : typeof payload?.code === 'string' ? payload.code : undefined
  return new LocalStackError(errorName, errorMessage(payload, text || response.statusText), response.status, code)
}

// auth-js NETWORK_ERROR_CODES: answered as AuthRetryableFetchError, which callers retry.
const AUTH_RETRYABLE_STATUSES = new Set([500, 501, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530])
const AUTH_RETRYABLE = 'AuthRetryableFetchError'

async function send(errorName: string, url: string, init: RequestInit): Promise<RawResult> {
  const auth = errorName === 'AuthApiError'
  let response: Response
  try {
    response = await fetch(url, init)
  }
  catch (error) {
    // auth-js returns a failed fetch as a retryable error with status 0.
    if (!auth)
      throw error
    return { status: 0, payload: null, error: new LocalStackError(AUTH_RETRYABLE, error instanceof Error ? error.message : String(error), 0) }
  }
  const text = await response.text()
  if (!response.ok) {
    const name = auth && AUTH_RETRYABLE_STATUSES.has(response.status) ? AUTH_RETRYABLE : errorName
    return { status: response.status, payload: null, error: responseError(name, response, text) }
  }
  return { status: response.status, payload: parseJson(text), error: null }
}

export interface LocalStackOptions {
  /** `global.headers` of the client: sent with every storage and functions request. */
  headers: Record<string, string>
}

export function createLocalStackHttp(url: string, key: string, options: LocalStackOptions) {
  const base = url.replace(/\/+$/, '')
  // Kept in memory only, like supabase-js with `persistSession: false`.
  let session: AuthSession | null = null

  const gotrue = (method: string, path: string, body?: unknown, jwt?: string) => send('AuthApiError', `${base}/auth/v1/${path}`, {
    method,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${jwt ?? key}`,
      'X-Supabase-Api-Version': '2024-01-01',
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  // auth-js `_sessionResponse`: a token answer is a session, otherwise the body is the user.
  const sessionResult = ({ payload, error }: RawResult): AuthResult => {
    if (error)
      return { data: { user: null, session: null }, error }
    const next: AuthSession | null = payload?.access_token ? payload : null
    if (next)
      session = next
    const user: GotrueUser | null = payload?.user ?? (typeof payload?.id === 'string' ? payload : null)
    return { data: { user, session: next }, error: null }
  }

  const credentials = ({ email, password }: Credentials) => ({ email, password, gotrue_meta_security: {} })

  // Like supabase-js: the global headers first, then apikey, then the session's token or the key.
  const stackHeaders = (extra: Record<string, string> = {}): Record<string, string> => {
    const headers: Record<string, string> = { ...options.headers, ...extra }
    const has = (name: string) => Object.keys(headers).some(header => header.toLowerCase() === name)
    if (!has('apikey'))
      headers.apikey = key
    if (!has('authorization'))
      headers.Authorization = `Bearer ${session?.access_token ?? key}`
    return headers
  }

  const auth = {
    signUp: async (input: Credentials): Promise<AuthResult> =>
      sessionResult(await gotrue('POST', 'signup', { ...credentials(input), data: {}, code_challenge: null, code_challenge_method: null })),
    signInWithPassword: async (input: Credentials): Promise<AuthResult> => {
      const result = sessionResult(await gotrue('POST', 'token?grant_type=password', credentials(input)))
      if (result.error || result.data.session)
        return result
      return { data: { user: null, session: null }, error: new LocalStackError('AuthSessionMissingError', 'Auth session or user missing', 400) }
    },
    // Like supabase-js, a 401/403/404 (session already gone) still signs out.
    signOut: async ({ scope }: { scope?: 'global' | 'local' | 'others' } = {}): Promise<{ error: LocalStackError | null }> => {
      const token = session?.access_token
      if (scope !== 'others')
        session = null
      if (!token)
        return { error: null }
      const { error } = await gotrue('POST', `logout?scope=${scope ?? 'global'}`, undefined, token)
      return { error: error && ![401, 403, 404].includes(error.status) ? error : null }
    },
    getSession: async (): Promise<{ data: { session: AuthSession | null }, error: null }> => ({ data: { session }, error: null }),
    admin: localGotrueAdmin(base, key),
  }

  const storage = {
    from: (bucket: string) => storageBucket(base, bucket, stackHeaders),
  }

  const functions = {
    invoke: async (name: string, init: { body?: unknown, headers?: Record<string, string>, method?: string } = {}) => {
      const { status, payload, error } = await send('FunctionsHttpError', `${base}/functions/v1/${name}`, {
        method: init.method ?? 'POST',
        headers: stackHeaders({ 'Content-Type': 'application/json', ...init.headers }),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      return error ? { data: null, error, response: undefined } : { data: payload, error: null, response: { status } }
    },
  }

  return { auth, storage, functions, session: () => session }
}

/**
 * `gotrueAdmin()` from the backend with this client's URL and key. Under Node,
 * the backend's getEnv reads process.env, not the context, so the request goes
 * through the context's GOTRUE binding and the binding sets the key, as
 * supabase-js does with the client's key.
 */
function localGotrueAdmin(base: string, key: string): GotrueAdmin {
  const GOTRUE = {
    fetch: (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      headers.set('apikey', key)
      headers.set('Authorization', `Bearer ${key}`)
      return fetch(url.replace(/^https:\/\/gotrue\//, `${base}/auth/v1/`), { ...init, headers })
    },
  }
  return gotrueAdmin({ env: { GOTRUE } } as unknown as Context)
}

type StorageResult<T> = { data: T, error: null } | { data: null, error: LocalStackError }

function storageResult<T>({ payload, error }: RawResult, data: (payload: any) => T): StorageResult<T> {
  return error ? { data: null, error } : { data: data(payload), error: null }
}

// storage-js `_removeEmptyFolders` and `_getFinalPath`.
function cleanPath(path: string): string {
  return path.replace(/^\/|\/$/g, '').replace(/\/+/g, '/')
}

function storageBucket(base: string, bucket: string, headers: (extra?: Record<string, string>) => Record<string, string>) {
  const root = `${base}/storage/v1`
  const objectPath = (path: string) => `${bucket}/${path.replace(/^\/+/, '')}`
  const json = (method: string, path: string, body: unknown) => send('StorageApiError', `${root}/${path}`, {
    method,
    headers: headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })

  return {
    download: async (path: string): Promise<StorageResult<Blob>> => {
      const response = await fetch(`${root}/object/${objectPath(path)}`, { headers: headers() })
      if (!response.ok)
        return { data: null, error: responseError('StorageApiError', response, await response.text()) }
      return { data: await response.blob(), error: null }
    },
    list: async (path: string, options: { search?: string, limit?: number, offset?: number } = {}): Promise<StorageResult<Array<{ name: string, [key: string]: unknown }>>> =>
      storageResult(await json('POST', `object/list/${bucket}`, { limit: 100, offset: 0, sortBy: { column: 'name', order: 'asc' }, ...options, prefix: path }), payload => payload),
    remove: async (paths: string[]): Promise<StorageResult<Array<{ name: string, [key: string]: unknown }>>> =>
      storageResult(await json('DELETE', `object/${bucket}`, { prefixes: paths }), payload => payload),
    // Like storage-js for a Blob: sent as form data, so the Blob's own type wins over `contentType`.
    upload: async (path: string, file: Blob, options: { upsert?: boolean, contentType?: string } = {}): Promise<StorageResult<{ path: string, id: string, fullPath: string }>> => {
      const clean = cleanPath(path)
      const body = new FormData()
      body.append('cacheControl', '3600')
      body.append('', file)
      const result = await send('StorageApiError', `${root}/object/${objectPath(clean)}`, {
        method: 'POST',
        headers: headers({ 'x-upsert': String(options.upsert ?? false) }),
        body,
      })
      return storageResult(result, payload => ({ path: clean, id: payload?.Id, fullPath: payload?.Key }))
    },
    createSignedUploadUrl: async (path: string): Promise<StorageResult<{ signedUrl: string, path: string, token: string }>> => {
      const result = await json('POST', `object/upload/sign/${objectPath(path)}`, {})
      if (result.error)
        return { data: null, error: result.error }
      const signed = new URL(`${root}${result.payload.url}`)
      const token = signed.searchParams.get('token')
      if (!token)
        return { data: null, error: new LocalStackError('StorageError', 'No token returned by API', 0) }
      return { data: { signedUrl: signed.toString(), path, token }, error: null }
    },
  }
}

export type LocalStackHttp = Omit<ReturnType<typeof createLocalStackHttp>, 'session'>
