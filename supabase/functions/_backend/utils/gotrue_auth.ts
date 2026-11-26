import type { Context } from 'hono'
import type { GotrueUser, RawResponse } from './gotrue_admin.ts'
import { GotrueAdminError, gotrueRequest } from './gotrue_admin.ts'
import { getClientIP } from './rate_limit.ts'
import { getEnv } from './utils.ts'

// GoTrue user auth over plain fetch, replacing the anon supabase-js client
// (`auth.signInWithPassword`, `auth.signUp`, `auth.verifyOtp`). Same requests,
// result shapes and errors as auth-js, so callers only swap the client.
// Routed like gotrue_admin.ts: GOTRUE binding when present, else hosted Supabase Auth.

export interface GotrueSession {
  access_token: string
  refresh_token: string
  expires_in: number
  expires_at: number
  token_type?: string
  user: GotrueUser
  [key: string]: unknown
}

export type AuthResponse
  = | { data: { user: GotrueUser | null, session: GotrueSession | null }, error: null }
    | { data: { user: null, session: null }, error: GotrueAdminError }

type EmailOtpType = 'signup' | 'invite' | 'magiclink' | 'recovery' | 'email_change' | 'email'

export type VerifyOtpParams
  = | { token_hash: string, type: EmailOtpType }
    | { email: string, token: string, type: EmailOtpType }

interface PasswordCredentials {
  email: string
  password: string
  options?: { captchaToken?: string }
}

interface SignUpCredentials {
  email: string
  password: string
  options?: { captchaToken?: string, data?: Record<string, unknown> }
}

// Same as auth-js `_sessionResponse`: a session needs both tokens and expires_in.
function sessionResponse(result: RawResponse): AuthResponse {
  if (result.error)
    return { data: { user: null, session: null }, error: result.error }
  const data = result.data as Record<string, any>
  const session = data.access_token && data.refresh_token && data.expires_in
    ? { ...data, expires_at: data.expires_at || Math.round(Date.now() / 1000) + data.expires_in } as GotrueSession
    : null
  const user = data.user ?? (typeof data.id === 'string' ? data as GotrueUser : null)
  return { data: { user, session }, error: null }
}

/**
 * Anon GoTrue client. `forwardClientIp` sends the trusted client IP as
 * X-Forwarded-For so GoTrue rate-limits per end user, not per Worker.
 */
export function gotrueAuth(c: Context, options: { forwardClientIp?: boolean } = {}) {
  const clientIp = options.forwardClientIp ? getClientIP(c) : 'unknown'
  const headers: Record<string, string> = clientIp === 'unknown' ? {} : { 'X-Forwarded-For': clientIp }
  const post = async (path: string, body: object) => sessionResponse(await gotrueRequest(c, getEnv(c, 'SUPABASE_ANON_KEY'), 'POST', path, body, headers))

  return {
    signInWithPassword: async ({ email, password, options }: PasswordCredentials): Promise<AuthResponse> => {
      const result = await post('token?grant_type=password', { email, password, gotrue_meta_security: { captcha_token: options?.captchaToken } })
      // Like supabase-js, a sign-in without both a session and a user is an error.
      if (!result.error && (!result.data.session || !result.data.user))
        return { data: { user: null, session: null }, error: new GotrueAdminError('Auth session or user missing', 500) }
      return result
    },
    signUp: ({ email, password, options }: SignUpCredentials): Promise<AuthResponse> =>
      post('signup', { email, password, data: options?.data ?? {}, gotrue_meta_security: { captcha_token: options?.captchaToken } }),
    verifyOtp: (params: VerifyOtpParams): Promise<AuthResponse> =>
      post('verify', { ...params, gotrue_meta_security: {} }),
  }
}
