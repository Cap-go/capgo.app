import type { AuthChangeEvent, AuthError, ConsoleDataClient, ConsoleQuery, Factor, RealtimeChannel, Session, User } from '../../supabase/functions/_backend/utils/console_contract'
import type { Database } from '~/types/supabase.types'
import { ssoClient } from '@better-auth/sso/client'
import { createAuthClient } from 'better-auth/client'
import { emailOTPClient, twoFactorClient } from 'better-auth/client/plugins'
import { toSvg } from 'better-qr'

export type { AuthChangeEvent, AuthError, Factor, RealtimeChannel, Session, User }

export class FunctionsHttpError extends Error {
  code?: string
  constructor(public context: Response) {
    super('Capgo API returned an error')
    this.name = 'FunctionsHttpError'
  }
}

export class FunctionsFetchError extends Error {
  code?: string
  constructor(public context: unknown) {
    super('Failed to send a request to the Capgo API', { cause: context })
    this.name = 'FunctionsFetchError'
  }
}

function normalizeAuth<T>(result: { data: T, error: { message?: string, code?: string, status?: number } | null }) {
  const error = result.error
    ? Object.assign(new Error(result.error.message ?? 'Authentication failed'), { name: 'AuthApiError', code: result.error.code, status: result.error.status })
    : null
  return { data: result.data, error }
}

const baseURL = ((import.meta.env.VITE_API_HOST as string | undefined) ?? '').replace(/\/$/, '')
const TOKEN_KEY = 'capgo.console.session'

