import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleClient } from '../src/services/consoleClient'

const { signup, signin, revoke, signout, sendOtp } = vi.hoisted(() => ({ signup: vi.fn(), signin: vi.fn(), revoke: vi.fn(), signout: vi.fn(), sendOtp: vi.fn() }))
vi.mock('better-auth/client', () => ({ createAuthClient: () => ({ signUp: { email: signup }, signIn: { email: signin }, revokeSessions: revoke, signOut: signout, emailOtp: { sendVerificationOtp: sendOtp } }) }))

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://console.example.com' })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('console registration session', () => {
  it('preserves the console invalid-credentials error contract', async () => {
    signin.mockResolvedValue({ data: null, error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password', status: 401 } })
    const client = createConsoleClient(undefined, undefined, { auth: { persistSession: false } })
    const result = await client.auth.signInWithPassword({ email: 'wrong@example.com', password: 'wrongpass' })
    expect(result.error).toMatchObject({ code: 'invalid_credentials', message: 'Invalid login credentials', status: 401 })
  })

  it('notifies the console store when signup creates an authenticated session', async () => {
    const session = { access_token: 'capgo_session_test-token', user: { id: 'fixture-user' } }
    signup.mockResolvedValue({ data: { token: 'test-token', user: session.user }, error: null })
    const request = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ session }), { headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', request)
    const client = createConsoleClient(undefined, undefined, { auth: { persistSession: false } })
    const listener = vi.fn()
    client.auth.onAuthStateChange(listener)
    const result = await client.auth.signUp({ email: 'registration@example.com', password: 'Test-password1!', options: { data: {} } })
    expect(result.data.session).toEqual(session)
    expect(listener).toHaveBeenCalledWith('SIGNED_IN', session)
    expect(new Headers(request.mock.calls.at(-1)?.[1]?.headers).get('authorization')).toBe('Bearer capgo_session_test-token')
  })

  it('uses the new signup API cookie instead of a previously stored account token', async () => {
    vi.stubGlobal('location', { origin: 'https://console.example.com', search: '?registered=complete' })
    const storage = new Map([['capgo.console.session', 'capgo_session_previous-user']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    const session = { access_token: 'capgo_session_new-user', user: { id: 'new-user' } }
    const request = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ session })))
    vi.stubGlobal('fetch', request)
    const client = createConsoleClient()
    expect((await client.auth.getSession()).data.session).toEqual(session)
    expect(new Headers(request.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
    expect(storage.get('capgo.console.session')).toBe(session.access_token)
  })

  it('leaves an unconfirmed account without a session', async () => {
    signup.mockResolvedValue({ data: { token: null, user: { id: 'fixture-user' } }, error: null })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ session: null }))))
    const client = createConsoleClient(undefined, undefined, { auth: { persistSession: false } })
    const listener = vi.fn()
    client.auth.onAuthStateChange(listener)
    const result = await client.auth.signUp({ email: 'registration@example.com', password: 'Test-password1!', options: { data: {} } })
    expect(result.data.session).toBeNull()
    expect(listener.mock.calls.some(([event]) => event === 'SIGNED_IN')).toBe(false)
  })
})

describe('console auth failure isolation', () => {
  function browserStorage() {
    const storage = new Map([['capgo.console.session', 'capgo_session_previous-user']])
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) })
    vi.stubGlobal('window', { addEventListener: vi.fn() })
    return storage
  }

  it('does not restore a cookie session after failed remote logout and reload', async () => {
    const storage = browserStorage()
    revoke.mockResolvedValue({ data: null, error: { message: 'Revocation unavailable' } })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const client = createConsoleClient()
    expect((await client.auth.signOut()).error?.message).toBe('Revocation unavailable')
    expect(storage.get('capgo.console.session')).toBe('')
    expect((await client.auth.getSession()).data.session).toBeNull()
    expect((await createConsoleClient().auth.getSession()).data.session).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('ignores a session response that finishes after local logout', async () => {
    browserStorage()
    revoke.mockResolvedValue({ data: null, error: { message: 'Revocation unavailable' } })
    let complete!: (response: Response) => void
    const request = vi.fn(() => new Promise<Response>((resolve) => { complete = resolve }))
    vi.stubGlobal('fetch', request)
    const client = createConsoleClient()
    const lookup = client.auth.getSession()
    await client.auth.signOut()
    complete(new Response(JSON.stringify({ session: { access_token: 'capgo_session_old-user', user: { id: 'old-user' } } })))
    expect((await lookup).data.session).toBeNull()
    expect((await createConsoleClient().auth.getSession()).data.session).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('reloads the signup cookie instead of committing an old in-flight account', async () => {
    const storage = browserStorage()
    let complete!: (response: Response) => void
    const newSession = { access_token: 'capgo_session_new-user', user: { id: 'new-user' } }
    const request = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { complete = resolve })).mockResolvedValue(new Response(JSON.stringify({ session: newSession })))
    vi.stubGlobal('fetch', request)
    const client = createConsoleClient()
    const lookup = client.auth.getSession()
    client.auth.clearSession()
    complete(new Response(JSON.stringify({ session: { access_token: 'capgo_session_old-user', user: { id: 'old-user' } } })))
    expect((await lookup).data.session).toEqual(newSession)
    expect(storage.get('capgo.console.session')).toBe(newSession.access_token)
    expect(new Headers(request.mock.calls[1][1]?.headers).has('authorization')).toBe(false)
  })

  it('clears an existing SPA bearer before accepting a signup cookie', async () => {
    browserStorage()
    const request = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(JSON.stringify({ session: null })))
    vi.stubGlobal('fetch', request)
    const client = createConsoleClient()
    client.auth.clearSession()
    await client.auth.getSession()
    expect(new Headers(request.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
  })

  it('passes the email OTP CAPTCHA to Better Auth', async () => {
    sendOtp.mockResolvedValue({ data: { success: true }, error: null })
    await createConsoleClient(undefined, undefined, { auth: { persistSession: false } }).auth.signInWithOtp({ email: 'otp@example.com', options: { captchaToken: 'fixture-captcha' } })
    expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({ fetchOptions: { headers: { 'x-captcha-response': 'fixture-captcha' } } }))
  })

  it('preserves backend CAPTCHA error codes for account reauthentication', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_captcha' }), { status: 400 })))
    const result = await createConsoleClient(undefined, undefined, { auth: { persistSession: false } }).auth.reauthenticate({ password: 'fixture-password' })
    expect(result.error).toMatchObject({ code: 'invalid_captcha', message: 'invalid_captcha' })
  })

  it('rejects failed queries when throwOnError was requested', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: null, error: { message: 'Row not found', code: 'PGRST116' } }))))
    const client = createConsoleClient(undefined, undefined, { auth: { persistSession: false } })
    await expect(client.from('channel_devices').select().single().throwOnError()).rejects.toMatchObject({ code: 'PGRST116' })
  })
})
