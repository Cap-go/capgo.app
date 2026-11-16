import type { Context } from 'hono'
import { sign } from 'hono/jwt'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ENV: Record<string, string> = { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_ANON_KEY: 'anon-key-value' }
const JWKS_URL = 'https://example.supabase.co/auth/v1/.well-known/jwks.json'
const USER_URL = 'https://example.supabase.co/auth/v1/user'
const KID = 'current-kid'

vi.mock('../supabase/functions/_backend/utils/utils.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/utils/utils.ts')>(),
  getEnv: (_c: unknown, key: string) => ENV[key] ?? '',
}))

type Jwk = JsonWebKey & { kid?: string, alg?: string }
let privateJwk: Jwk
let publicJwk: Jwk
let otherPrivateJwk: Jwk
let getClaimsFromJWT: typeof import('../supabase/functions/_backend/utils/hono_jwt.ts').getClaimsFromJWT
let userStatus = 200
let jwksStatus = 200
async function respond(input: string) {
  if (input.endsWith('.well-known/jwks.json'))
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: jwksStatus })
  return new Response(JSON.stringify({ id: 'user-1' }), { status: userStatus })
}
const fetchMock = vi.fn(respond)

async function es256Pair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateJwk: { ...await crypto.subtle.exportKey('jwk', pair.privateKey), alg: 'ES256', kid },
    publicJwk: { ...await crypto.subtle.exportKey('jwk', pair.publicKey), alg: 'ES256', kid },
  }
}

const now = () => Math.floor(Date.now() / 1000)
const claims = (extra: Record<string, unknown> = {}) => ({ sub: 'user-1', role: 'authenticated', exp: now() + 3600, ...extra })
const es256 = (payload: Record<string, unknown>, key: Jwk = privateJwk) => sign(payload, key as never)
const hs256 = (payload: Record<string, unknown>) => sign(payload, 'local-hs256-secret', 'HS256')
const context = (env: Record<string, unknown> = {}) => ({ env }) as unknown as Context
const urls = (mock = fetchMock) => mock.mock.calls.map(call => String(call[0]))
const headersOf = (index: number) => new Headers((fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].headers)

beforeAll(async () => {
  ({ privateJwk, publicJwk } = await es256Pair(KID))
  otherPrivateJwk = (await es256Pair(KID)).privateJwk
})

beforeEach(async () => {
  // Fresh module per test: empties the JWKS and verified-claims caches.
  vi.resetModules()
  ;({ getClaimsFromJWT } = await import('../supabase/functions/_backend/utils/hono_jwt.ts'))
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockClear()
  userStatus = 200
  jwksStatus = 200
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('getClaimsFromJWT ES256 (local verification)', () => {
  it('verifies a valid token against the JWKS and reuses the keys', async () => {
    await expect(getClaimsFromJWT(context(), `Bearer ${await es256(claims())}`)).resolves.toMatchObject({ sub: 'user-1' })
    await expect(getClaimsFromJWT(context(), await es256(claims({ sub: 'user-2' })))).resolves.toMatchObject({ sub: 'user-2' })

    expect(urls()).toEqual([JWKS_URL])
    expect(headersOf(0).get('apikey')).toBe('anon-key-value')
    expect(headersOf(0).get('authorization')).toBe('Bearer anon-key-value')
  })

  it('rejects expired tokens, tokens without exp and bad signatures', async () => {
    await expect(getClaimsFromJWT(context(), await es256(claims({ exp: now() - 1 })))).resolves.toBeNull()
    await expect(getClaimsFromJWT(context(), await es256({ sub: 'user-1' }))).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    await expect(getClaimsFromJWT(context(), await es256(claims(), otherPrivateJwk))).resolves.toBeNull()
    expect(urls()).toEqual([JWKS_URL])
  })

  it('accepts an iat slightly in the future, like supabase-js', async () => {
    await expect(getClaimsFromJWT(context(), await es256(claims({ iat: now() + 5 })))).resolves.toMatchObject({ sub: 'user-1' })
  })

  it('rejects an algorithm supabase-js cannot verify', async () => {
    const part = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    const token = `${part({ alg: 'PS256', typ: 'JWT', kid: KID })}.${part(claims())}.c2ln`
    await expect(getClaimsFromJWT(context(), token)).resolves.toBeNull()
    expect(urls()).toEqual([JWKS_URL])
  })

  it('refetches the JWKS for an unknown kid, then falls back to /user', async () => {
    await getClaimsFromJWT(context(), await es256(claims()))
    const unknown = await es256(claims(), { ...privateJwk, kid: 'rotated-kid' })
    await expect(getClaimsFromJWT(context(), unknown)).resolves.toMatchObject({ sub: 'user-1' })

    expect(urls()).toEqual([JWKS_URL, JWKS_URL, USER_URL])
    expect(headersOf(2).get('authorization')).toBe(`Bearer ${unknown}`)
    expect(headersOf(2).get('apikey')).toBe('anon-key-value')
  })

  it('refetches the JWKS after 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await getClaimsFromJWT(context(), await es256(claims({ exp: now() + 7200 })))
    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'))
    await getClaimsFromJWT(context(), await es256(claims({ sub: 'user-2', exp: now() + 3600 })))
    expect(urls()).toEqual([JWKS_URL, JWKS_URL])
  })

  it('rejects the token when the JWKS fetch fails, without calling /user', async () => {
    jwksStatus = 500
    await expect(getClaimsFromJWT(context(), await es256(claims()))).resolves.toBeNull()
    expect(urls()).toEqual([JWKS_URL])
  })
})

describe('getClaimsFromJWT /user fallback', () => {
  it('verifies HS256 tokens through GoTrue /user', async () => {
    const token = await hs256(claims())
    await expect(getClaimsFromJWT(context(), token)).resolves.toMatchObject({ sub: 'user-1', role: 'authenticated' })
    expect(urls()).toEqual([USER_URL])
    expect(headersOf(0).get('authorization')).toBe(`Bearer ${token}`)
    expect(headersOf(0).get('x-supabase-api-version')).toBe('2024-01-01')
  })

  it('returns null when /user rejects the token', async () => {
    userStatus = 401
    await expect(getClaimsFromJWT(context(), await hs256(claims()))).resolves.toBeNull()
  })

  it('goes through the GOTRUE binding when the environment has one', async () => {
    const binding = vi.fn(respond)
    const env = { GOTRUE: { fetch: binding } }
    await expect(getClaimsFromJWT(context(env), await es256(claims()))).resolves.toMatchObject({ sub: 'user-1' })
    await expect(getClaimsFromJWT(context(env), await hs256(claims()))).resolves.toMatchObject({ sub: 'user-1' })

    expect(urls(binding)).toEqual(['https://gotrue/.well-known/jwks.json', 'https://gotrue/user'])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getClaimsFromJWT cache', () => {
  it('reuses a successful verification and does not cache a failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await hs256(claims())
    userStatus = 401
    await expect(getClaimsFromJWT(context(), token)).resolves.toBeNull()

    userStatus = 200
    const first = await getClaimsFromJWT(context(), token)
    const second = await getClaimsFromJWT(context(), token)
    expect(first).toMatchObject({ sub: 'user-1' })
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    vi.setSystemTime(new Date('2026-01-01T00:00:31Z'))
    await getClaimsFromJWT(context(), token)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('drops a cached result at the token exp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const token = await hs256(claims({ exp: now() + 10 }))
    await getClaimsFromJWT(context(), token)
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    await expect(getClaimsFromJWT(context(), token)).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
