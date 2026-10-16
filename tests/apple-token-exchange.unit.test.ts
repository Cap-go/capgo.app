import type { Context } from 'hono'
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { isAppleSignInConfigured, revokeAppleAuthorization } from '../supabase/functions/_backend/utils/appleSignIn.ts'

const pg = vi.hoisted(() => ({ query: vi.fn(), close: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({ getPgClient: async () => ({ query: pg.query }), closeClient: pg.close }))

let privateKey: string
let identityToken: string
let webIdentityToken: string
let jwks: unknown
beforeAll(async () => {
  const clientKeys = await generateKeyPair('ES256', { extractable: true })
  privateKey = await exportPKCS8(clientKeys.privateKey)
  const appleKeys = await generateKeyPair('RS256', { extractable: true })
  jwks = { keys: [{ ...await exportJWK(appleKeys.publicKey), kid: 'test-apple-key', alg: 'RS256' }] }
  identityToken = await new SignJWT({ sub: 'apple-subject' }).setProtectedHeader({ alg: 'RS256', kid: 'test-apple-key' }).setIssuer('https://appleid.apple.com').setAudience('com.example.capgo').setIssuedAt().setExpirationTime('5m').sign(appleKeys.privateKey)
  webIdentityToken = await new SignJWT({ sub: 'apple-subject' }).setProtectedHeader({ alg: 'RS256', kid: 'test-apple-key' }).setIssuer('https://appleid.apple.com').setAudience('com.example.web').setIssuedAt().setExpirationTime('5m').sign(appleKeys.privateKey)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})
function context() {
  vi.stubEnv('APPLE_SIGN_IN_CLIENT_ID', 'com.example.capgo')
  vi.stubEnv('APPLE_SIGN_IN_TEAM_ID', 'EXAMPLETEAM')
  vi.stubEnv('APPLE_SIGN_IN_KEY_ID', 'EXAMPLEKEY')
  vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', privateKey)
  return { env: {}, req: { url: 'http://local/' } } as Context
}
function mockApple(options: { exchangeStatus?: number, revokeStatus?: number, idToken?: string } = {}) {
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const target = String(url)
    if (target.endsWith('/auth/keys'))
      return Response.json(jwks)
    if (target.endsWith('/auth/token'))
      return Response.json({ id_token: options.idToken ?? identityToken, access_token: 'apple-access-token' }, { status: options.exchangeStatus ?? 200 })
    if (target.endsWith('/auth/revoke'))
      return new Response('', { status: options.revokeStatus ?? 200 })
    throw new Error('Unexpected external request')
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('apple token exchange and revocation', () => {
  it('requires only normal Apple credentials and performs no rollout lookup', () => {
    const c = context()
    expect(isAppleSignInConfigured(c)).toBe(true)
    vi.stubEnv('APPLE_SIGN_IN_PRIVATE_KEY', '')
    expect(isAppleSignInConfigured(c)).toBe(false)
    expect(pg.query).not.toHaveBeenCalled()
  })

  it('verifies Apple identity before revoking the exchanged access token', async () => {
    const c = context()
    const fetchMock = mockApple()
    await revokeAppleAuthorization(c, 'fresh-code', 'apple-subject')
    const revokeCall = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/auth/revoke')) as unknown as [string, RequestInit]
    expect(revokeCall).toBeDefined()
    const form = revokeCall[1].body as URLSearchParams
    expect(form.get('token')).toBe('apple-access-token')
    expect(form.get('token_type_hint')).toBe('access_token')
    expect(form.get('client_id')).toBe('com.example.capgo')
  })
  it('never revokes a code belonging to another Apple identity', async () => {
    const c = context()
    const fetchMock = mockApple()
    await expect(revokeAppleAuthorization(c, 'foreign-code', 'another-apple-subject')).rejects.toThrow('does not belong')
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/auth/revoke'))).toBe(false)
  })
  it('binds browser/Android code exchange to the configured web client and original callback', async () => {
    const c = context()
    vi.stubEnv('APPLE_SIGN_IN_WEB_CLIENT_ID', 'com.example.web')
    vi.stubEnv('APPLE_SIGN_IN_OAUTH_CALLBACK_URL', 'https://api.example.com/auth/apple/callback')
    const fetchMock = mockApple({ idToken: webIdentityToken })
    await revokeAppleAuthorization(c, 'fresh-web-code', 'apple-subject', true)
    const exchange = fetchMock.mock.calls.find(call => String(call[0]).endsWith('/auth/token')) as unknown as [string, RequestInit]
    const form = exchange[1].body as URLSearchParams
    expect(form.get('client_id')).toBe('com.example.web')
    expect(form.get('redirect_uri')).toBe('https://api.example.com/auth/apple/callback')
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/auth/revoke'))).toBe(true)
  })
  it('rejects an invalid identity token before revocation', async () => {
    const c = context()
    const fetchMock = mockApple({ idToken: 'invalid-token' })
    await expect(revokeAppleAuthorization(c, 'fresh-code', 'apple-subject')).rejects.toThrow()
    expect(fetchMock.mock.calls.some(call => String(call[0]).endsWith('/auth/revoke'))).toBe(false)
  })
  it('surfaces exchange and revocation failures for retry', async () => {
    const c = context()
    mockApple({ exchangeStatus: 400 })
    await expect(revokeAppleAuthorization(c, 'fresh-code', 'apple-subject')).rejects.toThrow('exchange failed')
    mockApple({ revokeStatus: 500 })
    await expect(revokeAppleAuthorization(c, 'fresh-code', 'apple-subject')).rejects.toThrow('revocation failed')
  })
})
