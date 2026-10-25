import forge from 'node-forge'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AscCertificateLimitError,
  buildIosProvisioningMap,
  createAppStoreProfile,
  createAscToken,
  createDistributionCertificate,
  ensureAscBundleId,
  findAscApp,
  generateAndroidUploadKeystore,
  parseMobileProvision,
  validatePlayServiceAccountJson,
  verifyAscKey,
} from '../supabase/functions/_backend/utils/store_signing.ts'

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes)
    binary += String.fromCharCode(b)
  return btoa(binary)
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

let creds: { keyId: string, issuerId: string, privateKeyP8: string }
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const pem = `-----BEGIN PRIVATE KEY-----\n${toBase64(pkcs8).match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  publicKey = pair.publicKey
  creds = { keyId: 'ABCDE12345', issuerId: '69a6de7e-0000-47e3-e053-5b8c7c11a4d1', privateKeyP8: pem }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface MockRoute {
  method: string
  match: RegExp
  status?: number
  body?: unknown
}

function mockFetch(routes: MockRoute[]) {
  const calls: { method: string, url: string, body?: any, auth?: string }[] = []
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers?.Authorization })
    const route = routes.find(r => r.method === method && r.match.test(url))
    if (!route)
      throw new Error(`Unmocked ${method} ${url}`)
    const status = route.status ?? 200
    if (status === 204)
      return new Response(null, { status })
    return new Response(JSON.stringify(route.body ?? {}), { status, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

function makeAppleCert(teamId: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000)
  const subject = [
    { name: 'commonName', value: `Apple Distribution: Test (${teamId})` },
    { shortName: 'OU', value: teamId },
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
}

describe('createAscToken', () => {
  it('produces an ES256 JWT that verifies with the public key', async () => {
    const token = await createAscToken(creds)
    const [h, p, s] = token.split('.')
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(h)))
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(p)))
    expect(header).toEqual({ alg: 'ES256', kid: creds.keyId, typ: 'JWT' })
    expect(payload.iss).toBe(creds.issuerId)
    expect(payload.aud).toBe('appstoreconnect-v1')
    expect(payload.exp - payload.iat).toBeGreaterThan(0)
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(20 * 60)
    const sig = base64UrlDecode(s)
    expect(sig.length).toBe(64)
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, sig, new TextEncoder().encode(`${h}.${p}`))
    expect(ok).toBe(true)
  })

  it('rejects an invalid p8', async () => {
    await expect(createAscToken({ ...creds, privateKeyP8: 'nope' })).rejects.toMatchObject({ cause: { error: 'asc_invalid_private_key' } })
  })
})

describe('verifyAscKey', () => {
  it('returns ok on 200', async () => {
    const calls = mockFetch([{ method: 'GET', match: /\/v1\/apps\?limit=1$/, body: { data: [] } }])
    await expect(verifyAscKey(creds)).resolves.toEqual({ ok: true })
    expect(calls[0].auth).toMatch(/^Bearer ey/)
  })

  it('classifies 401 as key_rejected', async () => {
    mockFetch([{ method: 'GET', match: /\/apps/, status: 401, body: { errors: [{ code: 'NOT_AUTHORIZED', title: 'Auth', detail: 'bad' }] } }])
    await expect(verifyAscKey(creds)).resolves.toMatchObject({ ok: false, reason: 'key_rejected' })
  })

  it('classifies agreement 403', async () => {
    mockFetch([{ method: 'GET', match: /\/apps/, status: 403, body: { errors: [{ code: 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED', title: 'x', detail: 'y' }] } }])
    await expect(verifyAscKey(creds)).resolves.toMatchObject({ ok: false, reason: 'agreements_missing' })
  })

  it('reports invalid private key without calling Apple', async () => {
    const calls = mockFetch([])
    await expect(verifyAscKey({ ...creds, privateKeyP8: 'garbage' })).resolves.toMatchObject({ ok: false, reason: 'invalid_private_key' })
    expect(calls).toHaveLength(0)
  })

  it('throws on 5xx', async () => {
    mockFetch([{ method: 'GET', match: /\/apps/, status: 500, body: {} }])
    await expect(verifyAscKey(creds)).rejects.toMatchObject({ ascStatus: 500, status: 502 })
  })
})

describe('asc resources', () => {
  it('findAscApp matches exact bundle id', async () => {
    mockFetch([{ method: 'GET', match: /\/apps\?filter\[bundleId\]=com\.x\.app/, body: { data: [
      { id: '1', attributes: { bundleId: 'com.x.app.ext', name: 'Ext' } },
      { id: '2', attributes: { bundleId: 'com.x.app', name: 'Main' } },
    ] } }])
    await expect(findAscApp(creds, 'com.x.app')).resolves.toEqual({ id: '2', name: 'Main' })
  })

  it('findAscApp returns null when missing', async () => {
    mockFetch([{ method: 'GET', match: /\/apps/, body: { data: [] } }])
    await expect(findAscApp(creds, 'com.x.app')).resolves.toBeNull()
  })

  it('ensureAscBundleId returns existing id', async () => {
    const calls = mockFetch([{ method: 'GET', match: /\/bundleIds\?/, body: { data: [{ id: 'B1', attributes: { identifier: 'com.x.app' } }] } }])
    await expect(ensureAscBundleId(creds, 'com.x.app', 'My App')).resolves.toBe('B1')
    expect(calls).toHaveLength(1)
  })

  it('ensureAscBundleId creates when missing', async () => {
    const calls = mockFetch([
      { method: 'GET', match: /\/bundleIds\?/, body: { data: [] } },
      { method: 'POST', match: /\/bundleIds$/, status: 201, body: { data: { id: 'B2' } } },
    ])
    await expect(ensureAscBundleId(creds, 'com.x.app', 'My App!')).resolves.toBe('B2')
    expect(calls[1].body.data.attributes).toEqual({ identifier: 'com.x.app', name: 'My App', platform: 'IOS' })
  })

  it('createDistributionCertificate returns cert, key and a working p12', async () => {
    const certificateContent = makeAppleCert('TEAM123456')
    const calls = mockFetch([{ method: 'POST', match: /\/certificates$/, status: 201, body: { data: { id: 'C1', attributes: { certificateContent, expirationDate: '2027-10-13T00:00:00.000+0000' } } } }])
    const result = await createDistributionCertificate(creds)
    expect(result.certificateId).toBe('C1')
    expect(result.teamId).toBe('TEAM123456')
    expect(result.expirationDate).toBe('2027-10-13T00:00:00.000+0000')
    expect(result.certificateContentBase64).toBe(certificateContent)
    expect(result.privateKeyPem).toContain('BEGIN RSA PRIVATE KEY')
    expect(result.p12Password.length).toBeGreaterThanOrEqual(32)
    const sent = calls[0].body.data.attributes
    expect(sent.certificateType).toBe('DISTRIBUTION')
    const csr = forge.pki.certificationRequestFromPem(sent.csrContent)
    expect(csr.verify()).toBe(true)
    expect((csr.publicKey as forge.pki.rsa.PublicKey).n.bitLength()).toBe(2048)
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(result.p12Base64)), result.p12Password)
    expect(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]?.[0]?.key).toBeTruthy()
    expect(p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]?.cert).toBeTruthy()
  })

  it('createDistributionCertificate surfaces the certificate limit', async () => {
    mockFetch([
      { method: 'POST', match: /\/certificates$/, status: 409, body: { errors: [{ code: 'ENTITY_ERROR.ATTRIBUTE.INVALID', title: 'There is a problem with the request entity', detail: 'You already have a current Distribution certificate or a pending certificate request.' }] } },
      { method: 'GET', match: /\/certificates\?filter/, body: { data: [{ id: 'OLD', attributes: { name: 'Old', serialNumber: 'AA', expirationDate: '2027-01-01' } }] } },
    ])
    const error = await createDistributionCertificate(creds).catch(e => e)
    expect(error).toBeInstanceOf(AscCertificateLimitError)
    expect(error.certificates).toEqual([{ id: 'OLD', name: 'Old', serialNumber: 'AA', expirationDate: '2027-01-01' }])
    expect(error.cause.error).toBe('asc_certificate_limit')
  })

  it('createAppStoreProfile creates then deletes same-name profiles', async () => {
    const calls = mockFetch([
      { method: 'GET', match: /\/profiles\?filter\[name\]=/, body: { data: [{ id: 'P_OLD', attributes: { name: 'Capgo com.x.app AppStore' } }, { id: 'P_OTHER', attributes: { name: 'Capgo com.x.app AppStore 2' } }] } },
      { method: 'POST', match: /\/profiles$/, status: 201, body: { data: { id: 'P_NEW', attributes: { name: 'Capgo com.x.app AppStore', profileContent: 'QUJD' } } } },
      { method: 'DELETE', match: /\/profiles\/P_OLD$/, status: 204 },
    ])
    const result = await createAppStoreProfile(creds, { bundleIdResourceId: 'B1', certificateId: 'C1', name: 'Capgo com.x.app AppStore' })
    expect(result).toEqual({ profileId: 'P_NEW', name: 'Capgo com.x.app AppStore', profileContentBase64: 'QUJD' })
    expect(calls.map(c => c.method)).toEqual(['GET', 'POST', 'DELETE'])
    const sent = calls[1].body.data
    expect(sent.attributes.profileType).toBe('IOS_APP_STORE')
    expect(sent.relationships.bundleId.data.id).toBe('B1')
    expect(sent.relationships.certificates.data[0].id).toBe('C1')
  })
})

function makeProfile(extra = ''): string {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AppIDName</key><string>X</string>
  <key>Entitlements</key>
  <dict>
    <key>application-identifier</key><string>TEAM123456.com.x.app</string>
    <key>get-task-allow</key><false/>
  </dict>
  <key>ExpirationDate</key><date>2027-10-13T10:00:00Z</date>
  <key>Name</key><string>Capgo com.x.app AppStore — é &amp; co</string>
  <key>TeamIdentifier</key><array><string>TEAM123456</string></array>
  <key>UUID</key><string>11111111-2222-3333-4444-555555555555</string>${extra}
</dict>
</plist>`
  const xml = new TextEncoder().encode(plist)
  const prefix = new Uint8Array([0x30, 0x82, 0x1F, 0x00, 0x06, 0x09, 0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x07, 0x02, 0xA0, 0xFF, 0x00])
  const suffix = new Uint8Array([0xA0, 0x82, 0x0D, 0xFE, 0x00, 0x01, 0x80, 0x90])
  const blob = new Uint8Array(prefix.length + xml.length + suffix.length)
  blob.set(prefix)
  blob.set(xml, prefix.length)
  blob.set(suffix, prefix.length + xml.length)
  return toBase64(blob)
}

