import type { AuthChangeEvent, Factor, Session, User } from '../../supabase/functions/_backend/utils/console_contract'

/**
 * Console auth client. Speaks the GoTrue protocol to `/private/console/auth/*`
 * on the Capgo API, which relays each call to the auth provider with the caller's
 * address, so the browser never holds an auth-provider host or key. The surface
 * and result shapes mirror the subset of the previous SDK auth client the console uses.
 */

export const SESSION_STORAGE_KEY = 'capgo.console.auth'
const CODE_VERIFIER_STORAGE_KEY = 'capgo.console.code-verifier'
// Sessions written by the previous SDK client, adopted once on first load.
const LEGACY_SESSION_KEY = /^sb-[\w-]+-auth-token$/
const EXPIRY_MARGIN_SECONDS = 30
const AUTO_REFRESH_TICK_MS = 30_000
const AUTO_REFRESH_WINDOW_SECONDS = 90

export class ConsoleAuthError extends Error {
  status: number
  code: string | undefined
  constructor(message: string, status: number, code?: string, name = 'AuthApiError') {
    super(message)
    this.name = name
    this.status = status
    this.code = code
  }
}

function sessionMissing() {
  return new ConsoleAuthError('Auth session missing!', 400, 'session_not_found', 'AuthSessionMissingError')
}

type Result<T> = { data: T, error: null } | { data: T, error: ConsoleAuthError }
type Listener = (event: AuthChangeEvent, session: Session | null) => void

export interface ConsoleAuthOptions {
  /** Base URL of the Capgo API (VITE_API_HOST). */
  baseURL: string
  /** Keep the session in localStorage and refresh it in the background. */
  persistSession?: boolean
}

export interface MfaVerifyResult {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  user: User
}

interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  expires_at?: number
  refresh_token: string
  user: User
  weak_password?: { reasons: string[], message?: string }
}

export function resolveConsoleApiBase(configured: string | undefined) {
  const base = (configured ?? '').replace(/\/$/, '')
  return base.startsWith('/') ? new URL(base, location.origin).href.replace(/\/$/, '') : base
}

export function decodeJwtPayload(jwt: string): Record<string, any> | null {
  const payload = jwt.split('.')[1]
  if (!payload)
    return null
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const text = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
    return JSON.parse(decodeURIComponent(Array.from(text, char => `%${(char.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`).join('')))
  }
  catch {
    return null
  }
}

function decodeJwtHeader(jwt: string): Record<string, any> | null {
  const header = jwt.split('.')[0]
  try {
    return JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/')))
  }
  catch {
    return null
  }
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  }
  catch {
    return null
  }
}

function readStoredSession(key: string): Session | null {
  const raw = storage()?.getItem(key)
  if (!raw)
    return null
  try {
    const parsed = JSON.parse(raw) as Partial<Session>
    return typeof parsed?.access_token === 'string' && typeof parsed.refresh_token === 'string' && parsed.user ? parsed as Session : null
  }
  catch {
    return null
  }
}

function captcha(token?: string) {
  return token ? { gotrue_meta_security: { captcha_token: token } } : {}
}

