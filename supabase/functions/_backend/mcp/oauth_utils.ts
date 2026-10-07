/**
 * Pure helpers for the hosted MCP OAuth 2.1 authorization server.
 * Kept free of Hono / database imports so they can be unit tested directly.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Authorization requests must be approved on the consent page within this window. */
export const MCP_OAUTH_REQUEST_TTL_SECONDS = 10 * 60
/** Authorization codes are single use and short lived (OAuth 2.1 recommends <= 10 minutes). */
export const MCP_OAUTH_CODE_TTL_SECONDS = 60
export const MCP_OAUTH_SCOPE = 'capgo'
export const MAX_CLIENT_NAME_LENGTH = 100

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

async function sha256(value: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

export async function sha256Hex(value: string): Promise<string> {
  return [...await sha256(value)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length)
    return false
  let diff = 0
  for (let i = 0; i < left.length; i++)
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

/** RFC 7636 code_verifier: 43-128 chars of [A-Z a-z 0-9 - . _ ~]. */
export function isValidCodeVerifier(verifier: string): boolean {
  return /^[\w.~-]{43,128}$/.test(verifier)
}

/** S256 challenge is base64url(sha256(verifier)) = 43 chars. */
export function isValidCodeChallenge(challenge: string): boolean {
  return /^[\w-]{43}$/.test(challenge)
}

export async function verifyPkceS256(verifier: string, challenge: string): Promise<boolean> {
  if (!isValidCodeVerifier(verifier) || !isValidCodeChallenge(challenge))
    return false
  return timingSafeEqual(base64UrlEncode(await sha256(verifier)), challenge)
}

async function codeEncryptionKey(code: string): Promise<CryptoKey> {
  // The code itself is the key material: only the party holding the code (the OAuth client,
  // after the redirect) can decrypt the minted API key. A database dump alone reveals nothing.
  const raw = await sha256(`capgo-mcp-oauth-token:${code}`)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function encryptWithCode(plaintext: string, code: string): Promise<string> {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await codeEncryptionKey(code), encoder.encode(plaintext))
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`
}

export async function decryptWithCode(payload: string, code: string): Promise<string | null> {
  const [ivPart, dataPart] = payload.split('.')
  if (!ivPart || !dataPart)
    return null
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64UrlDecode(ivPart) },
      await codeEncryptionKey(code),
      base64UrlDecode(dataPart),
    )
    return decoder.decode(plaintext)
  }
  catch {
    return null
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

const FORBIDDEN_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'blob:', 'vbscript:', 'about:'])

/**
 * Redirect URIs allowed at registration: https anywhere, http only on loopback (RFC 8252 §7.3),
 * and private-use schemes for native / desktop clients (cursor://, vscode://, ...). No fragments.
 */
export function isAllowedRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000)
    return false
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return false
  }
  if (url.hash)
    return false
  if (url.protocol === 'https:')
    return true
  if (url.protocol === 'http:')
    return isLoopbackHost(url.hostname)
  if (FORBIDDEN_REDIRECT_SCHEMES.has(url.protocol))
    return false
  // Private-use URI scheme (RFC 8252 §7.1): reverse-domain or app-name style.
  return /^[a-z][\w+.-]*:$/i.test(url.protocol)
}

/**
 * Exact match against a registered redirect URI, except that loopback redirect URIs may use
 * any port (RFC 8252 §7.3) because native clients bind an ephemeral port at runtime.
 */
export function redirectUriMatches(registered: readonly string[], candidate: string): boolean {
  if (registered.includes(candidate))
    return true
  let candidateUrl: URL
  try {
    candidateUrl = new URL(candidate)
  }
  catch {
    return false
  }
  if (candidateUrl.protocol !== 'http:' || !isLoopbackHost(candidateUrl.hostname))
    return false
  return registered.some((entry) => {
    try {
      const url = new URL(entry)
      return url.protocol === 'http:'
        && url.hostname === candidateUrl.hostname
        && url.pathname === candidateUrl.pathname
        && url.search === candidateUrl.search
    }
    catch {
      return false
    }
  })
}

export function buildRedirectUrl(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null)
      url.searchParams.set(key, value)
  }
  return url.toString()
}

export function sanitizeClientName(value: unknown, fallback: string): string {
  const name = typeof value === 'string'
    ? [...value].filter((char) => {
        const code = char.codePointAt(0) ?? 0
        return code > 31 && code !== 127
      }).join('').trim()
    : ''
  return (name || fallback).slice(0, MAX_CLIENT_NAME_LENGTH)
}

/** OAuth Client ID Metadata Document client ids are https URLs with a path (draft-ietf-oauth-client-id-metadata-document). */
export function isClientIdMetadataUrl(clientId: string): boolean {
  try {
    const url = new URL(clientId)
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username && !url.password
  }
  catch {
    return false
  }
}
