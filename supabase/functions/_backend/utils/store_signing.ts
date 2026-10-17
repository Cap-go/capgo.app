/**
 * Server-side store signing helpers.
 *
 * Port of the Capgo CLI's iOS automatic signing (App Store Connect API:
 * certificate + bundle id + App Store profile) and Android upload keystore
 * generation, so Capgo can produce signing material from uploaded store keys
 * only. Runtime-agnostic: WebCrypto + fetch + node-forge (pure JS), no Node
 * built-ins, so it runs on Cloudflare Workers and Supabase Deno edge functions.
 */
import { HTTPException } from 'hono/http-exception'
import forge from 'node-forge'
import { quickError, simpleError } from './hono.ts'

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1'
const ASC_AUDIENCE = 'appstoreconnect-v1'
// Apple caps ASC tokens at 20 minutes; stay a minute under it so small clock
// skew between us and Apple never makes the token look too long-lived (401).
const ASC_TOKEN_TTL_SECONDS = 19 * 60
const ASC_FETCH_TIMEOUT_MS = 30_000
const RANDOM_PASSWORD_BYTES = 24
const ANDROID_KEYSTORE_VALIDITY_YEARS = 30

// ─── Types ─────────────────────────────────────────────────────────

export interface AscCredentials {
  /** App Store Connect API Key ID (10 chars) */
  keyId: string
  /** App Store Connect Issuer ID (UUID) */
  issuerId: string
  /** Contents of the AuthKey_XXXX.p8 file (PKCS#8 PEM, EC P-256) */
  privateKeyP8: string
}

export type AscKeyVerification
  = | { ok: true }
    | { ok: false, reason: 'invalid_private_key' | 'key_rejected' | 'agreements_missing', message: string }

export interface AscAppSummary {
  id: string
  name: string
}

export interface AscCertificateSummary {
  id: string
  name: string
  serialNumber: string
  expirationDate: string
}

export interface DistributionCertificateResult {
  certificateId: string
  /** Base64 DER certificate as returned by Apple */
  certificateContentBase64: string
  privateKeyPem: string
  teamId: string
  expirationDate: string
  /** PKCS#12 (3DES, macOS `security import` compatible) with cert + key */
  p12Base64: string
  p12Password: string
}

export interface AppStoreProfileResult {
  profileId: string
  name: string
  profileContentBase64: string
}

export interface MobileProvisionInfo {
  name: string
  uuid: string
  teamId: string
  bundleId: string
  expirationDate: string
  isAppStore: boolean
}

export interface AndroidKeystoreOptions {
  alias: string
  commonName: string
  organization?: string
}

export interface AndroidKeystoreResult {
  keystoreBase64: string
  alias: string
  storePassword: string
  keyPassword: string
  /** Colon-separated uppercase hex, keytool style */
  sha1Fingerprint: string
  sha256Fingerprint: string
}

export interface PlayServiceAccountInfo {
  clientEmail: string
  projectId: string
}

// ─── Errors ────────────────────────────────────────────────────────

/** Error raised for any non-2xx App Store Connect response. Handled by onError like quickError. */
export class AscApiError extends HTTPException {
  readonly ascStatus: number
  readonly ascCode?: string
  constructor(ascStatus: number, message: string, ascCode?: string, errorCode = 'asc_api_error') {
    // Never forward Apple's 401/403 as our own status: the console treats 401 as a logout.
    const status = ascStatus === 429 ? 429 : ascStatus >= 500 || ascStatus === 0 ? 502 : 400
    super(status, {
      message,
      cause: { error: errorCode, message, moreInfo: { ascStatus, ascCode } },
    })
    this.name = 'AscApiError'
    this.ascStatus = ascStatus
    this.ascCode = ascCode
  }
}

/** Apple refused to create a distribution certificate because the team is at its limit. */
export class AscCertificateLimitError extends HTTPException {
  readonly certificates: AscCertificateSummary[]
  constructor(certificates: AscCertificateSummary[]) {
    const message = `Apple Distribution certificate limit reached (${certificates.length} existing). Revoke an unused certificate in the Apple Developer portal and retry.`
    super(400, {
      message,
      cause: { error: 'asc_certificate_limit', message, moreInfo: { certificates } },
    })
    this.name = 'AscCertificateLimitError'
    this.certificates = certificates
  }
}

// ─── Byte helpers (no Buffer) ──────────────────────────────────────

function bytesToBinary(bytes: Uint8Array): string {
  let out = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk)
    out += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return out
}

