/**
 * Encryption + upload-capability helpers for stored native build credentials.
 *
 * - Credentials are sealed with AES-256-GCM. The AES key is derived (HKDF-SHA-256) from the
 *   BUILD_CREDENTIALS_ENCRYPTION_KEY runtime secret; the additional authenticated data binds
 *   the ciphertext to app_id + platform so a row cannot be replayed onto another app.
 * - key_version is a fingerprint of the secret that sealed the row. Rotation: set the new
 *   secret in BUILD_CREDENTIALS_ENCRYPTION_KEY and the old one in
 *   BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS; rows are re-sealed with the current key on
 *   their next write (and on read, via needsReseal).
 * - Upload tokens are HMAC-SHA-256 capabilities signed with BUILD_CREDENTIALS_UPLOAD_SECRET
 *   (falls back to API_SECRET, same pattern as notification secrets). They are single use:
 *   the signed nonce is recorded in build_credentials_upload_token_uses on first upload.
 *
 * Never log plaintext, ciphertext or tokens.
 */
import type { Context } from 'hono'
import type { BuildPlatform } from './build_credentials_validation.ts'
import { quickError } from './hono.ts'
import { getEnv } from './utils.ts'

export const BUILD_CREDENTIALS_ENCRYPTION_KEY_ENV = 'BUILD_CREDENTIALS_ENCRYPTION_KEY'
export const BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS_ENV = 'BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS'
export const BUILD_CREDENTIALS_UPLOAD_SECRET_ENV = 'BUILD_CREDENTIALS_UPLOAD_SECRET'
export const BUILD_CREDENTIALS_UPLOAD_TTL_SECONDS = 10 * 60

const ENVELOPE_VERSION = 'v1'
const MIN_SECRET_BYTES = 32
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCodePoint(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(value))
    throw new Error('invalid base64url')
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.codePointAt(i) ?? 0
  return bytes
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('')
}

function isStrongSecret(secret: string | undefined): secret is string {
  return !!secret && encoder.encode(secret).byteLength >= MIN_SECRET_BYTES
}

export async function buildCredentialsKeyVersion(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`capgo-build-credentials-kid:v1:${secret}`))
  return `k_${toHex(digest).slice(0, 16)}`
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('capgo-build-credentials'), info: encoder.encode('aes-256-gcm:v1') },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

function buildAad(appId: string, platform: BuildPlatform): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`capgo-build-credentials:${ENVELOPE_VERSION}\n${appId}\n${platform}`))
}

export interface SealedBuildCredentials {
  ciphertext: string
  keyVersion: string
}

export async function sealBuildCredentials(input: {
  secret: string
  appId: string
  platform: BuildPlatform
  credentials: Record<string, string>
}): Promise<SealedBuildCredentials> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveAesKey(input.secret)
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: buildAad(input.appId, input.platform) },
    key,
    encoder.encode(JSON.stringify(input.credentials)),
  )
  return {
    ciphertext: `${ENVELOPE_VERSION}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(encrypted))}`,
    keyVersion: await buildCredentialsKeyVersion(input.secret),
  }
}

export interface BuildCredentialsKeyring {
  current: string
  previous?: string
}

/**
 * Opens a sealed row. Picks the secret by key_version (current, then previous).
 * Throws on unknown key version, tampering, or an app_id/platform mismatch (AAD).
 */
export async function openBuildCredentials(input: {
  keyring: BuildCredentialsKeyring
  appId: string
  platform: BuildPlatform
  ciphertext: string
  keyVersion: string
}): Promise<{ credentials: Record<string, string>, needsReseal: boolean }> {
  const { keyring } = input
  let secret: string | undefined
  let needsReseal = false
  if (input.keyVersion === await buildCredentialsKeyVersion(keyring.current)) {
    secret = keyring.current
  }
  else if (keyring.previous && input.keyVersion === await buildCredentialsKeyVersion(keyring.previous)) {
    secret = keyring.previous
    needsReseal = true
  }
  if (!secret)
    throw new Error('build credentials sealed with an unknown key version')

  const [version, ivValue, cipherValue] = input.ciphertext.split(':')
  if (version !== ENVELOPE_VERSION || !ivValue || !cipherValue)
    throw new Error('invalid build credentials envelope')
  const key = await deriveAesKey(secret)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64Url(ivValue), additionalData: buildAad(input.appId, input.platform) },
    key,
    fromBase64Url(cipherValue),
  )
  const parsed = JSON.parse(decoder.decode(plaintext)) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('invalid build credentials payload')
  const credentials: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string')
      credentials[k] = v
  }
  return { credentials, needsReseal }
}

