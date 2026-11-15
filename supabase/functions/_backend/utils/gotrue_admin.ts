import type { Context } from 'hono'
import type { Bindings } from './cloudflare.ts'
import { getEnv, trimTrailingSlashes } from './utils.ts'

// GoTrue admin API over plain fetch, replacing supabase-js `auth.admin.*`.
// Same requests, headers, result shapes and error fields as supabase-js, so
// callers only swap the client. Routed like console_auth_proxy.ts: through the
// GOTRUE binding when this environment has one, else hosted Supabase Auth.

export interface GotrueUser {
  id: string
  email?: string
  email_confirmed_at?: string
  app_metadata: { provider?: string, providers?: string[], [key: string]: any }
  user_metadata: Record<string, any>
  identities?: Array<{ provider: string, [key: string]: any }>
}

export interface AdminUserAttributes {
  id?: string
  email?: string
  password?: string
  email_confirm?: boolean
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
}

export interface GenerateLinkProperties {
  action_link: string
  email_otp: string
  hashed_token: string
  redirect_to: string
  verification_type: string
}

export class GotrueAdminError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'GotrueAdminError'
  }
}

export type UserResponse
  = | { data: { user: GotrueUser }, error: null }
    | { data: { user: null }, error: GotrueAdminError }

export type GenerateLinkResponse
  = | { data: { properties: GenerateLinkProperties, user: GotrueUser }, error: null }
    | { data: { properties: null, user: null }, error: GotrueAdminError }

type RawResponse = { data: unknown, error: null } | { data: null, error: GotrueAdminError }

// Same precedence as supabase-js (auth-js lib/fetch.ts).
function errorMessage(value: unknown, fallback: string): string {
  if (value && typeof value === 'object') {
    for (const key of ['msg', 'message', 'error_description', 'error'] as const) {
      const field = (value as Record<string, unknown>)[key]
      if (typeof field === 'string')
        return field
    }
  }
  return fallback
}

function errorCode(value: unknown): string | undefined {
  const body = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  if (typeof body.code === 'string')
    return body.code
  return typeof body.error_code === 'string' ? body.error_code : undefined
}

async function request(c: Context, method: string, path: string, body?: unknown): Promise<RawResponse> {
  const key = getEnv(c, 'SUPABASE_SERVICE_ROLE_KEY')
  const headers: Record<string, string> = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'X-Supabase-Api-Version': '2024-01-01',
  }
  if (body !== undefined)
    headers['Content-Type'] = 'application/json;charset=UTF-8'
  const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }
  const goTrue = (c.env as Partial<Bindings> | undefined)?.GOTRUE

  let response: Response
  try {
    response = goTrue
      ? await goTrue.fetch(`https://gotrue/${path}`, init)
      : await fetch(`${trimTrailingSlashes(getEnv(c, 'SUPABASE_URL'))}/auth/v1/${path}`, init)
  }
  catch (error) {
    return { data: null, error: new GotrueAdminError(error instanceof Error ? error.message : String(error), 0) }
  }

  const text = await response.text().catch(() => '')
  let payload: unknown = null
  try {
    payload = text ? JSON.parse(text) : null
  }
  catch {
    if (response.ok)
      return { data: null, error: new GotrueAdminError('Invalid JSON from auth server', 0) }
  }
  if (!response.ok)
    return { data: null, error: new GotrueAdminError(errorMessage(payload, text || response.statusText), response.status, errorCode(payload)) }
  return { data: payload, error: null }
}

function userResponse(result: RawResponse): UserResponse {
  if (result.error)
    return { data: { user: null }, error: result.error }
  // Admin endpoints answer with the user itself; supabase-js also accepts `{ user }`.
  const data = result.data as ({ user?: GotrueUser } & GotrueUser) | null
  const user = data?.user ?? data
  if (typeof user?.id !== 'string')
    return { data: { user: null }, error: new GotrueAdminError('Auth server returned no user', 0) }
  return { data: { user }, error: null }
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Like supabase-js, a non-UUID id throws before any request (it would otherwise
// reach other admin paths, e.g. `.` lists every user).
function userPath(id: string) {
  if (!UUID_REGEX.test(id))
    throw new Error('Expected parameter to be UUID but is not')
  return `admin/users/${id}`
}

export function gotrueAdmin(c: Context) {
  return {
    getUserById: async (id: string): Promise<UserResponse> => userResponse(await request(c, 'GET', userPath(id))),
    createUser: async (attributes: AdminUserAttributes): Promise<UserResponse> => userResponse(await request(c, 'POST', 'admin/users', attributes)),
    updateUserById: async (id: string, attributes: AdminUserAttributes): Promise<UserResponse> => userResponse(await request(c, 'PUT', userPath(id), attributes)),
    deleteUser: async (id: string): Promise<{ error: GotrueAdminError | null }> => ({ error: (await request(c, 'DELETE', userPath(id), { should_soft_delete: false })).error }),
    generateLink: async (params: { type: 'magiclink', email: string }): Promise<GenerateLinkResponse> => {
      const result = await request(c, 'POST', 'admin/generate_link', params)
      if (result.error)
        return { data: { properties: null, user: null }, error: result.error }
      const { action_link, email_otp, hashed_token, redirect_to, verification_type, ...user } = result.data as GenerateLinkProperties & GotrueUser
      return { data: { properties: { action_link, email_otp, hashed_token, redirect_to, verification_type }, user: user as GotrueUser }, error: null }
    },
  }
}

export type GotrueAdmin = ReturnType<typeof gotrueAdmin>
