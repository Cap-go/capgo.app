import { env } from 'node:process'
import { getSupabaseWorktreeConfig } from '../../scripts/supabase-worktree-config'
import { getSupabaseStatus } from '../../scripts/supabase-worktree-status'
import { createClient } from '../../tests/sql-data-client'

// Local stack access for specs without supabase-js: tables through the SQL data
// client, GoTrue over plain fetch with the requests and headers auth-js sends
// (like the backend's utils/gotrue_admin.ts).

const { ports } = getSupabaseWorktreeConfig()
export const localSupabaseUrl = `http://127.0.0.1:${ports.api}`
export const localSupabaseAnonKey = env.SUPABASE_ANON_KEY || 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'

let status: ReturnType<typeof getSupabaseStatus> | undefined
function localStatus() {
  status ??= getSupabaseStatus()
  return status
}

export function localServiceKey(): string {
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || localStatus()?.SERVICE_ROLE_KEY || localStatus()?.SECRET_KEY
  if (!key)
    throw new Error('Local Supabase service key is required for e2e fixtures')
  return key
}

// Table access as the key's role, or as the user when an access token is given.
export function localSqlClient(key = localServiceKey(), accessToken?: string) {
  if (!env.SUPABASE_DB_URL && !env.DB_URL) {
    const dbUrl = localStatus()?.DB_URL
    if (dbUrl)
      env.SUPABASE_DB_URL = dbUrl
  }
  const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined
  return createClient(localSupabaseUrl, key, { auth: { persistSession: false }, global: { headers } })
}

export interface AuthUser { id: string, email?: string }
export interface AuthSession { access_token: string, user: AuthUser }
export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'AuthError'
  }
}

async function gotrue(key: string, method: string, path: string, body?: unknown, jwt?: string) {
  const response = await fetch(`${localSupabaseUrl}/auth/v1/${path}`, {
    method,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${jwt ?? key}`,
      'X-Supabase-Api-Version': '2024-01-01',
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let payload: any = null
  try {
    payload = text ? JSON.parse(text) : null
  }
  catch {}
  if (!response.ok)
    return { payload: null, error: new AuthError(payload?.msg ?? payload?.message ?? payload?.error_description ?? payload?.error ?? (text || response.statusText), response.status) }
  return { payload, error: null }
}

// Same result shape as supabase-js `auth.signUp` / `auth.signInWithPassword`.
function sessionResult({ payload, error }: Awaited<ReturnType<typeof gotrue>>) {
  if (error)
    return { data: { user: null, session: null }, error }
  const session: AuthSession | null = payload?.access_token ? payload : null
  const user: AuthUser | null = payload?.user ?? (typeof payload?.id === 'string' ? payload : null)
  return { data: { user, session }, error: null }
}

/**
 * Stand-in for an anon supabase-js client in specs: `auth` calls GoTrue and
 * keeps the session, `from()` runs as SQL as that session's user (or anon).
 */
export function localAuthClient(key = localSupabaseAnonKey) {
  let session: AuthSession | null = null
  const keep = (result: ReturnType<typeof sessionResult>) => {
    session = result.data.session ?? session
    return result
  }
  const credentials = (email: string, password: string) => ({ email, password, gotrue_meta_security: {} })
  return {
    auth: {
      signUp: async ({ email, password }: { email: string, password: string }) =>
        keep(sessionResult(await gotrue(key, 'POST', 'signup', { ...credentials(email, password), data: {}, code_challenge: null, code_challenge_method: null }))),
      signInWithPassword: async ({ email, password }: { email: string, password: string }) => {
        const result = keep(sessionResult(await gotrue(key, 'POST', 'token?grant_type=password', credentials(email, password))))
        return result.error || result.data.session ? result : { data: { user: null, session: null }, error: new AuthError('Auth session or user missing', 500) }
      },
      // Like supabase-js, a 401/403/404 (session already gone) still signs out.
      signOut: async ({ scope }: { scope: 'global' | 'local' | 'others' } = { scope: 'global' }) => {
        const token = session?.access_token
        session = null
        if (!token)
          return { error: null }
        const { error } = await gotrue(key, 'POST', `logout?scope=${scope}`, undefined, token)
        return { error: error && ![401, 403, 404].includes(error.status) ? error : null }
      },
    },
    from: (table: string) => localSqlClient(key, session?.access_token).from(table),
  }
}

export async function deleteAuthUser(id: string) {
  const { error } = await gotrue(localServiceKey(), 'DELETE', `admin/users/${encodeURIComponent(id)}`, { should_soft_delete: false })
  return { error }
}
