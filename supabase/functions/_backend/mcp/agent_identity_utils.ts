/**
 * Pure helpers for auth.md agent registration (https://workos.com/auth-md, service_auth flow).
 * Kept free of Hono / database imports so they can be unit tested directly.
 */
import { base64UrlDecode, base64UrlEncode, decryptWithCode, encryptWithCode, randomToken } from './oauth_utils.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Profile-specific polling grant for the claim ceremony (auth.md Step 4c). */
export const AGENT_AUTH_CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim'
/** Outer claim window: the registration must be claimed within a day. */
export const AGENT_REGISTRATION_TTL_SECONDS = 24 * 60 * 60
/** Each user_code is valid for ten minutes; the agent can mint a new one at the claim endpoint. */
export const AGENT_USER_CODE_TTL_SECONDS = 10 * 60
export const AGENT_POLL_INTERVAL_SECONDS = 5
/** Wrong codes allowed per user_code before the agent has to mint a new one. */
export const AGENT_USER_CODE_MAX_ATTEMPTS = 5

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function newClaimToken(): string {
  return `clm_${randomToken(32)}`
}

export function newClaimAttemptToken(): string {
  return randomToken(32)
}

/** Uniform six-digit code (rejection sampling avoids modulo bias). */
export function generateUserCode(): string {
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000
  const buffer = new Uint32Array(1)
  do
    crypto.getRandomValues(buffer)
  while (buffer[0] >= limit)
  return String(buffer[0] % 1_000_000).padStart(6, '0')
}

/** login_hint is an untyped string in auth.md v0.6; Capgo only accepts an email address. */
export function normalizeLoginHint(value: unknown): string | null {
  if (typeof value !== 'string')
    return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

/** j***@example.com: enough for the user to recognise the address without exposing it. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

async function contentKey(privateKey: CryptoKey, publicKey: CryptoKey, usage: KeyUsage): Promise<CryptoKey> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256))
  const material = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...encoder.encode('capgo-agent-identity:'), ...shared])))
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [usage])
}

/**
 * Per-registration key pair. The public half seals the API key when the user approves on the console;
 * the private half is stored encrypted with the claim_token, which only the agent holds. A database
 * dump alone can never reveal a minted API key.
 */
export async function createClaimKeyPair(claimToken: string): Promise<{ publicKey: string, encryptedPrivateKey: string }> {
  const pair = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair
  const publicKey = base64UrlEncode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer))
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  return { publicKey, encryptedPrivateKey: await encryptWithCode(JSON.stringify(privateJwk), claimToken) }
}

/** ECIES: ephemeral ECDH P-256 + AES-GCM. Output: ephemeralPublicKey.iv.ciphertext (base64url). */
export async function sealToClaimKey(publicKey: string, plaintext: string): Promise<string> {
  const recipient = await crypto.subtle.importKey('raw', base64UrlDecode(publicKey), ECDH, false, [])
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']) as CryptoKeyPair
  const key = await contentKey(ephemeral.privateKey, recipient, 'encrypt')
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey) as ArrayBuffer)
  return [ephemeralPublic, iv, new Uint8Array(ciphertext)].map(base64UrlEncode).join('.')
}

export async function openWithClaimToken(sealed: string, encryptedPrivateKey: string, claimToken: string): Promise<string | null> {
  const [ephemeralPart, ivPart, dataPart] = sealed.split('.')
  if (!ephemeralPart || !ivPart || !dataPart)
    return null
  const privateJwk = await decryptWithCode(encryptedPrivateKey, claimToken)
  if (!privateJwk)
    return null
  try {
    const privateKey = await crypto.subtle.importKey('jwk', JSON.parse(privateJwk) as JsonWebKey, ECDH, false, ['deriveBits'])
    const ephemeral = await crypto.subtle.importKey('raw', base64UrlDecode(ephemeralPart), ECDH, false, [])
    const key = await contentKey(privateKey, ephemeral, 'decrypt')
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64UrlDecode(ivPart) }, key, base64UrlDecode(dataPart))
    return decoder.decode(plaintext)
  }
  catch {
    return null
  }
}
