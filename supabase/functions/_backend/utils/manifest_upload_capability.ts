import type { Context } from 'hono'
import { getEnv } from './utils.ts'

export const MANIFEST_UPLOAD_CAPABILITY_HEADER = 'X-Capgo-Upload-Token'
export const MANIFEST_UPLOAD_CAPABILITY_SECRET_ENV = 'MANIFEST_UPLOAD_CAPABILITY_SECRET'
export const MANIFEST_UPLOAD_CAPABILITY_KEY_ID_ENV = 'MANIFEST_UPLOAD_CAPABILITY_KEY_ID'
export const MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS_ENV = 'MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS'
export const MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS = 10 * 60
export const MANIFEST_UPLOAD_CAPABILITY_CLOCK_SKEW_SECONDS = 60

const CAPABILITY_VERSION = 'v1'
const CAPABILITY_SCOPE = 'tus-write'
const MIN_SECRET_BYTES = 32
const encoder = new TextEncoder()
const hmacAlgorithm = { name: 'HMAC', hash: 'SHA-256' } as const
const keyIdPattern = /^[A-Za-z0-9_-]{1,64}$/
const signaturePattern = /^[A-Za-z0-9_-]{43}$/
const positiveIntegerPattern = /^[1-9]\d*$/

export interface ManifestUploadCapabilityClaims {
  expiresAt: number
  keyId: string
  manifestUploadAutoEnabled: boolean
  versionId: number
}

export interface ManifestUploadCapabilitySigningInput extends ManifestUploadCapabilityClaims {
  secret: string
}

export interface ManifestUploadCapabilityInput extends ManifestUploadCapabilitySigningInput {
  path: string
}

export interface ManifestUploadCapabilityToken {
  token: string
  tokenPrefix: string
  uploadToken: string
}

export interface ManifestUploadCapabilitySigner {
  tokenPrefix: string
  create: (path: string) => Promise<ManifestUploadCapabilityToken>
}

export type ManifestUploadCapabilityVerification =
  | { ok: true, claims: ManifestUploadCapabilityClaims }
  | { ok: false, reason: 'expired', claims: ManifestUploadCapabilityClaims }
  | { ok: false, reason: 'invalid' | 'unavailable' }

function isValidSecret(secret: string): boolean {
  return encoder.encode(secret).byteLength >= MIN_SECRET_BYTES
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function buildPayload(claims: ManifestUploadCapabilityClaims, path: string): ArrayBuffer {
  return encoder.encode([
    'capgo-manifest-upload:v1',
    claims.keyId,
    claims.expiresAt.toString(),
    claims.versionId.toString(),
    claims.manifestUploadAutoEnabled ? '1' : '0',
    CAPABILITY_SCOPE,
    path,
  ].join('\n')).buffer as ArrayBuffer
}

function encodeBase64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!signaturePattern.test(value))
    return null

  try {
    return Uint8Array.from(
      atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(44, '=')),
      char => char.charCodeAt(0),
    ).buffer as ArrayBuffer
  }
  catch {
    return null
  }
}

async function importHmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', encoder.encode(secret), hmacAlgorithm, false, [usage])
}

function parseCanonicalPositiveInteger(rawValue: string): number | null {
  if (!positiveIntegerPattern.test(rawValue))
    return null

  const value = Number(rawValue)
  return isPositiveSafeInteger(value) && value.toString() === rawValue ? value : null
}

function parseToken(token: string): { claims: ManifestUploadCapabilityClaims, signature: ArrayBuffer } | null {
  if (token.length > 512)
    return null

  const [version, keyId, rawExpiresAt, rawVersionId, rawAutoEnabled, rawSignature, extra] = token.split('.')
  const expiresAt = parseCanonicalPositiveInteger(rawExpiresAt ?? '')
  const versionId = parseCanonicalPositiveInteger(rawVersionId ?? '')
  const signature = decodeBase64Url(rawSignature ?? '')

  if (
    version !== CAPABILITY_VERSION
    || !keyIdPattern.test(keyId ?? '')
    || expiresAt == null
    || versionId == null
    || (rawAutoEnabled !== '0' && rawAutoEnabled !== '1')
    || signature == null
    || extra != null
  ) {
    return null
  }

  return {
    claims: {
      expiresAt,
      keyId,
      manifestUploadAutoEnabled: rawAutoEnabled === '1',
      versionId,
    },
    signature,
  }
}

function validateSigningInput(input: ManifestUploadCapabilitySigningInput, issuedAtUnixSeconds: number): void {
  if (
    !keyIdPattern.test(input.keyId)
    || !isValidSecret(input.secret)
    || !isPositiveSafeInteger(input.expiresAt)
    || !isPositiveSafeInteger(input.versionId)
    || !Number.isSafeInteger(issuedAtUnixSeconds)
    || issuedAtUnixSeconds < 0
    || input.expiresAt <= issuedAtUnixSeconds
    || input.expiresAt - issuedAtUnixSeconds > MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS
  ) {
    throw new Error('Cannot sign invalid manifest upload capability')
  }
}

