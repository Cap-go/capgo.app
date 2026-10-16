// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isWebAppleLoginAvailable, startAppleOAuth } from '../src/services/appleOAuth'

const native = vi.hoisted(() => ({ value: false }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native.value } }))
vi.mock('~/services/supabase', () => ({ defaultApiHost: 'https://api.example.com' }))
const origin = 'https://localhost:5173'
const assign = vi.fn()
const fetchMock = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
  native.value = false
  vi.stubEnv('VITE_WEB_APPLE_LOGIN_ENABLED', 'true')
  vi.stubGlobal('location', { origin, protocol: 'https:', href: `${origin}/login`, assign })
  fetchMock.mockImplementation(async () => Response.json({ authorization_url: 'https://appleid.apple.com/auth/authorize' }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
describe('build-time Apple browser login', () => {
  it.each([undefined, '', 'false'])('defaults to hidden (%s) without any discovery request', async (value) => {
    vi.stubEnv('VITE_WEB_APPLE_LOGIN_ENABLED', value)
    expect(isWebAppleLoginAvailable()).toBe(false)
    await expect(startAppleOAuth(new URL(`${origin}/login`))).rejects.toThrow('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it.each([true, false])('uses only the local build opt-in with DEV=%s and starts real PKCE OAuth directly', async (development) => {
    vi.stubEnv('DEV', development)
    expect(isWebAppleLoginAvailable()).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
    await startAppleOAuth(new URL(`${origin}/login`))
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/auth/apple/start')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const attempt = JSON.parse(sessionStorage.getItem('capgo.apple-oauth.v1')!)
    expect(body.redirect_uri).toBe(`${origin}/login`)
    expect(body.code_challenge).toMatch(/^[\w-]{43}$/)
    expect(body.client_state).toBe(attempt.state)
    expect(attempt.verifier).toMatch(/^[\w-]{43}$/)
    expect(assign).toHaveBeenCalledWith('https://appleid.apple.com/auth/authorize')
  })
  it.each(['mobile', 'http'])('keeps the browser button unavailable on %s without discovery', async (mode) => {
    if (mode === 'mobile') native.value = true
    else vi.stubGlobal('location', { origin: 'http://localhost:5173', protocol: 'http:', assign })
    expect(isWebAppleLoginAvailable()).toBe(false)
    await expect(startAppleOAuth(new URL(`${origin}/login`))).rejects.toThrow('unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('lets the actual start endpoint reject an unallowlisted redirect without provider discovery', async () => {
    fetchMock.mockResolvedValue(Response.json({ error: 'invalid_redirect' }, { status: 400 }))
    await expect(startAppleOAuth(new URL(`${origin}/login`))).rejects.toThrow('could not start')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(assign).not.toHaveBeenCalled()
  })
})