function withRedirect(path: string, redirectTo?: string) {
  if (!redirectTo)
    return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}redirect_to=${encodeURIComponent(redirectTo)}`
}

export function createConsoleAuthClient(options: ConsoleAuthOptions) {
  const persist = options.persistSession ?? true
  const listeners = new Set<Listener>()
  let current: Session | null = null
  let refreshing: Promise<Result<{ session: Session | null }>> | null = null
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  // Access token last confirmed by the provider; claims are only trusted after that check.
  let verifiedToken: string | null = null
  interface ClaimsPayload { claims: Record<string, any>, header: Record<string, any>, signature: string }
  // One in-flight /user check per token so concurrent getClaims share the round trip.
  let verifying: Promise<Result<ClaimsPayload | null>> | null = null
  let verifyingToken: string | null = null

  function emit(event: AuthChangeEvent, session: Session | null) {
    for (const listener of listeners) {
      try {
        listener(event, session)
      }
      catch (error) {
        console.error('Auth listener failed', error)
      }
    }
  }

  function save(session: Session | null) {
    current = session
    if (!session) {
      verifiedToken = null
      verifying = null
      verifyingToken = null
    }
    if (!persist)
      return
    const store = storage()
    if (!store)
      return
    if (session)
      store.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
    else
      store.removeItem(SESSION_STORAGE_KEY)
  }

  function load() {
    if (!persist)
      return
    const store = storage()
    if (!store)
      return
    current = readStoredSession(SESSION_STORAGE_KEY)
    if (current)
      return
    // Adopt and retire a session persisted by the former SDK client.
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index)
      if (!key || !LEGACY_SESSION_KEY.test(key))
        continue
      const legacy = readStoredSession(key)
      store.removeItem(key)
      store.removeItem(`${key}-code-verifier`)
      if (legacy) {
        save(legacy)
        return
      }
    }
  }

  function toSession(response: TokenResponse): Session {
    const expiresIn = response.expires_in ?? 3600
    const exp = decodeJwtPayload(response.access_token)?.exp
    return {
      access_token: response.access_token,
      token_type: response.token_type ?? 'bearer',
      expires_in: expiresIn,
      expires_at: response.expires_at ?? (typeof exp === 'number' ? exp : Math.floor(Date.now() / 1000) + expiresIn),
      refresh_token: response.refresh_token,
      user: response.user,
      ...(response.weak_password ? { weak_password: response.weak_password } : {}),
    } as Session
  }

  async function request<T = any>(method: string, path: string, init: { body?: unknown, token?: string | null } = {}): Promise<Result<T | null>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Client-Info': 'capgo-console' }
    if (init.token)
      headers.Authorization = `Bearer ${init.token}`
    let response: Response
    try {
      response = await fetch(`${options.baseURL}/private/console/auth/${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    }
    catch (error) {
      return { data: null, error: new ConsoleAuthError(error instanceof Error ? error.message : 'Failed to fetch', 0, 'network_error', 'AuthRetryableFetchError') }
    }
    const text = await response.text()
    let body: any = null
    if (text) {
      try {
        body = JSON.parse(text)
      }
      catch {
        body = { msg: text }
      }
    }
    if (!response.ok) {
      const message = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? `Auth request failed with status ${response.status}`
      const name = response.status >= 500 || response.status === 429 ? 'AuthRetryableFetchError' : 'AuthApiError'
      return { data: null, error: new ConsoleAuthError(String(message), response.status, body?.error_code ?? body?.code ?? undefined, name) }
    }
    return { data: body as T, error: null }
  }

  function isExpiring(session: Session, marginSeconds: number) {
    return typeof session.expires_at === 'number' && session.expires_at - Date.now() / 1000 < marginSeconds
  }

  async function refreshWith(refreshToken: string, event: AuthChangeEvent = 'TOKEN_REFRESHED'): Promise<Result<{ session: Session | null }>> {
    if (refreshing)
      return refreshing
    refreshing = (async () => {
      const result = await request<TokenResponse>('POST', 'token?grant_type=refresh_token', { body: { refresh_token: refreshToken } })
      if (result.error) {
        // The refresh token is gone (rotated elsewhere, revoked, expired): the
        // session is over. Transient failures keep the current session.
        if (result.error.name === 'AuthApiError') {
          save(null)
          emit('SIGNED_OUT', null)
        }
        return { data: { session: null }, error: result.error }
      }
      const session = toSession(result.data!)
      save(session)
      verifiedToken = session.access_token
      emit(event, session)
      return { data: { session }, error: null }
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  async function getSession(): Promise<Result<{ session: Session | null }>> {
    const session = current
    if (!session)
      return { data: { session: null }, error: null }
    if (!isExpiring(session, EXPIRY_MARGIN_SECONDS))
      return { data: { session }, error: null }
    const refreshed = await refreshWith(session.refresh_token)
    if (refreshed.error && refreshed.error.name !== 'AuthApiError')
      return { data: { session: current }, error: null }
    return refreshed
  }

  async function accessToken() {
    return (await getSession()).data.session?.access_token ?? null
  }

  function installSession(response: TokenResponse, event: AuthChangeEvent) {
    const session = toSession(response)
    save(session)
    // Tokens freshly issued by the provider are already confirmed.
    verifiedToken = session.access_token
    emit(event, session)
    return session
  }

  async function verifyAccessToken(token: string, claims: Record<string, any>): Promise<Result<ClaimsPayload | null>> {
    const payload: ClaimsPayload = { claims, header: decodeJwtHeader(token) ?? {}, signature: token.split('.')[2] ?? '' }
    if (verifiedToken === token)
      return { data: payload, error: null }
    if (verifying && verifyingToken === token)
      return verifying
    verifyingToken = token
    const pending = (async (): Promise<Result<ClaimsPayload | null>> => {
      const { error: userError } = await getUser(token)
      // Sign-out may have cleared the session while /user was in flight.
      if (current?.access_token !== token)
        return { data: null, error: sessionMissing() }
      if (userError) {
        // AuthApiError means the provider rejected the token. Transient outages
        // keep the still-valid local JWT so a brief blip does not bounce to /login.
        if (userError.name === 'AuthApiError')
          return { data: null, error: userError }
        return { data: payload, error: null }
      }
      verifiedToken = token
      return { data: payload, error: null }
    })().finally(() => {
      if (verifyingToken === token) {
        verifying = null
        verifyingToken = null
      }
    })
    verifying = pending
    return pending
  }

  async function getUser(jwt?: string): Promise<Result<{ user: User | null }>> {
    const token = jwt ?? await accessToken()
    if (!token)
      return { data: { user: null }, error: sessionMissing() }
    const result = await request<User>('GET', 'user', { token })
    if (result.error)
      return { data: { user: null }, error: result.error }
    if (!jwt && current && result.data) {
      current = { ...current, user: result.data }
      save(current)
    }
    return { data: { user: result.data }, error: null }
  }

  function startAutoRefresh() {
    if (!persist || refreshTimer || typeof setInterval !== 'function')
      return
    refreshTimer = setInterval(() => {
      if (current && isExpiring(current, AUTO_REFRESH_WINDOW_SECONDS))
        void refreshWith(current.refresh_token)
    }, AUTO_REFRESH_TICK_MS)
    if (typeof window !== 'undefined') {
      window.addEventListener('storage', (event) => {
        if (event.key !== SESSION_STORAGE_KEY)
          return
        const previous = current
        current = readStoredSession(SESSION_STORAGE_KEY)
        if (!current && previous)
          emit('SIGNED_OUT', null)
        else if (current && (!previous || previous.user?.id !== current.user?.id))
          emit('SIGNED_IN', current)
        else if (current && previous && previous.access_token !== current.access_token)
          emit('TOKEN_REFRESHED', current)
      })
    }
  }

  load()
  startAutoRefresh()

  const mfa = {
    async enroll(params: { factorType: 'totp', friendlyName?: string, issuer?: string }) {
      const result = await request<{ id: string, type: string, friendly_name?: string, totp: { qr_code: string, secret: string, uri: string } }>('POST', 'factors', {
        token: await accessToken(),
        body: { factor_type: params.factorType, friendly_name: params.friendlyName, issuer: params.issuer },
      })
      if (result.error || !result.data)
        return { data: null, error: result.error ?? sessionMissing() }
      const data = result.data
      // Same inline SVG data URL the previous client produced for <img> usage.
      if (data.totp?.qr_code && !data.totp.qr_code.startsWith('data:'))
        data.totp.qr_code = `data:image/svg+xml;utf-8,${encodeURIComponent(data.totp.qr_code)}`
      return { data, error: null }
    },
    async challenge(params: { factorId: string }) {
      const result = await request<{ id: string, type: string, expires_at: number }>('POST', `factors/${encodeURIComponent(params.factorId)}/challenge`, { token: await accessToken(), body: {} })
      return result.error ? { data: null, error: result.error } : { data: result.data!, error: null }
    },
    async verify(params: { factorId: string, challengeId: string, code: string }) {
      const result = await request<MfaVerifyResult>('POST', `factors/${encodeURIComponent(params.factorId)}/verify`, {
        token: await accessToken(),
        body: { challenge_id: params.challengeId, code: params.code },
      })
      if (result.error || !result.data)
        return { data: null, error: result.error ?? sessionMissing() }
      installSession(result.data, 'MFA_CHALLENGE_VERIFIED')
      return { data: result.data, error: null }
    },
    async unenroll(params: { factorId: string }) {
      const result = await request<{ id: string }>('DELETE', `factors/${encodeURIComponent(params.factorId)}`, { token: await accessToken() })
      return result.error ? { data: null, error: result.error } : { data: result.data!, error: null }
    },
    async listFactors() {
      const { data, error } = await getUser()
      if (error || !data.user)
        return { data: null, error: error ?? sessionMissing() }
      const all = (data.user.factors ?? []) as Factor[]
      return {
        data: {
          all,
          totp: all.filter(factor => factor.factor_type === 'totp' && factor.status === 'verified'),
          phone: all.filter(factor => factor.factor_type === 'phone' && factor.status === 'verified'),
        },
        error: null,
      }
    },
    async getAuthenticatorAssuranceLevel() {
      const { data, error } = await getSession()
      if (error)
        return { data: null, error }
      if (!data.session)
        return { data: { currentLevel: null, nextLevel: null, currentAuthenticationMethods: [] as { method: string, timestamp: number }[] }, error: null }
      const payload = decodeJwtPayload(data.session.access_token) ?? {}
      const currentLevel: 'aal1' | 'aal2' | null = payload.aal ?? null
      const verified = (data.session.user.factors ?? []).some(factor => factor.status === 'verified')
      return {
        data: {
          currentLevel,
          nextLevel: verified ? 'aal2' as const : currentLevel,
          currentAuthenticationMethods: (payload.amr ?? []) as { method: string, timestamp: number }[],
        },
        error: null,
      }
    },
  }

  return {
    getSession,
    getUser,
    async getClaims() {
      const { data, error } = await getSession()
      if (error)
        return { data: null, error }
      const token = data.session?.access_token
      if (!token)
        return { data: null, error: null }
      const claims = decodeJwtPayload(token)
      if (!claims)
        return { data: null, error: new ConsoleAuthError('Invalid session token', 400, 'bad_jwt') }
      // A session kept through a transient refresh failure must not count as signed in once its token expired.
      if (typeof claims.exp === 'number' && claims.exp <= Date.now() / 1000)
        return { data: null, error: new ConsoleAuthError('JWT has expired', 401, 'bad_jwt', 'AuthInvalidJwtError') }
      // Adopted or restored tokens are confirmed once; provider-issued ones are already marked.
      return verifyAccessToken(token, claims)
    },
    onAuthStateChange(callback: Listener) {
      listeners.add(callback)
      // Like the previous client, report the current state once, asynchronously.
      void Promise.resolve().then(() => {
        if (listeners.has(callback))
          callback('INITIAL_SESSION', current)
      })
      return { data: { subscription: { id: crypto.randomUUID(), callback, unsubscribe: () => listeners.delete(callback) } } }
    },
    async signInWithPassword(credentials: { email: string, password: string, options?: { captchaToken?: string } }) {
      const result = await request<TokenResponse>('POST', 'token?grant_type=password', {
        body: { email: credentials.email, password: credentials.password, ...captcha(credentials.options?.captchaToken) },
      })
      if (result.error || !result.data)
        return { data: { user: null, session: null }, error: result.error ?? new ConsoleAuthError('Empty auth response', 500) }
      const session = installSession(result.data, 'SIGNED_IN')
      return { data: { user: session.user, session, weakPassword: result.data.weak_password }, error: null }
    },
    async signUp(credentials: { email: string, password: string, options?: { captchaToken?: string, data?: Record<string, unknown>, emailRedirectTo?: string } }) {
      const result = await request<TokenResponse | User>('POST', withRedirect('signup', credentials.options?.emailRedirectTo), {
        body: { email: credentials.email, password: credentials.password, data: credentials.options?.data ?? {}, ...captcha(credentials.options?.captchaToken) },
      })
      if (result.error || !result.data)
        return { data: { user: null, session: null }, error: result.error ?? new ConsoleAuthError('Empty auth response', 500) }
      if ('access_token' in result.data) {
        const session = installSession(result.data, 'SIGNED_IN')
        return { data: { user: session.user, session }, error: null }
      }
      return { data: { user: result.data, session: null }, error: null }
    },
    async signOut(params: { scope?: 'global' | 'local' | 'others' } = {}) {
      const scope = params.scope ?? 'global'
      const token = await accessToken()
      let error: ConsoleAuthError | null = null
      if (token) {
        const result = await request('POST', `logout?scope=${scope}`, { token, body: {} })
        // A session the server already forgot is as signed out as it gets.
        if (result.error && ![401, 403, 404].includes(result.error.status))
          error = result.error
      }
      // Signing out is the user's decision: the local session goes even when the
      // provider could not be reached, so a reload never restores it.
      if (scope !== 'others') {
        save(null)
        emit('SIGNED_OUT', null)
      }
      return { error }
    },
    async setSession(tokens: { access_token: string, refresh_token: string }) {
      if (!tokens.access_token || !tokens.refresh_token)
        return { data: { user: null, session: null }, error: sessionMissing() }
      const exp = decodeJwtPayload(tokens.access_token)?.exp
      if (typeof exp === 'number' && exp - Date.now() / 1000 < EXPIRY_MARGIN_SECONDS) {
        const refreshed = await refreshWith(tokens.refresh_token, 'SIGNED_IN')
        return { data: { user: refreshed.data.session?.user ?? null, session: refreshed.data.session }, error: refreshed.error }
      }
      const { data, error } = await getUser(tokens.access_token)
      if (error || !data.user)
        return { data: { user: null, session: null }, error: error ?? sessionMissing() }
      const session = installSession({ ...tokens, user: data.user, expires_in: typeof exp === 'number' ? Math.max(0, Math.floor(exp - Date.now() / 1000)) : undefined, expires_at: typeof exp === 'number' ? exp : undefined }, 'SIGNED_IN')
      return { data: { user: session.user, session }, error: null }
    },
    async refreshSession(tokens?: { refresh_token: string }) {
      const refreshToken = tokens?.refresh_token ?? current?.refresh_token
      if (!refreshToken)
        return { data: { user: null, session: null }, error: sessionMissing() }
      const refreshed = await refreshWith(refreshToken)
      return { data: { user: refreshed.data.session?.user ?? null, session: refreshed.data.session }, error: refreshed.error }
    },
    async exchangeCodeForSession(authCode: string) {
      const store = storage()
      const verifier = store?.getItem(CODE_VERIFIER_STORAGE_KEY) ?? ''
      const result = await request<TokenResponse>('POST', 'token?grant_type=pkce', { body: { auth_code: authCode, code_verifier: verifier } })
      store?.removeItem(CODE_VERIFIER_STORAGE_KEY)
      if (result.error || !result.data)
        return { data: { user: null, session: null }, error: result.error ?? new ConsoleAuthError('Empty auth response', 500) }
      const session = installSession(result.data, 'SIGNED_IN')
      return { data: { user: session.user, session }, error: null }
    },
    async updateUser(attributes: { email?: string, password?: string, current_password?: string, data?: Record<string, unknown>, nonce?: string }, options: { emailRedirectTo?: string } = {}) {
      const token = await accessToken()
      if (!token)
        return { data: { user: null }, error: sessionMissing() }
      const result = await request<User>('PUT', withRedirect('user', options.emailRedirectTo), { token, body: attributes })
      if (result.error || !result.data)
        return { data: { user: null }, error: result.error ?? sessionMissing() }
      if (current) {
        current = { ...current, user: result.data }
        save(current)
        emit('USER_UPDATED', current)
      }
      return { data: { user: result.data }, error: null }
    },
    async resetPasswordForEmail(email: string, options: { redirectTo?: string, captchaToken?: string } = {}) {
      const result = await request('POST', withRedirect('recover', options.redirectTo), { body: { email, ...captcha(options.captchaToken) } })
      return { data: result.error ? null : {}, error: result.error }
    },
    async resend(params: { type: 'signup' | 'email_change', email: string, options?: { captchaToken?: string, emailRedirectTo?: string } }) {
      const result = await request<{ message_id?: string }>('POST', withRedirect('resend', params.options?.emailRedirectTo), {
        body: { email: params.email, type: params.type, ...captcha(params.options?.captchaToken) },
      })
      return { data: { user: null, session: null, messageId: result.data?.message_id }, error: result.error }
    },
    async signInWithOtp(params: { email: string, options?: { shouldCreateUser?: boolean, captchaToken?: string, emailRedirectTo?: string, data?: Record<string, unknown> } }) {
      const result = await request<{ message_id?: string }>('POST', withRedirect('otp', params.options?.emailRedirectTo), {
        body: { email: params.email, data: params.options?.data ?? {}, create_user: params.options?.shouldCreateUser ?? true, ...captcha(params.options?.captchaToken) },
      })
      return { data: { user: null, session: null, messageId: result.data?.message_id }, error: result.error }
    },
    async signInWithSSO(params: { domain?: string, providerId?: string, options?: { redirectTo?: string, captchaToken?: string, skipBrowserRedirect?: boolean } }) {
      const result = await request<{ url: string }>('POST', 'sso', {
        body: {
          ...(params.providerId ? { provider_id: params.providerId } : {}),
          ...(params.domain ? { domain: params.domain } : {}),
          redirect_to: params.options?.redirectTo,
          skip_http_redirect: true,
          ...captcha(params.options?.captchaToken),
        },
      })
      if (result.error || !result.data?.url)
        return { data: null, error: result.error ?? new ConsoleAuthError('SSO provider returned no URL', 500) }
      if (!params.options?.skipBrowserRedirect && typeof window !== 'undefined')
        window.location.assign(result.data.url)
      return { data: { url: result.data.url }, error: null }
    },
    mfa,
    /** Test and teardown hook: stop timers and forget listeners. */
    dispose() {
      if (refreshTimer)
        clearInterval(refreshTimer)
      refreshTimer = undefined
      listeners.clear()
    },
  }
}