function binaryToBytes(binary: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i) & 0xFF
  return bytes
}

function base64UrlEncode(input: Uint8Array | string): string {
  const binary = typeof input === 'string' ? bytesToBinary(new TextEncoder().encode(input)) : bytesToBinary(input)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64ToBinary(base64: string): string {
  return atob(base64.replace(/\s+/g, ''))
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

/** URL-safe random password (24 bytes → 32 chars). */
function generateRandomPassword(): string {
  return base64UrlEncode(randomBytes(RANDOM_PASSWORD_BYTES))
}

/** Positive random 16-byte serial number in hex (forge format). */
function randomSerialHex(): string {
  const bytes = randomBytes(16)
  bytes[0] = bytes[0] & 0x7F | 0x01
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function fingerprint(md: forge.md.MessageDigest, derBinary: string): string {
  md.update(derBinary)
  return md.digest().toHex().toUpperCase().match(/.{2}/g)!.join(':')
}

/** Convert a DER ECDSA signature to raw r||s (P1363). Only used if a runtime returns DER. */
function derEcdsaToRaw(der: Uint8Array, size = 32): Uint8Array {
  if (der.length === size * 2)
    return der
  const asn1 = forge.asn1.fromDer(bytesToBinary(der))
  const parts = (asn1.value as forge.asn1.Asn1[]).map((part) => {
    let value = binaryToBytes(part.value as string)
    while (value.length > size && value[0] === 0)
      value = value.subarray(1)
    const padded = new Uint8Array(size)
    padded.set(value, size - value.length)
    return padded
  })
  const raw = new Uint8Array(size * 2)
  raw.set(parts[0], 0)
  raw.set(parts[1], size)
  return raw
}

// ─── App Store Connect JWT ─────────────────────────────────────────

async function importP8(privateKeyP8: string): Promise<CryptoKey> {
  const body = privateKeyP8
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/-----END [A-Z ]*PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  try {
    if (!body)
      throw new Error('empty key')
    return await crypto.subtle.importKey(
      'pkcs8',
      binaryToBytes(base64ToBinary(body)),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
  }
  catch (error) {
    return simpleError('asc_invalid_private_key', 'The App Store Connect .p8 key is not a valid PKCS#8 EC P-256 private key', {}, error)
  }
}

/** Create an ES256 App Store Connect API token (aud appstoreconnect-v1, ~20 min lifetime). */
export async function createAscToken({ keyId, issuerId, privateKeyP8 }: AscCredentials): Promise<string> {
  if (!keyId?.trim() || !issuerId?.trim())
    simpleError('asc_invalid_credentials', 'App Store Connect key ID and issuer ID are required')
  const key = await importP8(privateKeyP8 ?? '')
  const now = Math.floor(Date.now() / 1000)
  const header = base64UrlEncode(JSON.stringify({ alg: 'ES256', kid: keyId.trim(), typ: 'JWT' }))
  const payload = base64UrlEncode(JSON.stringify({ iss: issuerId.trim(), iat: now, exp: now + ASC_TOKEN_TTL_SECONDS, aud: ASC_AUDIENCE }))
  const signingInput = `${header}.${payload}`
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  ))
  return `${signingInput}.${base64UrlEncode(derEcdsaToRaw(signature))}`
}

// ─── App Store Connect fetch ───────────────────────────────────────

interface AppleApiErrorBody {
  status?: string
  code?: string
  title?: string
  detail?: string
}

async function ascFetch(token: string, path: string, init: RequestInit = {}): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${ASC_BASE_URL}${path}`, {
      ...init,
      signal: init.signal ?? (typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ASC_FETCH_TIMEOUT_MS) : undefined),
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  }
  catch (error) {
    throw new AscApiError(0, `App Store Connect request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (res.status === 204)
    return null
  const body: any = await res.json().catch(() => null)
  if (!res.ok) {
    const first: AppleApiErrorBody | undefined = body?.errors?.[0]
    if (first)
      throw new AscApiError(res.status, `Apple API error (${res.status}): ${first.title ?? ''} — ${first.detail ?? ''} (${first.code ?? ''})`, first.code)
    throw new AscApiError(res.status, `Apple API error: HTTP ${res.status} ${res.statusText}`)
  }
  return body
}

async function ascRequest(creds: AscCredentials, path: string, init?: RequestInit): Promise<any> {
  return ascFetch(await createAscToken(creds), path, init)
}

const ASC_AGREEMENTS_MESSAGE = 'Apple is blocking App Store Connect API access because a required agreement is unsigned or expired. The Account Holder must accept it in App Store Connect > Business.'
const ASC_KEY_REJECTED_MESSAGE = 'Apple rejected the App Store Connect API key. Check the .p8 file, Key ID, Issuer ID, and that the key has Admin or App Manager access.'

function isAgreementsError(status: number, code: string | undefined, message: string): boolean {
  return status === 403 && (
    code === 'FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED'
    || code === 'FORBIDDEN_ERROR.PLA_NOT_ACCEPTED'
    || /\bPLA_NOT_ACCEPTED\b|required agreement|program license agreement/i.test(message)
  )
}

// ─── App Store Connect API ─────────────────────────────────────────

/** Check that the key authenticates against App Store Connect. Network/5xx errors are thrown. */
export async function verifyAscKey(creds: AscCredentials): Promise<AscKeyVerification> {
  let token: string
  try {
    token = await createAscToken(creds)
  }
  catch (error) {
    return { ok: false, reason: 'invalid_private_key', message: error instanceof Error ? error.message : 'Invalid App Store Connect key' }
  }
  try {
    await ascFetch(token, '/apps?limit=1')
    return { ok: true }
  }
  catch (error) {
    if (error instanceof AscApiError && (error.ascStatus === 401 || error.ascStatus === 403)) {
      if (isAgreementsError(error.ascStatus, error.ascCode, error.message))
        return { ok: false, reason: 'agreements_missing', message: ASC_AGREEMENTS_MESSAGE }
      return { ok: false, reason: 'key_rejected', message: ASC_KEY_REJECTED_MESSAGE }
    }
    throw error
  }
}

/** Find the App Store Connect app record for an exact bundle id. */
export async function findAscApp(creds: AscCredentials, bundleId: string): Promise<AscAppSummary | null> {
  const body = await ascRequest(creds, `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=200`)
  const app = (body?.data ?? []).find((item: any) => item?.attributes?.bundleId === bundleId)
  return app ? { id: String(app.id), name: String(app.attributes?.name ?? '') } : null
}

/** Return the Apple resource id of a bundle id, registering it (platform IOS) when missing. */
export async function ensureAscBundleId(creds: AscCredentials, bundleId: string, name: string): Promise<string> {
  const token = await createAscToken(creds)
  const search = await ascFetch(token, `/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`)
  const existing = (search?.data ?? []).find((item: any) => item?.attributes?.identifier === bundleId)
  if (existing)
    return String(existing.id)

  // Apple only accepts alphanumerics and spaces in the bundle id display name.
  const sanitizedName = (name || '').replace(/[^a-z0-9]+/gi, ' ').trim()
    || `Capgo ${bundleId.replace(/[^a-z0-9]+/gi, ' ').trim()}`
  const created = await ascFetch(token, '/bundleIds', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'bundleIds',
        attributes: { identifier: bundleId, name: sanitizedName, platform: 'IOS' },
      },
    }),
  })
  if (!created?.data?.id)
    quickError(502, 'asc_invalid_response', 'App Store Connect did not return the created bundle id')
  return String(created.data.id)
}

