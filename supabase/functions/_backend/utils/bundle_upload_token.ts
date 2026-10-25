import type { Context } from 'hono'
import { quickError } from './hono.ts'
import { getEnv } from './utils.ts'

// Stateless upload session token: base64url(JSON payload) + '.' + base64url(HMAC-SHA256).
// `complete` / `abort` only trust options carried here, so they cannot diverge from
// what `prepare` checked.

export const BUNDLE_UPLOAD_TOKEN_TTL_SECONDS = 60 * 60
const TOKEN_PREFIX = 'bu1'
const encoder = new TextEncoder()
const algorithm = { name: 'HMAC', hash: 'SHA-256' } as const

export class BundleUploadTokenError extends Error {
  constructor(readonly reason: 'malformed' | 'signature' | 'expired') {
    super(`Invalid upload token (${reason})`)
  }
}

export function getBundleUploadSessionSecret(c: Context): string {
  const secret = getEnv(c, 'BUNDLE_UPLOAD_SESSION_SECRET') || getEnv(c, 'API_SECRET')
  if (!secret)
    throw quickError(503, 'upload_session_unavailable', 'Bundle upload sessions are not configured on this server')
  return secret
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[\w-]*$/.test(value))
    throw new BundleUploadTokenError('malformed')
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '='))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', encoder.encode(`capgo-bundle-upload:v1\n${secret}`), algorithm, false, [usage])
}

export async function signBundleUploadToken<T extends object>(secret: string, payload: T, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = BUNDLE_UPLOAD_TOKEN_TTL_SECONDS): Promise<{ token: string, expiresAt: number }> {
  const expiresAt = nowSeconds + ttlSeconds
  const body = toBase64Url(encoder.encode(JSON.stringify({ ...payload, iat: nowSeconds, exp: expiresAt })))
  const signed = `${TOKEN_PREFIX}.${body}`
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, await hmacKey(secret, 'sign'), encoder.encode(signed)))
  return { token: `${signed}.${toBase64Url(signature)}`, expiresAt }
}

export async function verifyBundleUploadToken<T extends object>(secret: string, token: unknown, nowSeconds = Math.floor(Date.now() / 1000)): Promise<T & { iat: number, exp: number }> {
  if (typeof token !== 'string' || token.length > 64 * 1024)
    throw new BundleUploadTokenError('malformed')
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX)
    throw new BundleUploadTokenError('malformed')
  let signature: Uint8Array<ArrayBuffer>
  let bodyBytes: Uint8Array<ArrayBuffer>
  try {
    signature = fromBase64Url(parts[2]!)
    bodyBytes = fromBase64Url(parts[1]!)
  }
  catch {
    throw new BundleUploadTokenError('malformed')
  }
  const valid = await crypto.subtle.verify(algorithm, await hmacKey(secret, 'verify'), signature, encoder.encode(`${parts[0]}.${parts[1]}`))
  if (!valid)
    throw new BundleUploadTokenError('signature')
  let payload: T & { iat: number, exp: number }
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes))
  }
  catch {
    throw new BundleUploadTokenError('malformed')
  }
  if (!payload || typeof payload !== 'object' || typeof payload.exp !== 'number')
    throw new BundleUploadTokenError('malformed')
  if (payload.exp <= nowSeconds)
    throw new BundleUploadTokenError('expired')
  return payload
}
