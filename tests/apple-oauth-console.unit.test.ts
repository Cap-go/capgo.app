// @vitest-environment happy-dom
import type { SupabaseClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { captureAppleOAuthCallback, completeAppleOAuth, consumeAppleOAuthLandingError, hasPendingAppleOAuth, prepareAppleOAuthLanding } from '../src/services/appleOAuth'

vi.mock('~/services/supabase', () => ({ defaultApiHost: 'https://api.example.com' }))
const key = 'capgo.apple-oauth.v1'
const state = 's'.repeat(43)
const code = 'c'.repeat(43)
const websiteState = 'w'.repeat(43)
const message = vi.fn()
const exchange = vi.fn()
const user = { id: 'example-user', email: 'apple-user@example.com', factors: [{ status: 'verified', factor_type: 'totp' }] }
const session = { access_token: 'access-token', refresh_token: 'refresh-token' }
const setSession = vi.fn()
const client = { auth: { setSession } } as unknown as SupabaseClient
beforeEach(() => {
  vi.clearAllMocks()
  consumeAppleOAuthLandingError()
  sessionStorage.clear()
  sessionStorage.setItem(key, JSON.stringify({ state, verifier: 'v'.repeat(43), created: Date.now(), websiteState }))
  vi.stubGlobal('location', { origin: 'https://console.capgo.app' })
  vi.stubGlobal('window', { opener: { postMessage: message } })
  vi.stubGlobal('history', { replaceState: vi.fn() })
  vi.stubGlobal('fetch', exchange)
  setSession.mockResolvedValue({ data: { user, session }, error: null })
  exchange.mockImplementation(async () => Response.json({ user, session, is_new_user: true, name_status: 'unavailable' }))
})
afterEach(() => vi.unstubAllGlobals())
describe('console-owned Apple OAuth completion', () => {
  it('captures and strips the landing callback before router and analytics startup', async () => {
    vi.stubGlobal('location', { origin: 'https://console.capgo.app', href: `https://console.capgo.app/login#apple_code=${code}&state=${state}` })
    prepareAppleOAuthLanding()
    expect(history.replaceState).toHaveBeenCalledWith({}, '', new URL('https://console.capgo.app/login'))
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(hasPendingAppleOAuth()).toBe(true)
    expect(consumeAppleOAuthLandingError()).toBe(false)
    await completeAppleOAuth(client)
    expect(setSession).toHaveBeenCalledWith(session)

    const bootstrap = readFileSync('src/main.ts', 'utf8')
    const capture = bootstrap.indexOf('prepareAppleOAuthLanding()')
    expect(capture).toBeGreaterThan(0)
    expect(capture).toBeLessThan(bootstrap.indexOf('createRouter({'))
    expect(capture).toBeLessThan(bootstrap.indexOf('posthogLoader(config.supaHost)'))
  })
  it('strips invalid landing callbacks and defers a generic error to the login page', () => {
    vi.stubGlobal('location', { href: `https://console.capgo.app/login#apple_code=${code}&state=foreign` })
    expect(() => prepareAppleOAuthLanding()).not.toThrow()
    expect(history.replaceState).toHaveBeenCalled()
    expect(hasPendingAppleOAuth()).toBe(false)
    expect(sessionStorage.getItem(key)).toBeNull()
    expect(consumeAppleOAuthLandingError()).toBe(true)
    expect(consumeAppleOAuthLandingError()).toBe(false)
    expect(exchange).not.toHaveBeenCalled()
  })
  it.each([true, false])('installs the shared backend session, retains MFA and reports newness %s without credentials', async (isNew) => {
    exchange.mockImplementation(async () => Response.json({ user, session, is_new_user: isNew, name_status: 'unavailable' }))
    expect(captureAppleOAuthCallback(new URL(`https://console.capgo.app/login#apple_code=${code}&state=${state}`))).toBe(true)
    expect(history.replaceState).toHaveBeenCalledWith({}, '', new URL('https://console.capgo.app/login'))
    expect(hasPendingAppleOAuth()).toBe(true)
    expect(sessionStorage.getItem(key)).toBeNull()
    const result = await completeAppleOAuth(client, 'captcha')
    expect(exchange).toHaveBeenCalledWith('https://api.example.com/auth/apple/exchange', expect.objectContaining({ body: JSON.stringify({ code, code_verifier: 'v'.repeat(43), captcha_token: 'captcha' }) }))
    expect(setSession).toHaveBeenCalledWith(session)
    expect(result.user.factors).toEqual(user.factors)
    expect(message).toHaveBeenCalledWith({ type: 'capgo:apple-auth-complete', state: websiteState, is_new_user: isNew, user: { id: user.id, email: user.email } }, 'https://capgo.app')
    expect(JSON.stringify(message.mock.calls)).not.toMatch(/access-token|refresh-token|apple_code|code_verifier/)
    expect(hasPendingAppleOAuth()).toBe(false)
  })
  it('rejects mismatched state, cancellation and expired attempts without exchanging or messaging', () => {
    expect(() => captureAppleOAuthCallback(new URL(`https://console.capgo.app/login#apple_code=${code}&state=foreign`))).toThrow()
    expect(hasPendingAppleOAuth()).toBe(false)
    expect(exchange).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })
  it('rejects an Apple error without a completion receipt', () => {
    expect(() => captureAppleOAuthCallback(new URL(`https://console.capgo.app/login#apple_error=cancelled&state=${state}`))).toThrow()
    expect(message).not.toHaveBeenCalled()
  })
  it('does not install or announce rejected backend credentials', async () => {
    captureAppleOAuthCallback(new URL(`https://console.capgo.app/login#apple_code=${code}&state=${state}`))
    exchange.mockResolvedValue(Response.json({ error: 'sso_required' }, { status: 403 }))
    await expect(completeAppleOAuth(client)).rejects.toThrow()
    expect(setSession).not.toHaveBeenCalled()
    expect(message).not.toHaveBeenCalled()
  })
  it('never announces a failed session installation', async () => {
    captureAppleOAuthCallback(new URL(`https://console.capgo.app/login#apple_code=${code}&state=${state}`))
    setSession.mockResolvedValue({ data: {}, error: new Error('Invalid session') })
    await expect(completeAppleOAuth(client)).rejects.toThrow()
    expect(message).not.toHaveBeenCalled()
  })
})
