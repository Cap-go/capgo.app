import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleClient } from '../src/services/consoleClient'

const signup = vi.hoisted(() => vi.fn())
vi.mock('better-auth/client', () => ({ createAuthClient: () => ({ signUp: { email: signup } }) }))

beforeEach(() => { vi.stubGlobal('location', { origin: 'https://console.example.com' }) })

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('console registration session', () => {
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