export function getManifestUploadCapabilitySigningKey(c: Context): { keyId: string, secret: string } | null {
  const keyId = getEnv(c, MANIFEST_UPLOAD_CAPABILITY_KEY_ID_ENV).trim()
  const secret = getEnv(c, MANIFEST_UPLOAD_CAPABILITY_SECRET_ENV)
  if (!keyIdPattern.test(keyId) || !isValidSecret(secret))
    return null
  return { keyId, secret }
}

function getPreviousSecrets(c: Context): Record<string, string> {
  const rawValue = getEnv(c, MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS_ENV).trim()
  if (!rawValue)
    return {}

  try {
    const parsedValue = JSON.parse(rawValue) as unknown
    if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue))
      return {}

    return Object.fromEntries(Object.entries(parsedValue).filter(([keyId, secret]) =>
      keyIdPattern.test(keyId) && typeof secret === 'string' && isValidSecret(secret),
    ))
  }
  catch {
    return {}
  }
}

export function getManifestUploadCapabilityVerificationSecret(c: Context, keyId: string): string | null {
  const currentKey = getManifestUploadCapabilitySigningKey(c)
  if (currentKey?.keyId === keyId)
    return currentKey.secret

  const previousSecrets = getPreviousSecrets(c)
  return Object.hasOwn(previousSecrets, keyId) ? previousSecrets[keyId] ?? null : null
}

function getManifestUploadCapabilityVerificationKey(c: Context, keyId: string): { configured: boolean, secret: string | null } {
  const currentKey = getManifestUploadCapabilitySigningKey(c)
  const previousSecrets = getPreviousSecrets(c)
  const previousSecret = Object.hasOwn(previousSecrets, keyId) ? previousSecrets[keyId] ?? null : null
  return {
    configured: currentKey != null || Object.keys(previousSecrets).length > 0,
    secret: currentKey?.keyId === keyId ? currentKey.secret : previousSecret,
  }
}

/**
 * Prepare a signer once and reuse its imported HMAC key for every path in a manifest.
 */
export async function createManifestUploadCapabilitySigner(
  input: ManifestUploadCapabilitySigningInput,
  issuedAtUnixSeconds = Math.floor(Date.now() / 1000),
): Promise<ManifestUploadCapabilitySigner> {
  validateSigningInput(input, issuedAtUnixSeconds)

  const tokenPrefix = `${CAPABILITY_VERSION}.${input.keyId}.${input.expiresAt}.${input.versionId}.${input.manifestUploadAutoEnabled ? '1' : '0'}.`
  const hmacKey = await importHmacKey(input.secret, 'sign')
  return {
    tokenPrefix,
    create: async (path) => {
      if (!path)
        throw new Error('Cannot sign invalid manifest upload capability')

      const signature = await crypto.subtle.sign(hmacAlgorithm, hmacKey, buildPayload(input, path))
      const uploadToken = encodeBase64Url(signature)
      return {
        token: `${tokenPrefix}${uploadToken}`,
        tokenPrefix,
        uploadToken,
      }
    },
  }
}

export async function createManifestUploadCapability(
  input: ManifestUploadCapabilityInput,
  issuedAtUnixSeconds = Math.floor(Date.now() / 1000),
): Promise<ManifestUploadCapabilityToken> {
  const signer = await createManifestUploadCapabilitySigner(input, issuedAtUnixSeconds)
  return await signer.create(input.path)
}

export async function verifyManifestUploadCapability(
  c: Context,
  token: string,
  path: string,
  nowUnixSeconds = Math.floor(Date.now() / 1000),
): Promise<ManifestUploadCapabilityVerification> {
  const parsedToken = parseToken(token)
  if (!parsedToken || !path || !Number.isSafeInteger(nowUnixSeconds) || nowUnixSeconds < 0)
    return { ok: false, reason: 'invalid' }

  const verificationKey = getManifestUploadCapabilityVerificationKey(c, parsedToken.claims.keyId)
  if (!verificationKey.secret)
    return { ok: false, reason: verificationKey.configured ? 'invalid' : 'unavailable' }

  const signatureIsValid = await crypto.subtle.verify(
    hmacAlgorithm,
    await importHmacKey(verificationKey.secret, 'verify'),
    parsedToken.signature,
    buildPayload(parsedToken.claims, path),
  )
  if (!signatureIsValid)
    return { ok: false, reason: 'invalid' }

  // Issuance enforces the ten-minute lifetime. This grace only prevents small
  // clock differences between the service issuing and verifying the token.
  if (
    parsedToken.claims.expiresAt - nowUnixSeconds
    > MANIFEST_UPLOAD_CAPABILITY_MAX_LIFETIME_SECONDS + MANIFEST_UPLOAD_CAPABILITY_CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, reason: 'invalid' }
  }

  if (parsedToken.claims.expiresAt <= nowUnixSeconds)
    return { ok: false, reason: 'expired', claims: parsedToken.claims }

  return { ok: true, claims: parsedToken.claims }
}
