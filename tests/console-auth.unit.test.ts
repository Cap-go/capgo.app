import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleAuthClient, SESSION_STORAGE_KEY } from '../src/services/consoleAuth'
import { fakeJwt, memoryStorage } from './console-auth-fixtures'

const fetchMock = vi.fn()
const BASE = 'https://api.example.com'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function session(overrides: Record<string, unknown> = {}, expiresInSeconds = 3600) {
  return {
    access_token: fakeJwt({ sub: 'user-1', email: 'user@example.com' }, expiresInSeconds),
    refresh_token: 'refresh-1',
    expires_in: expiresInSeconds,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSeconds,
    token_type: 'bearer',
    user: { id: 'user-1', email: 'user@example.com', factors: [] },
    ...overrides,
  }
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1)!
  return { url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined, headers: new Headers(init?.headers) }
}

let storage: Storage
beforeEach(() => {
  storage = memoryStorage()
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('console auth client', () => {
  it('signs in through the API auth relay and persists the session', async () => {
    fetchMock.mockResolvedValueOnce(json(session()))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    const events: string[] = []
    auth.onAuthStateChange(event => events.push(event))

    const result = await auth.signInWithPassword({ email: 'user@example.com', password: 'pw', options: { captchaToken: 'cap' } })
    expect(result.error).toBeNull()
    expect(result.data.session?.user.id).toBe('user-1')
    const { url, body, headers } = lastCall()
    expect(url).toBe(`${BASE}/private/console/auth/token?grant_type=password`)
    expect(body).toEqual({ email: 'user@example.com', password: 'pw', gotrue_meta_security: { captcha_token: 'cap' } })
    expect(headers.has('Authorization')).toBe(false)
    expect(JSON.parse(storage.getItem(SESSION_STORAGE_KEY)!).user.id).toBe('user-1')
    await Promise.resolve()
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_IN'])
    // A token just issued by the provider is already confirmed; no extra /user round trip.
    expect((await auth.getClaims()).data?.claims.sub).toBe('user-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    auth.dispose()
  })

  it('maps auth provider errors to the codes the console matches on', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    const result = await auth.signInWithPassword({ email: 'a', password: 'b' })
    expect(result.data).toEqual({ user: null, session: null })
    expect(result.error).toMatchObject({ name: 'AuthApiError', status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' })
    auth.dispose()
  })

  it('refreshes an expiring session before handing it out and signs out when the refresh token is dead', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session({}, 5)))
    fetchMock.mockResolvedValueOnce(json(session({ refresh_token: 'refresh-2' })))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    const events: string[] = []
    auth.onAuthStateChange(event => events.push(event))

    const first = await auth.getSession()
    expect(first.data.session?.refresh_token).toBe('refresh-2')
    const { url, body } = lastCall()
    expect(url).toBe(`${BASE}/private/console/auth/token?grant_type=refresh_token`)
    expect(body).toEqual({ refresh_token: 'refresh-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await auth.getSession()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session({}, 5)))
    const stale = createConsoleAuthClient({ baseURL: BASE })
    fetchMock.mockResolvedValueOnce(json({ error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }, 400))
    const dead = await stale.getSession()
    expect(dead.data.session).toBeNull()
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull()

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session({}, 5)))
    const offline = createConsoleAuthClient({ baseURL: BASE })
    // A network drop keeps the current session instead of logging the user out.
    expect((await offline.getSession()).data.session?.refresh_token).toBe('refresh-1')
    auth.dispose()
    stale.dispose()
    offline.dispose()
  })

  it('adopts a session persisted by the previous SDK client once', async () => {
    storage.setItem('sb-sb-auth-token', JSON.stringify(session()))
    storage.setItem('sb-sb-auth-token-code-verifier', 'verifier')
    const auth = createConsoleAuthClient({ baseURL: BASE })
    expect((await auth.getSession()).data.session?.user.id).toBe('user-1')
    expect(storage.getItem('sb-sb-auth-token')).toBeNull()
    expect(storage.getItem('sb-sb-auth-token-code-verifier')).toBeNull()
    expect(storage.getItem(SESSION_STORAGE_KEY)).not.toBeNull()
    auth.dispose()
  })

  it('signs out through the relay and clears local state even when the server already forgot the session', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()))
    fetchMock.mockResolvedValueOnce(json({ msg: 'invalid JWT' }, 401))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    const events: string[] = []
    auth.onAuthStateChange(event => events.push(event))
    expect((await auth.signOut()).error).toBeNull()
    const { url, headers } = lastCall()
    expect(url).toBe(`${BASE}/private/console/auth/logout?scope=global`)
    expect(headers.get('Authorization')).toMatch(/^Bearer /)
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    expect(events).toContain('SIGNED_OUT')
    auth.dispose()
  })

  it('clears the local session on sign-out even when the provider is unreachable', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()))
    const offline = createConsoleAuthClient({ baseURL: BASE })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await offline.signOut()).error?.name).toBe('AuthRetryableFetchError')
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull()
    offline.dispose()
  })

  it('keeps claims during a transient /user outage and rejects only AuthApiError', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    expect((await auth.getClaims()).data?.claims.sub).toBe('user-1')
    fetchMock.mockResolvedValueOnce(json({ msg: 'invalid JWT' }, 401))
    const rejected = await auth.getClaims()
    expect(rejected.data).toBeNull()
    expect(rejected.error?.name).toBe('AuthApiError')
    auth.dispose()
  })

  it('does not re-verify a token after sign-out clears the in-flight check', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    let resolveUser!: (value: Response) => void
    fetchMock
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveUser = resolve }))
      .mockResolvedValueOnce(json({}))
    const claimsPromise = auth.getClaims()
    expect((await auth.signOut()).error).toBeNull()
    resolveUser(json({ id: 'user-1' }))
    const late = await claimsPromise
    expect(late.data).toBeNull()
    expect(late.error?.name).toBe('AuthSessionMissingError')
    auth.dispose()
  })

  it('installs a session from tokens by loading the user, like the previous client', async () => {
    const tokens = session()
    fetchMock.mockResolvedValueOnce(json(tokens.user))
    const auth = createConsoleAuthClient({ baseURL: BASE })
    const result = await auth.setSession({ access_token: tokens.access_token, refresh_token: 'handoff-refresh' })
    expect(result.error).toBeNull()
    expect(result.data.session?.refresh_token).toBe('handoff-refresh')
    expect(result.data.session?.expires_at).toBeGreaterThan(Date.now() / 1000)
    const { url, headers } = lastCall()
    expect(url).toBe(`${BASE}/private/console/auth/user`)
    expect(headers.get('Authorization')).toBe(`Bearer ${tokens.access_token}`)
    auth.dispose()
  })

  it('drives MFA through the factor endpoints and reports assurance from the token', async () => {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session()))
    const auth = createConsoleAuthClient({ baseURL: BASE })

    fetchMock.mockResolvedValueOnce(json({ id: 'factor-1', type: 'totp', totp: { qr_code: '<svg/>', secret: 's', uri: 'otpauth://x' } }))
    const enrolled = await auth.mfa.enroll({ factorType: 'totp', friendlyName: 'phone' })
    expect(lastCall().url).toBe(`${BASE}/private/console/auth/factors`)
    expect(lastCall().body).toEqual({ factor_type: 'totp', friendly_name: 'phone' })
    expect(enrolled.data?.totp.qr_code).toBe('data:image/svg+xml;utf-8,%3Csvg%2F%3E')

    fetchMock.mockResolvedValueOnce(json({ id: 'challenge-1', type: 'totp', expires_at: 1 }))
    await auth.mfa.challenge({ factorId: 'factor-1' })
    expect(lastCall().url).toBe(`${BASE}/private/console/auth/factors/factor-1/challenge`)

    const verified = session({ access_token: fakeJwt({ sub: 'user-1', aal: 'aal2' }), user: { id: 'user-1', factors: [{ id: 'factor-1', factor_type: 'totp', status: 'verified' }] } })
    fetchMock.mockResolvedValueOnce(json(verified))
    const result = await auth.mfa.verify({ factorId: 'factor-1', challengeId: 'challenge-1', code: '123456' })
    expect(result.error).toBeNull()
    expect(lastCall().body).toEqual({ challenge_id: 'challenge-1', code: '123456' })
    const assurance = await auth.mfa.getAuthenticatorAssuranceLevel()
    expect(assurance.data).toMatchObject({ currentLevel: 'aal2', nextLevel: 'aal2' })

    fetchMock.mockResolvedValueOnce(json(verified.user))
    const factors = await auth.mfa.listFactors()
    expect(factors.data?.totp.map(factor => factor.id)).toEqual(['factor-1'])

    fetchMock.mockResolvedValueOnce(json({ id: 'factor-1' }))
    await auth.mfa.unenroll({ factorId: 'factor-1' })
    expect(lastCall().init.method).toBe('DELETE')
    auth.dispose()
  })

  it('sends recovery, resend, OTP and SSO requests with redirects and captcha like the previous client', async () => {
    const auth = createConsoleAuthClient({ baseURL: BASE })
    fetchMock.mockImplementation(async () => json({}))
    await auth.resetPasswordForEmail('user@example.com', { redirectTo: 'https://console.example/reset', captchaToken: 'cap' })
    expect(lastCall().url).toBe(`${BASE}/private/console/auth/recover?redirect_to=https%3A%2F%2Fconsole.example%2Freset`)
    expect(lastCall().body).toEqual({ email: 'user@example.com', gotrue_meta_security: { captcha_token: 'cap' } })

    await auth.resend({ type: 'signup', email: 'user@example.com' })
    expect(lastCall().url).toBe(`${BASE}/private/console/auth/resend`)
    expect(lastCall().body).toEqual({ email: 'user@example.com', type: 'signup' })

    await auth.signInWithOtp({ email: 'user@example.com', options: { shouldCreateUser: false } })
    expect(lastCall().body).toEqual({ email: 'user@example.com', data: {}, create_user: false })

    fetchMock.mockResolvedValueOnce(json({ url: 'https://idp.example/saml' }))
    const sso = await auth.signInWithSSO({ domain: 'example.com', options: { redirectTo: 'https://console.example/sso-callback', skipBrowserRedirect: true } })
    expect(sso.data?.url).toBe('https://idp.example/saml')
    expect(lastCall().body).toEqual({ domain: 'example.com', redirect_to: 'https://console.example/sso-callback', skip_http_redirect: true })
    auth.dispose()
  })
})