/** 2048-bit RSA key pair. Uses native WebCrypto (fast) and falls back to pure-JS forge. */
async function generateRsaKeyPair(): Promise<forge.pki.rsa.KeyPair> {
  try {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
    const privateKey = forge.pki.privateKeyFromAsn1(forge.asn1.fromDer(bytesToBinary(pkcs8))) as forge.pki.rsa.PrivateKey
    const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)
    return { privateKey, publicKey }
  }
  catch {
    return forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  }
}

function certificateFromBase64(certificateContentBase64: string): forge.pki.Certificate {
  return forge.pki.certificateFromAsn1(forge.asn1.fromDer(base64ToBinary(certificateContentBase64)))
}

function teamIdFromCertificate(cert: forge.pki.Certificate): string {
  const ou = cert.subject.getField('OU')
  return typeof ou?.value === 'string' ? ou.value : ''
}

async function listDistributionCertificates(token: string): Promise<AscCertificateSummary[]> {
  const body = await ascFetch(token, '/certificates?filter[certificateType]=DISTRIBUTION&limit=200')
  return (body?.data ?? []).map((item: any): AscCertificateSummary => ({
    id: String(item.id),
    name: String(item.attributes?.name || item.attributes?.displayName || 'Apple Distribution'),
    serialNumber: String(item.attributes?.serialNumber ?? ''),
    expirationDate: String(item.attributes?.expirationDate ?? ''),
  }))
}

