import type { Context } from 'hono'
import { base64url, compactDecrypt, CompactEncrypt } from 'jose'
import { closeClient, getPgClient } from './pg.ts'
import { getEnv } from './utils.ts'

export function appleRandom() {
  return base64url.encode(crypto.getRandomValues(new Uint8Array(32)))
}

export async function appleHash(value: string) {
  return base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

// Stored credentials are short-lived and encrypted with server-only key material.
async function encryptionKey(c: Context) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`capgo-apple-oauth-v1:${getEnv(c, 'APPLE_SIGN_IN_PRIVATE_KEY')}`)))
}

export async function sealAppleCredential(c: Context, value: unknown) {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value)))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
    .encrypt(await encryptionKey(c))
}

export async function openAppleCredential<T>(c: Context, value: string): Promise<T> {
  const { plaintext } = await compactDecrypt(value, await encryptionKey(c), { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] })
  return JSON.parse(new TextDecoder().decode(plaintext)) as T
}

type AppleQueryClient = Promise<Awaited<ReturnType<typeof getPgClient>>>

export async function appleQuery<T extends Record<string, any>>(c: Context, query: string, params: unknown[]) {
  let pending = c.get('appleQueryClient') as AppleQueryClient | undefined
  if (!pending) {
    pending = getPgClient(c)
    c.set('appleQueryClient', pending)
  }
  const client = await pending
  return (await client.query<T>(query, params)).rows
}

export async function closeAppleQueryClient(c: Context) {
  const pending = c.get('appleQueryClient') as AppleQueryClient | undefined
  c.set('appleQueryClient', undefined)
  // Connection failures already propagate through the request's error handler.
  const client = await pending?.catch(() => null)
  if (client)
    await closeClient(c, client)
}

export function sanitizeAppleName(value: unknown) {
  return typeof value === 'string' && !/[<>]/.test(value)
    ? value.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100)
    : ''
}

export async function rememberAppleName(c: Context, subject: string, first: unknown, last: unknown) {
  const firstName = sanitizeAppleName(first)
  const lastName = sanitizeAppleName(last)
  const rows = await appleQuery<{ first_name: string, last_name: string }>(c, `
    INSERT INTO public.apple_auth_names (subject, first_name, last_name)
    VALUES ($1, $2, $3)
    ON CONFLICT (subject) DO UPDATE SET
      first_name = COALESCE(NULLIF(public.apple_auth_names.first_name, ''), EXCLUDED.first_name),
      last_name = COALESCE(NULLIF(public.apple_auth_names.last_name, ''), EXCLUDED.last_name)
    RETURNING first_name, last_name`, [subject, firstName, lastName])
  return rows[0]
}

export interface AppleAttempt extends Record<string, unknown> {
  state_hash: string
  nonce: string
  redirect_uri: string
  code_challenge: string
  client_state: string
  expected_user_id: string | null
  expected_subject: string | null
  credential: string | null
}
