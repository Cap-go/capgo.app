// test/prescan/apple-access.test.ts
//
// Hermetic: a fake fetch is injected so no network call is made. A throwaway
// P-256 EC key is generated so generateJwt(ES256) succeeds without any real
// Apple credential.
import { describe, expect, it } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { assertAscAccess } from '../../src/build/onboarding/apple-access'

function testP8Pem(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

const p8Pem = testP8Pem()
const creds = { keyId: 'TESTKEYID', issuerId: 'TEST-ISSUER-ID', p8Pem }

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('assertAscAccess', () => {
  it('ok=true when the bundle id is present in /apps results', async () => {
    let calledUrl = ''
    const fetchImpl = (async (url: string) => {
      calledUrl = String(url)
      return jsonResponse(200, { data: [{ id: 'a1', attributes: { bundleId: 'com.demo.app' } }] })
    }) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, bundleId: 'com.demo.app', fetchImpl })
    expect(res.ok).toBe(true)
    expect(calledUrl).toContain('/apps')
    expect(calledUrl).toContain('filter[bundleId]=com.demo.app')
  })

  it('ok=true when no bundle id is requested and the call succeeds', async () => {
    const fetchImpl = (async () => jsonResponse(200, { data: [] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(true)
  })

  it('no-app-access when 200 but the bundle id is absent from results', async () => {
    const fetchImpl = (async () => jsonResponse(200, { data: [{ id: 'a1', attributes: { bundleId: 'com.other.app' } }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, bundleId: 'com.demo.app', fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.kind).toBe('no-app-access')
  })

  it('auth-error on 401', async () => {
    const fetchImpl = (async () => jsonResponse(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication failed', detail: 'bad token' }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, bundleId: 'com.demo.app', fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('auth-error')
      expect(res).toMatchObject({
        status: 401,
        code: 'NOT_AUTHORIZED',
        title: 'Authentication failed',
        detail: 'bad token',
      })
    }
  })

  it('auth-error on 403', async () => {
    const fetchImpl = (async () => jsonResponse(403, { errors: [{ status: '403', code: 'FORBIDDEN', title: 'Forbidden', detail: 'no access' }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('auth-error')
      expect(res).toMatchObject({
        status: 403,
        code: 'FORBIDDEN',
        title: 'Forbidden',
        detail: 'no access',
      })
    }
  })

  it('auth-error on 403 agreements branch (REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED) with agreements copy', async () => {
    const fetchImpl = (async () => jsonResponse(403, { errors: [{ status: '403', code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED', title: 'Forbidden', detail: 'sign agreement' }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('auth-error')
      expect(res.message.toLowerCase()).toContain('agreement')
    }
  })

  it('network on a transport failure (fetch throws)', async () => {
    const fetchImpl = (async () => {
      throw new Error('fetch failed: ENOTFOUND')
    }) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.kind).toBe('network')
  })

  it('network on a 5xx server error', async () => {
    const fetchImpl = (async () => jsonResponse(503, { errors: [{ status: '503', code: 'X', title: 'Service Unavailable', detail: 'down' }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.kind).toBe('network')
      expect(res).toMatchObject({
        status: 503,
        code: 'X',
        title: 'Service Unavailable',
        detail: 'down',
      })
    }
  })

  it('network when the provided signal is already aborted (no fetch fires)', async () => {
    let fetchCalled = false
    const fetchImpl = (async () => {
      fetchCalled = true
      return jsonResponse(200, { data: [] })
    }) as unknown as typeof fetch
    const controller = new AbortController()
    controller.abort()
    const res = await assertAscAccess({ ...creds, signal: controller.signal, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok)
      expect(res.kind).toBe('network')
    expect(fetchCalled).toBe(false)
  })

  it('does not leak the p8 or Authorization header into the result message', async () => {
    const fetchImpl = (async () => jsonResponse(401, { errors: [{ status: '401', code: 'NOT_AUTHORIZED', title: 'Authentication failed', detail: 'bad' }] })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.message).not.toContain(p8Pem)
      expect(res.message).not.toContain('BEGIN')
      expect(res.message.toLowerCase()).not.toContain('bearer')
    }
  })

  it('redacts credential identifiers and secret-looking values from Apple error fields', async () => {
    const fetchImpl = (async () => jsonResponse(403, {
      errors: [{
        status: '403',
        code: 'FORBIDDEN',
        title: `Key ${creds.keyId} was denied`,
        detail: `issuer ${creds.issuerId}\ntoken=super-secret-value`,
      }],
    })) as unknown as typeof fetch
    const res = await assertAscAccess({ ...creds, fetchImpl })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      const serialized = JSON.stringify(res)
      expect(serialized).not.toContain(creds.keyId)
      expect(serialized).not.toContain(creds.issuerId)
      expect(serialized).not.toContain('super-secret-value')
      expect(res.title).toContain('[REDACTED IDENTIFIER]')
      expect(res.detail).not.toContain('\n')
    }
  })
})