describe('parseMobileProvision', () => {
  it('extracts fields from a CMS-like blob', () => {
    expect(parseMobileProvision(makeProfile())).toEqual({
      name: 'Capgo com.x.app AppStore — é & co',
      uuid: '11111111-2222-3333-4444-555555555555',
      teamId: 'TEAM123456',
      bundleId: 'com.x.app',
      expirationDate: '2027-10-13T10:00:00Z',
      isAppStore: true,
    })
  })

  it('detects ad-hoc profiles', () => {
    const info = parseMobileProvision(makeProfile('\n  <key>ProvisionedDevices</key><array><string>abc</string></array>'))
    expect(info.isAppStore).toBe(false)
  })

  it('throws invalid_mobileprovision without plist', () => {
    expect(() => parseMobileProvision(btoa('not a profile'))).toThrow(expect.objectContaining({ cause: expect.objectContaining({ error: 'invalid_mobileprovision' }) }))
  })
})

describe('buildIosProvisioningMap', () => {
  it('matches the builder format', () => {
    expect(JSON.parse(buildIosProvisioningMap('com.x.app', 'QUJD', 'Capgo com.x.app AppStore'))).toEqual({
      'com.x.app': { profile: 'QUJD', name: 'Capgo com.x.app AppStore' },
    })
  })
})