/**
 * Generate an RSA key + CSR and create an Apple Distribution certificate.
 * Throws {@link AscCertificateLimitError} when the team is at its certificate limit.
 */
export async function createDistributionCertificate(creds: AscCredentials): Promise<DistributionCertificateResult> {
  const token = await createAscToken(creds)
  const keys = await generateRsaKeyPair()
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'commonName', value: 'Capgo Build' },
    { name: 'organizationName', value: 'Capgo' },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())
  const csrPem = forge.pki.certificationRequestToPem(csr)

  let body: any
  try {
    body = await ascFetch(token, '/certificates', {
      method: 'POST',
      body: JSON.stringify({
        data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csrPem } },
      }),
    })
  }
  catch (error) {
    const message = error instanceof Error ? error.message : ''
    const definite = /maximum number of certificates|already have a current .*certificate/i.test(message)
    const ambiguous = message.includes('ENTITY_ERROR.ATTRIBUTE.INVALID') || message.includes('There is a problem with the request entity')
    if (definite || ambiguous) {
      let existing: AscCertificateSummary[] = []
      try {
        existing = await listDistributionCertificates(token)
      }
      catch {
        if (!definite)
          throw error
      }
      if (definite || existing.length > 0)
        throw new AscCertificateLimitError(existing)
    }
    throw error
  }

  const certificateContentBase64: unknown = body?.data?.attributes?.certificateContent
  if (!body?.data?.id || typeof certificateContentBase64 !== 'string')
    quickError(502, 'asc_invalid_response', 'App Store Connect did not return the created certificate')

  let cert: forge.pki.Certificate
  try {
    cert = certificateFromBase64(certificateContentBase64)
  }
  catch (error) {
    return quickError(502, 'asc_invalid_response', 'App Store Connect returned an unreadable certificate', {}, error)
  }
  const p12Password = generateRandomPassword()
  // Legacy 3DES: macOS `security import` rejects forge's default PBES2/AES p12.
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], p12Password, { algorithm: '3des' })

  return {
    certificateId: String(body.data.id),
    certificateContentBase64,
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    teamId: teamIdFromCertificate(cert),
    expirationDate: String(body.data.attributes?.expirationDate ?? cert.validity.notAfter.toISOString()),
    p12Base64: forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes()),
    p12Password,
  }
}

/** Create an IOS_APP_STORE profile; an existing profile with the same name is deleted first. */
export async function createAppStoreProfile(
  creds: AscCredentials,
  { bundleIdResourceId, certificateId, name }: { bundleIdResourceId: string, certificateId: string, name: string },
): Promise<AppStoreProfileResult> {
  const token = await createAscToken(creds)
  const existing = await ascFetch(token, `/profiles?filter[name]=${encodeURIComponent(name)}&limit=200`)
  for (const profile of existing?.data ?? []) {
    if (profile?.attributes?.name === name)
      await ascFetch(token, `/profiles/${encodeURIComponent(String(profile.id))}`, { method: 'DELETE' })
  }

  const body = await ascFetch(token, '/profiles', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundleIdResourceId } },
          certificates: { data: [{ type: 'certificates', id: certificateId }] },
        },
      },
    }),
  })
  const profileContentBase64: unknown = body?.data?.attributes?.profileContent
  if (!body?.data?.id || typeof profileContentBase64 !== 'string')
    quickError(502, 'asc_invalid_response', 'App Store Connect did not return the created provisioning profile')
  return {
    profileId: String(body.data.id),
    name: String(body.data.attributes?.name ?? name),
    profileContentBase64,
  }
}

// ─── Mobileprovision ───────────────────────────────────────────────

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&amp;/g, '&')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function plistValue(xml: string, key: string, tag = 'string'): string {
  const match = xml.match(new RegExp(`<key>${escapeRegex(key)}</key>\\s*<${tag}>([^<]*)</${tag}>`))
  return match ? decodeXmlEntities(match[1].trim()) : ''
}

/**
 * Parse a base64 .mobileprovision by extracting the plist embedded in the CMS
 * envelope. The CMS signature is NOT verified.
 */