/** Runtime keyring; 503 when the encryption key is not configured (feature unavailable). */
export function getBuildCredentialsKeyring(c: Context): BuildCredentialsKeyring {
  const current = getEnv(c, BUILD_CREDENTIALS_ENCRYPTION_KEY_ENV)
  if (!isStrongSecret(current)) {
    throw quickError(503, 'build_credentials_unavailable', 'Stored build credentials are not configured on this server', {}, undefined, { alert: false })
  }
  const previous = getEnv(c, BUILD_CREDENTIALS_ENCRYPTION_KEY_PREVIOUS_ENV)
  return { current, previous: isStrongSecret(previous) ? previous : undefined }
}

// ---------------------------------------------------------------------------
// Upload capability token
// ---------------------------------------------------------------------------

export type BuildCredentialsWriteMode = 'replace' | 'merge'

export interface BuildCredentialsUploadClaims {
  app_id: string
  platform: BuildPlatform
  mode: BuildCredentialsWriteMode
  /** User that minted the token. */
  user_id: string
  /** API key row that minted the token; permission is re-checked against it at upload time. */
  apikey_id: number
  /** Unix seconds. */
  exp: number
  /** Random id; burned on first successful upload (single-use token). */
  nonce: string
}

const TOKEN_DOMAIN = 'capgo-build-credentials-upload:v1'

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${TOKEN_DOMAIN}.${value}`)))
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let i = 0; i < a.length; i++)
    diff |= a[i]! ^ b[i]!
  return diff === 0
}

export function getBuildCredentialsUploadSecret(c: Context): string {
  const secret = getEnv(c, BUILD_CREDENTIALS_UPLOAD_SECRET_ENV) || getEnv(c, 'API_SECRET')
  if (!secret)
    throw quickError(503, 'build_credentials_unavailable', 'Stored build credentials upload is not configured on this server', {}, undefined, { alert: false })
  return secret
}

export async function createBuildCredentialsUploadToken(secret: string, claims: Omit<BuildCredentialsUploadClaims, 'nonce'>): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify({ ...claims, nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(12))) })))
  return `${payload}.${toBase64Url(await hmac(secret, payload))}`
}

export type BuildCredentialsUploadTokenVerification =
  | { ok: true, claims: BuildCredentialsUploadClaims }
  | { ok: false, reason: 'invalid' | 'expired' }

export async function verifyBuildCredentialsUploadToken(secret: string, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<BuildCredentialsUploadTokenVerification> {
  if (token.length > 2048)
    return { ok: false, reason: 'invalid' }
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1])
    return { ok: false, reason: 'invalid' }
  const [payload, signature] = parts as [string, string]
  let provided: Uint8Array
  try {
    provided = fromBase64Url(signature)
  }
  catch {
    return { ok: false, reason: 'invalid' }
  }
  if (!constantTimeEqual(provided, await hmac(secret, payload)))
    return { ok: false, reason: 'invalid' }

  let claims: BuildCredentialsUploadClaims
  try {
    claims = JSON.parse(decoder.decode(fromBase64Url(payload))) as BuildCredentialsUploadClaims
  }
  catch {
    return { ok: false, reason: 'invalid' }
  }
  if (
    typeof claims?.app_id !== 'string'
    || (claims.platform !== 'ios' && claims.platform !== 'android')
    || (claims.mode !== 'replace' && claims.mode !== 'merge')
    || typeof claims.user_id !== 'string'
    || !Number.isSafeInteger(claims.apikey_id)
    || !Number.isSafeInteger(claims.exp)
    || typeof claims.nonce !== 'string'
    || !/^[\w-]{16,64}$/.test(claims.nonce)
  ) {
    return { ok: false, reason: 'invalid' }
  }
  if (claims.exp < nowSeconds)
    return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
