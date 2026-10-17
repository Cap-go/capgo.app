import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isNativeAppleLoginAvailable, signInWithApple } from '../src/services/nativeAppleLogin'

const native = vi.hoisted(() => ({ platform: 'ios', available: true, isNative: true }))
vi.mock('~/services/console', () => ({ defaultApiHost: 'https://api.example.com' }))
const plugin = vi.hoisted(() => ({ initialize: vi.fn(), login: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: () => native.isNative,
  getPlatform: () => native.platform,
  isPluginAvailable: () => native.available,
} }))
vi.mock('@capgo/capacitor-social-login', () => ({ SocialLogin: plugin }))
const user = { id: 'apple-user', email: 'apple-user@example.com', user_metadata: {} }
const session = { access_token: 'session-access', refresh_token: 'session-refresh' }
const fetchMock = vi.fn()
function client() {
  return { auth: {
    signInWithIdToken: vi.fn(() => { throw new Error('Direct Apple exchange forbidden') }),
    updateUser: vi.fn(),
    getSession: vi.fn().mockResolvedValue({ data: { session: { user, access_token: 'current-access' } } }),
    setSession: vi.fn().mockResolvedValue({ data: { session: { user, ...session } }, error: null }),
  } }
}
function login(supabase: ReturnType<typeof client>, reauthenticate = false) {
  return signInWithApple(supabase, 'captcha-token', { reauthenticate })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('fetch', fetchMock)
  native.platform = 'ios'
  native.available = true
  native.isNative = true
  vi.stubEnv('VITE_NATIVE_APPLE_LOGIN_ENABLED', 'true')
  plugin.login.mockResolvedValue({ provider: 'apple', result: {
    idToken: 'apple-id-token',
    authorizationCode: 'apple-code',
    profile: { givenName: 'Cached', familyName: 'Name' },
  } })
  fetchMock.mockResolvedValue(Response.json({ user, session, name_status: 'saved' }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
describe('native Apple backend exchange', () => {
  it.each([undefined, '', 'false'])('keeps native UI off by default (%s) despite a remote true value, with no discovery request', (value) => {
    vi.stubEnv('VITE_NATIVE_APPLE_LOGIN_ENABLED', value)
    expect(isNativeAppleLoginAvailable()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('hashes a fresh nonce for Apple and sends the raw nonce and cached name only to our backend', async () => {
    const supabase = client()
    const result = await login(supabase)
    const request = JSON.parse(fetchMock.mock.calls[0][1].body)
    const expectedHash = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(request.nonce))), b => b.toString(16).padStart(2, '0')).join('')
    expect(plugin.initialize).toHaveBeenCalledWith({ apple: { useProperTokenExchange: true } })
    expect(plugin.login).toHaveBeenCalledWith({ provider: 'apple', options: { scopes: ['email', 'name'], nonce: expectedHash } })
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/auth/apple', expect.objectContaining({ method: 'POST' }))
    expect(request).toMatchObject({ id_token: 'apple-id-token', captcha_token: 'captcha-token', first_name: 'Cached', last_name: 'Name' })
    expect(supabase.auth.setSession).toHaveBeenCalledWith(session)
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled()
    expect(supabase.auth.updateUser).not.toHaveBeenCalled()
    expect(result).toMatchObject({ user, authorizationCode: 'apple-code' })
    fetchMock.mockResolvedValue(Response.json({ user, session, name_status: 'saved' }))
    await login(supabase)
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).nonce).not.toBe(request.nonce)
  })
  it('uses the same endpoint with authenticated same-account reauthentication for deletion', async () => {
    const supabase = client()
    vi.stubEnv('VITE_NATIVE_APPLE_LOGIN_ENABLED', 'false')
    await login(supabase, true)
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer current-access')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).reauthenticate).toBe(true)
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled()
  })
  it('does not install a different account session during reauthentication', async () => {
    const supabase = client()
    fetchMock.mockResolvedValue(Response.json({ user: { ...user, id: 'other-user' }, session }))
    await expect(login(supabase, true)).rejects.toThrow('does not match')
    expect(supabase.auth.setSession).not.toHaveBeenCalled()
  })
  it('never falls back to direct exchange when the backend rejects a credential', async () => {
    const supabase = client()
    fetchMock.mockResolvedValue(Response.json({ error: 'sso_required' }, { status: 403 }))
    await expect(login(supabase)).rejects.toThrow('sso_required')
    expect(supabase.auth.signInWithIdToken).not.toHaveBeenCalled()
    expect(supabase.auth.setSession).not.toHaveBeenCalled()
  })
  it('retains iOS-only button availability and allows gated-off deletion reauth', () => {
    expect(isNativeAppleLoginAvailable()).toBe(true)
    vi.stubEnv('VITE_NATIVE_APPLE_LOGIN_ENABLED', 'false')
    expect(isNativeAppleLoginAvailable()).toBe(false)
    expect(isNativeAppleLoginAvailable(true)).toBe(true)
    native.platform = 'android'
    expect(isNativeAppleLoginAvailable(true)).toBe(false)
    native.platform = 'web'
    expect(isNativeAppleLoginAvailable()).toBe(false)
  })
  it('treats cancellation as no session and does not call the endpoint', async () => {
    const supabase = client()
    plugin.login.mockRejectedValue({ code: 'USER_CANCELLED' })
    await expect(login(supabase)).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('allows an absent name without inventing one', async () => {
    const supabase = client()
    plugin.login.mockResolvedValue({ result: { idToken: 'apple-id-token', profile: {} } })
    fetchMock.mockResolvedValue(Response.json({ user, session, name_status: 'unavailable' }))
    await expect(login(supabase)).resolves.toMatchObject({ nameUnavailable: true })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('first_name')
  })
})