export function parseMobileProvision(base64: string): MobileProvisionInfo {
  let binary: string
  try {
    binary = base64ToBinary(base64)
  }
  catch (error) {
    return simpleError('invalid_mobileprovision', 'Provisioning profile is not valid base64', {}, error)
  }
  const start = binary.indexOf('<?xml')
  const end = start === -1 ? -1 : binary.indexOf('</plist>', start)
  if (start === -1 || end === -1)
    simpleError('invalid_mobileprovision', 'No embedded plist found in the provisioning profile')
  const xml = new TextDecoder().decode(binaryToBytes(binary.slice(start, end + '</plist>'.length)))

  const name = plistValue(xml, 'Name')
  if (!name)
    simpleError('invalid_mobileprovision', 'Provisioning profile is missing its Name')

  const entitlements = xml.match(/<key>Entitlements<\/key>\s*<dict>([\s\S]*?)<\/dict>/)?.[1] ?? ''
  const applicationIdentifier = plistValue(entitlements, 'application-identifier')
  const dot = applicationIdentifier.indexOf('.')
  const bundleId = dot === -1 ? applicationIdentifier : applicationIdentifier.slice(dot + 1)

  const teamArray = xml.match(/<key>TeamIdentifier<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ''
  const teamId = teamArray.match(/<string>([^<]+)<\/string>/)?.[1]?.trim()
    || (dot === -1 ? '' : applicationIdentifier.slice(0, dot))

  const provisionsAllDevices = /<key>ProvisionsAllDevices<\/key>\s*<true\s*\/>/.test(xml)
  const hasProvisionedDevices = /<key>ProvisionedDevices<\/key>\s*<array>/.test(xml)

  return {
    name,
    uuid: plistValue(xml, 'UUID'),
    teamId,
    bundleId,
    expirationDate: plistValue(xml, 'ExpirationDate', 'date'),
    isAppStore: !provisionsAllDevices && !hasProvisionedDevices,
  }
}

/** Build the builder's CAPGO_IOS_PROVISIONING_MAP JSON: `{ [bundleId]: { profile, name } }`. */
export function buildIosProvisioningMap(bundleId: string, profileBase64: string, profileName: string): string {
  return JSON.stringify({ [bundleId]: { profile: profileBase64, name: profileName } })
}

// ─── Android ───────────────────────────────────────────────────────

/**
 * Generate an Android upload keystore: RSA 2048 self-signed cert valid 30
 * years in a PKCS#12 (3DES) keystore. Store and key passwords are identical
 * (PKCS#12 keystores used by Gradle require it).
 */
export async function generateAndroidUploadKeystore({ alias, commonName, organization }: AndroidKeystoreOptions): Promise<AndroidKeystoreResult> {
  if (!alias?.trim())
    simpleError('invalid_keystore_options', 'Keystore alias is required')
  if (!commonName?.trim())
    simpleError('invalid_keystore_options', 'Keystore common name is required')

  const keys = await generateRsaKeyPair()
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerialHex()
  const notBefore = new Date()
  const notAfter = new Date(notBefore)
  notAfter.setUTCFullYear(notBefore.getUTCFullYear() + ANDROID_KEYSTORE_VALIDITY_YEARS)
  cert.validity.notBefore = notBefore
  cert.validity.notAfter = notAfter
  const subject: forge.pki.CertificateField[] = [{ name: 'commonName', value: commonName.trim() }]
  if (organization?.trim())
    subject.push({ name: 'organizationName', value: organization.trim() })
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.sign(keys.privateKey, forge.md.sha256.create())

  const password = generateRandomPassword()
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: '3des', friendlyName: alias })
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes()

  return {
    keystoreBase64: forge.util.encode64(forge.asn1.toDer(p12Asn1).getBytes()),
    alias,
    storePassword: password,
    keyPassword: password,
    sha1Fingerprint: fingerprint(forge.md.sha1.create(), certDer),
    sha256Fingerprint: fingerprint(forge.md.sha256.create(), certDer),
  }
}

/** Validate a Google Play service account JSON key. Throws `invalid_play_service_account`. */
export function validatePlayServiceAccountJson(text: string): PlayServiceAccountInfo {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  }
  catch (error) {
    return simpleError('invalid_play_service_account', 'Service account file is not valid JSON', {}, error)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    simpleError('invalid_play_service_account', 'Service account file must be a JSON object')
  if (parsed.type !== 'service_account')
    simpleError('invalid_play_service_account', 'JSON key is not a Google service account (type must be "service_account")')
  if (typeof parsed.client_email !== 'string' || !parsed.client_email.includes('@'))
    simpleError('invalid_play_service_account', 'Service account JSON is missing client_email')
  if (typeof parsed.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY'))
    simpleError('invalid_play_service_account', 'Service account JSON is missing private_key')
  return {
    clientEmail: parsed.client_email,
    projectId: typeof parsed.project_id === 'string' ? parsed.project_id : '',
  }
}