export function createConsoleClient(_host?: string, _key?: string, options?: { auth?: { persistSession?: boolean, autoRefreshToken?: boolean, detectSessionInUrl?: boolean } }) {
  const persist = options?.auth?.persistSession !== false
  let token: string | null = persist ? localStorage.getItem(TOKEN_KEY) : null
  let pendingMfa = false
  const listeners = new Set<(event: AuthChangeEvent, session: Session | null) => void>()

  const betterAuth = createAuthClient({
    baseURL: `${baseURL}/auth`,
    plugins: [twoFactorClient(), emailOTPClient(), ssoClient()],
    fetchOptions: {
      credentials: persist ? 'include' : 'omit',
      auth: { type: 'Bearer', token: () => token?.replace(/^capgo_session_/, '') ?? '' },
      onSuccess(ctx) {
        const received = ctx.response.headers.get('set-auth-token')
        if (received) {
          saveToken(`capgo_session_${received}`)
          // TOTP enrollment rotates the cookie even when the response body
          // still contains the previous session token.
          if (ctx.data && typeof ctx.data === 'object' && 'token' in ctx.data)
            ctx.data.token = received
        }
      },
    },
  })

  function saveToken(value: string | null) {
    token = value
    if (persist) {
      if (value)
        localStorage.setItem(TOKEN_KEY, value)
      else
        localStorage.removeItem(TOKEN_KEY)
    }
  }

  async function invoke<T = any>(path: string, opts: { method?: string, body?: any, headers?: Record<string, string>, signal?: AbortSignal } = {}) {
    try {
      const headers = new Headers(opts.headers)
      if (token && !headers.has('Authorization'))
        headers.set('Authorization', `Bearer ${token}`)
      const binary = opts.body instanceof Blob || opts.body instanceof FormData || opts.body instanceof ArrayBuffer
      if (opts.body != null && !binary && !headers.has('Content-Type'))
        headers.set('Content-Type', 'application/json')
      const response = await fetch(`${baseURL}/${path.replace(/^\//, '')}`, {
        method: opts.method ?? 'POST',
        credentials: persist && path.replace(/^\//, '').startsWith('auth/') ? 'include' : 'omit',
        headers,
        signal: opts.signal,
        body: opts.body == null ? undefined : binary || typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
      })
      if (!response.ok)
        return { data: null, error: new FunctionsHttpError(response) }
      return { data: await response.json() as T, error: null }
    }
    catch (error) {
      return { data: null, error: new FunctionsFetchError(error) }
    }
  }

  async function getSession() {
    const result = await invoke<{ session: Session | null }>('auth/console-session', { method: 'GET' })
    const session = result.data?.session ?? null
    if (session)
      saveToken(session.access_token)
    else if (!result.error)
      saveToken(null)
    return { data: { session, user: session?.user ?? null }, error: result.error }
  }

  async function authResult(result: { data: any, error: any }, event: AuthChangeEvent = 'SIGNED_IN') {
    if (result.error)
      return normalizeAuth(result)
    if (result.data?.twoFactorRedirect) {
      pendingMfa = true
      saveToken(null)
      return { data: { user: null, session: null }, error: null }
    }
    if (result.data?.token)
      saveToken(`capgo_session_${result.data.token}`)
    const sessionResult = await getSession()
    const session = sessionResult.data.session
    for (const listener of listeners)
      listener(event, session)
    return { data: { session, user: session?.user ?? result.data?.user ?? null }, error: sessionResult.error }
  }

  const auth = {
    getSession,
    async getClaims() {
      const result = await getSession()
      return { data: result.data.session ? { claims: { sub: result.data.session.user.id, email: result.data.session.user.email, session_id: result.data.session.access_token } } : null, error: result.error }
    },
    onAuthStateChange(listener: (event: AuthChangeEvent, session: Session | null) => void) {
      listeners.add(listener)
      void getSession().then(result => listener('INITIAL_SESSION', result.data.session))
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } }
    },
    async signInWithPassword(body: { email: string, password: string, options?: { captchaToken?: string } }) {
      return authResult(await betterAuth.signIn.email({ email: body.email, password: body.password, fetchOptions: { headers: { 'x-captcha-response': body.options?.captchaToken ?? '' } } }))
    },
    async signUp(body: { email: string, password: string, options?: { captchaToken?: string, data?: { first_name?: string, last_name?: string, opt_for_newsletters?: boolean } } }) {
      const request = { email: body.email, password: body.password, name: `${body.options?.data?.first_name ?? ''} ${body.options?.data?.last_name ?? ''}`.trim() || body.email, firstName: body.options?.data?.first_name, lastName: body.options?.data?.last_name, optForNewsletters: body.options?.data?.opt_for_newsletters ?? false, callbackURL: `${location.origin}/login`, fetchOptions: { headers: { 'x-captcha-response': body.options?.captchaToken ?? '' } } }
      const result = await betterAuth.signUp.email(request)
      return normalizeAuth({ data: { user: result.data?.user as unknown as User | undefined, session: null }, error: result.error })
    },
    async signOut(options?: { scope?: 'others' | 'global' | 'local' }) {
      if (options?.scope === 'others')
        return normalizeAuth(await betterAuth.revokeOtherSessions())
      if (!options?.scope || options.scope === 'global') {
        const revoked = await betterAuth.revokeSessions()
        if (revoked.error)
          return normalizeAuth(revoked)
      }
      const result = await betterAuth.signOut()
      if (!result.error) {
        saveToken(null)
        for (const listener of listeners)
          listener('SIGNED_OUT', null)
      }
      return normalizeAuth(result)
    },
    async updateUser(body: { email?: string, password?: string, current_password?: string }) {
      if (body.password) {
        return normalizeAuth(await betterAuth.changePassword({ currentPassword: body.current_password ?? '', newPassword: body.password, revokeOtherSessions: true }))
      }
      return normalizeAuth(await betterAuth.changeEmail({ newEmail: body.email! }))
    },
    async resetPasswordForEmail(email: string, options: { redirectTo?: string, captchaToken?: string } = {}) {
      return normalizeAuth(await betterAuth.requestPasswordReset({ email, redirectTo: options.redirectTo, fetchOptions: { headers: { 'x-captcha-response': options.captchaToken ?? '' } } }))
    },
    async resend(body: { email: string, type: string, options?: { captchaToken?: string } }) {
      return normalizeAuth(await betterAuth.sendVerificationEmail({ email: body.email, callbackURL: `${location.origin}/login`, fetchOptions: { headers: { 'x-captcha-response': body.options?.captchaToken ?? '' } } }))
    },
    async signInWithOtp(body: { email: string, options?: unknown }) {
      return normalizeAuth(await betterAuth.emailOtp.sendVerificationOtp({ email: body.email, type: 'email-verification' }))
    },
    async signInWithSSO(body: { providerId?: string, domain?: string, options?: { redirectTo?: string, captchaToken?: string } }) {
      const result = await betterAuth.signIn.sso({ providerId: body.providerId, domain: body.domain, callbackURL: body.options?.redirectTo ?? `${location.origin}/sso-callback` })
      return normalizeAuth({ data: result.data ? { ...result.data, url: result.data.url ?? null } : null, error: result.error })
    },
    async setSession(body: { access_token: string, refresh_token: string }) {
      if (!body.access_token.startsWith('capgo_session_'))
        return { data: { session: null }, error: new Error('This session requires migration. Please sign in again.') }
      saveToken(body.access_token)
      return getSession()
    },
    async refreshSession(body?: { refresh_token: string }) {
      if (body)
        saveToken(body.refresh_token)
      return getSession()
    },
    async exchangeCodeForSession(_code: string) {
      saveToken(null)
      return getSession()
    },
    mfa: {
      async getAuthenticatorAssuranceLevel() {
        const result = await getSession()
        return { data: { currentLevel: (result.data.session as (Session & { mfa_verified?: boolean }) | null)?.mfa_verified ? 'aal2' : 'aal1', nextLevel: pendingMfa || result.data.session?.user.factors?.length ? 'aal2' : 'aal1' }, error: result.error }
      },
      async listFactors() {
        const result = await getSession()
        const all = result.data.session?.user.factors ?? (pendingMfa ? [{ id: 'pending', factor_type: 'totp' as const, status: 'verified' as const, created_at: '', updated_at: '' }] : [])
        return { data: { all, totp: all, phone: [] }, error: result.error }
      },
      async challenge(body: { factorId: string }) {
        return { data: { id: body.factorId }, error: null as Error | null }
      },
      async verify(body: { factorId: string, challengeId: string, code: string }) {
        const result = await betterAuth.twoFactor.verifyTotp({ code: body.code })
        if (!result.error)
          pendingMfa = false
        return authResult(result)
      },
      async enroll(body: { factorType: string, password?: string }): Promise<{ data: { id: string, totp: { uri: string, qr_code: string } }, error: null } | { data: null, error: Error }> {
        const result = await betterAuth.twoFactor.enable({ password: body.password ?? '' })
        if (result.error || result.data?.method !== 'totp')
          return { data: null, error: normalizeAuth(result).error ?? new Error('Cannot enroll TOTP') }
        return { data: { id: 'totp', totp: { uri: result.data.totpURI, qr_code: `data:image/svg+xml,${encodeURIComponent(toSvg(result.data.totpURI))}` } }, error: null }
      },
      async unenroll(body: { factorId: string, password?: string }) {
        return normalizeAuth(await betterAuth.twoFactor.disable({ password: body.password ?? '' }))
      },
    },
  }

  function query(kind: ConsoleQuery['kind'], name: string, args: unknown[]) {
    const request: ConsoleQuery = { kind, name, args, operations: [] }
    let execution: Promise<unknown> | undefined
    let signal: AbortSignal | undefined
    const builder: any = new Proxy({}, {
      get(_target, method: string) {
        if (method === 'then') {
          execution ??= invoke<any>('private/console/query', { body: request, signal }).then((result) => {
            if (result.error)
              return { data: null, error: result.error, count: null }
            const value = result.data
            return { ...value, error: value.error ? Object.assign(new Error(value.error.message), value.error) : null }
          })
          return execution.then.bind(execution)
        }
        if (method === 'abortSignal') {
          return (value: AbortSignal) => {
            signal = value
            return builder
          }
        }
        return (...operationArgs: unknown[]) => {
          request.operations.push({ method, args: operationArgs })
          return builder
        }
      },
    })
    return builder
  }

  function channel(name: string): RealtimeChannel {
    const orgId = name.replace(/^cli-events:org:/, '')
    let handler: (message: { payload: unknown }) => void = () => {}
    const controller = new AbortController()
    const subscription = {
      on(_kind: string, _filter: unknown, callback: (message: { payload: unknown }) => void) {
        handler = callback
        return subscription
      },
      subscribe(callback: (status: string) => void) {
        void (async () => {
          while (!controller.signal.aborted) {
            try {
              const response = await fetch(`${baseURL}/private/console/events?org_id=${encodeURIComponent(orgId)}`, {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
                credentials: 'omit',
                signal: controller.signal,
              })
              if (!response.ok || !response.body)
                throw new Error('Cannot subscribe to console events')
              callback('SUBSCRIBED')
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              let buffer = ''
              try {
                for (;;) {
                  const { value, done } = await reader.read()
                  if (done)
                    break
                  buffer += decoder.decode(value, { stream: true })
                  let end: number
                  while ((end = buffer.indexOf('\n\n')) >= 0) {
                    const event = buffer.slice(0, end)
                    buffer = buffer.slice(end + 2)
                    if (event.startsWith('data: '))
                      handler({ payload: JSON.parse(event.slice(6)) })
                  }
                }
              }
              finally {
                reader.releaseLock()
              }
            }
            catch {
              if (!controller.signal.aborted)
                callback('CHANNEL_ERROR')
            }
            if (!controller.signal.aborted)
              await new Promise(resolve => setTimeout(resolve, 1000))
          }
          callback('CLOSED')
        })()
        return subscription
      },
      track: async (_presence: unknown) => 'ok',
      unsubscribe: async () => {
        controller.abort()
        return 'ok'
      },
    }
    return subscription as unknown as RealtimeChannel
  }

  if (persist && typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key !== TOKEN_KEY)
        return
      token = event.newValue
      void getSession().then((result) => {
        for (const listener of listeners)
          listener(result.data.session ? 'SIGNED_IN' : 'SIGNED_OUT', result.data.session)
      })
    })
  }

  return {
    auth,
    betterAuth,
    from: ((name: string) => query('table', name, [])) as ConsoleDataClient['from'],
    rpc: ((name: string, ...args: unknown[]) => query('rpc', name, args)) as ConsoleDataClient['rpc'],
    functions: { invoke },
    channel,
    removeChannel: (subscription: RealtimeChannel) => subscription.unsubscribe(),
    storage: {
      from(bucket: string) {
        if (bucket !== 'images')
          throw new Error('Unsupported console storage bucket')
        async function storageResult<T>(path: string, options: Parameters<typeof invoke>[1]) {
          const result = await invoke<{ data: T | null, error: Error | null }>(path, options)
          return result.error ? { data: null, error: result.error } : result.data!
        }
        return {
          createSignedUrl: (path: string, expiresIn: number) => storageResult<{ signedUrl: string }>('private/console/images/sign', { body: { path, expiresIn } }),
          remove: (paths: string[]) => storageResult<unknown>('private/console/images/remove', { body: { paths } }),
          upload: (path: string, file: Blob | ArrayBuffer, options?: { contentType?: string, upsert?: boolean }) => storageResult<{ path: string }>('private/console/images/upload', {
            body: file,
            headers: { 'x-image-path': path, 'x-image-upsert': String(options?.upsert ?? false), 'Content-Type': options?.contentType ?? 'application/octet-stream' },
          }),
        }
      },
    },
  }
}

export type ConsoleClient<T = Database> = ConsoleDataClient<T> & Pick<ReturnType<typeof createConsoleClient>, 'auth' | 'betterAuth' | 'functions' | 'storage' | 'channel' | 'removeChannel'>
