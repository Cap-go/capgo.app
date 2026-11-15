import { beforeAll, describe, expect, it } from 'vitest'
import { goTrueStringEnv } from '../cloudflare_workers/gotrue/container_env.ts'
import { swapServiceKey } from '../cloudflare_workers/gotrue/service_key.ts'

const SERVICE_KEY = 'sb_secret_test-service-key'
const ISSUER = 'https://example.supabase.co/auth/v1'
const KID = 'test-p256-key'

let publicKey: CryptoKey
let env: Record<string, string>

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  publicKey = pair.publicKey
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  env = {
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    GOTRUE_JWT_ISSUER: ISSUER,
    GOTRUE_JWT_KEYS: JSON.stringify([{ ...privateJwk, kid: KID, alg: 'ES256', key_ops: ['sign', 'verify'] }]),
  }
})

function adminRequest(headers: Record<string, string>) {
  return new Request('https://gotrue/admin/users', { headers })
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), char => char.charCodeAt(0))
}

async function verifiedClaims(authorization: string | null) {
  const token = authorization?.replace(/^Bearer /, '') ?? ''
  const [header, payload, signature] = token.split('.')
  const valid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    base64UrlDecode(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  )
  expect(valid).toBe(true)
  return {
    header: JSON.parse(new TextDecoder().decode(base64UrlDecode(header))),
    payload: JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))),
  }
}

describe('gotrue service key swap', () => {
  it('swaps the service key for a short-lived ES256 service_role token', async () => {
    const swapped = await swapServiceKey(adminRequest({ apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` }), env)
    expect(swapped.headers.get('apikey')).toBeNull()
    const { header, payload } = await verifiedClaims(swapped.headers.get('authorization'))
    expect(header).toEqual({ alg: 'ES256', kid: KID, typ: 'JWT' })
    expect(payload.role).toBe('service_role')
    expect(payload.iss).toBe(ISSUER)
    expect(payload.exp - payload.iat).toBe(60)
    expect(Math.abs(payload.iat - Date.now() / 1000)).toBeLessThan(5)
    expect([...swapped.headers.values()].join(' ')).not.toContain(SERVICE_KEY)
  })

  it('swaps when the key is only in apikey or only in the bearer', async () => {
    const onlyApikey = await swapServiceKey(adminRequest({ apikey: SERVICE_KEY }), env)
    expect(onlyApikey.headers.get('apikey')).toBeNull()
    expect((await verifiedClaims(onlyApikey.headers.get('authorization'))).payload.role).toBe('service_role')

    const onlyBearer = await swapServiceKey(adminRequest({ authorization: `Bearer ${SERVICE_KEY}` }), env)
    expect((await verifiedClaims(onlyBearer.headers.get('authorization'))).payload.role).toBe('service_role')
  })

  it('keeps a user session sent next to the service key', async () => {
    const session = 'Bearer header.payload.signature'
    const swapped = await swapServiceKey(adminRequest({ apikey: SERVICE_KEY, authorization: session }), env)
    expect(swapped.headers.get('apikey')).toBeNull()
    expect(swapped.headers.get('authorization')).toBe(session)
  })

  it('forwards other requests unchanged', async () => {
    const wrongKey = adminRequest({ apikey: 'sb_secret_other', authorization: 'Bearer sb_secret_other' })
    expect(await swapServiceKey(wrongKey, env)).toBe(wrongKey)
    const userSession = adminRequest({ authorization: 'Bearer header.payload.signature' })
    expect(await swapServiceKey(userSession, env)).toBe(userSession)
    const anonymous = adminRequest({})
    expect(await swapServiceKey(anonymous, env)).toBe(anonymous)
  })

  it('does nothing without a service key or a P-256 signing key', async () => {
    const request = adminRequest({ apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` })
    expect(await swapServiceKey(request, { ...env, SUPABASE_SERVICE_ROLE_KEY: '' })).toBe(request)
    expect(await swapServiceKey(request, { ...env, GOTRUE_JWT_KEYS: undefined })).toBe(request)
    expect(await swapServiceKey(request, { ...env, GOTRUE_JWT_KEYS: 'not json' })).toBe(request)
    const verifyOnly = JSON.stringify(JSON.parse(env.GOTRUE_JWT_KEYS).map((key: JsonWebKey) => ({ ...key, key_ops: ['verify'] })))
    expect(await swapServiceKey(request, { ...env, GOTRUE_JWT_KEYS: verifyOnly })).toBe(request)
  })

  it('keeps the service key out of the GoTrue container env', () => {
    const containerEnv = goTrueStringEnv({ ...env, GOTRUE: {}, PORT: '9999' })
    expect(containerEnv).toEqual({ GOTRUE_JWT_ISSUER: ISSUER, GOTRUE_JWT_KEYS: env.GOTRUE_JWT_KEYS, PORT: '9999' })
  })
})