describe('generateAndroidUploadKeystore', () => {
  it('produces a PKCS12 keystore with the key and cert under the alias', async () => {
    const result = await generateAndroidUploadKeystore({ alias: 'upload', commonName: 'Capgo', organization: 'Acme' })
    expect(result.alias).toBe('upload')
    expect(result.storePassword).toBe(result.keyPassword)
    expect(result.sha1Fingerprint).toMatch(/^(?:[0-9A-F]{2}:){19}[0-9A-F]{2}$/)
    expect(result.sha256Fingerprint).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)

    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(result.keystoreBase64)), result.storePassword)
    const keyBag = p12.getBags({ friendlyName: 'upload', bagType: forge.pki.oids.pkcs8ShroudedKeyBag }).friendlyName?.[0]
    const certBag = p12.getBags({ friendlyName: 'upload', bagType: forge.pki.oids.certBag }).friendlyName?.[0]
    expect(keyBag?.key).toBeTruthy()
    const cert = certBag!.cert!
    expect(cert.subject.getField('CN').value).toBe('Capgo')
    expect(cert.subject.getField('O').value).toBe('Acme')
    const years = (cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime()) / (365.25 * 86400_000)
    expect(years).toBeGreaterThan(29.9)
    expect((cert.publicKey as forge.pki.rsa.PublicKey).n.equals((keyBag!.key as forge.pki.rsa.PrivateKey).n)).toBe(true)
    expect(cert.verify(cert)).toBe(true)

    const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()
    const md = forge.md.sha256.create()
    md.update(der)
    expect(result.sha256Fingerprint.replace(/:/g, '')).toBe(md.digest().toHex().toUpperCase())

    expect(() => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(result.keystoreBase64)), 'wrong')).toThrow()
  })

  it('requires an alias', async () => {
    await expect(generateAndroidUploadKeystore({ alias: '', commonName: 'x' })).rejects.toMatchObject({ cause: { error: 'invalid_keystore_options' } })
  })
})

describe('validatePlayServiceAccountJson', () => {
  // Google ships PKCS#8 RSA keys; a small key keeps the fixture fast.
  const rsa = forge.pki.rsa.generateKeyPair({ bits: 512, e: 0x10001 })
  const valid = {
    type: 'service_account',
    project_id: 'proj-1',
    client_email: 'bot@proj-1.iam.gserviceaccount.com',
    private_key: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(rsa.privateKey))),
  }

  it('accepts a service account with a real PKCS#8 key', () => {
    expect(validatePlayServiceAccountJson(JSON.stringify(valid))).toEqual({ clientEmail: valid.client_email, projectId: 'proj-1' })
  })

  it.each([
    ['not json', '{'],
    ['wrong type', JSON.stringify({ ...valid, type: 'authorized_user' })],
    ['missing email', JSON.stringify({ ...valid, client_email: undefined })],
    ['missing key', JSON.stringify({ ...valid, private_key: '' })],
    ['malformed key', JSON.stringify({ ...valid, private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' })],
    ['array', '[]'],
  ])('rejects %s', (_label, text) => {
    expect(() => validatePlayServiceAccountJson(text)).toThrow(expect.objectContaining({ cause: expect.objectContaining({ error: 'invalid_play_service_account' }) }))
  })
})
