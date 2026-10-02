import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleClient } from '../src/services/consoleClient'

const { signup, signin } = vi.hoisted(() => ({ signup: vi.fn(), signin: vi.fn() }))
vi.mock('better-auth/client', () => ({ createAuthClient: () => ({ signUp: { email: signup }, signIn: { email: signin } }) }))

beforeEach(() => { vi.stubGlobal('location', { origin: 'https://console.example.com' }) })

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

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
