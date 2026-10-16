import type { Context } from 'hono'
import { base64url, createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT } from 'jose'
import { getEnv } from './utils.ts'

const appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'))
const requiredSettings = ['APPLE_SIGN_IN_CLIENT_ID', 'APPLE_SIGN_IN_TEAM_ID', 'APPLE_SIGN_IN_KEY_ID', 'APPLE_SIGN_IN_PRIVATE_KEY'] as const

export async function verifyAppleIdentity(c: Context, token: string, nonce: string, web = false, code?: string) {
  const audience = getEnv(c, web ? 'APPLE_SIGN_IN_WEB_CLIENT_ID' : 'APPLE_SIGN_IN_CLIENT_ID').trim()
  if (!audience)
    throw new Error('Apple audience unavailable')
  const { payload } = await jwtVerify(token, appleKeys, {
    issuer: 'https://appleid.apple.com',
    audience,
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat', 'nonce', 'email'],
    maxTokenAge: '10m',
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nonce))
  const hashedNonce = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  if (payload.nonce !== hashedNonce || !payload.sub || typeof payload.email !== 'string'
    || (payload.email_verified !== true && payload.email_verified !== 'true')) {
    throw new Error('Invalid Apple identity')
  }
  if (code) {
    const codeHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)))
    if (payload.c_hash !== base64url.encode(codeHash.slice(0, 16)))
      throw new Error('Invalid Apple code binding')
  }
  return { subject: payload.sub, email: payload.email.trim().toLowerCase() }
}

export function isAppleSignInConfigured(c: Context) {
  return requiredSettings.every(key => getEnv(c, key).trim().length > 0)
}

export async function revokeAppleAuthorization(c: Context, code: string, expectedSubject: string, web = false) {
  const clientId = getEnv(c, web ? 'APPLE_SIGN_IN_WEB_CLIENT_ID' : 'APPLE_SIGN_IN_CLIENT_ID')
  if (!clientId)
    throw new Error('Apple audience unavailable')
  const redirectUri = web ? getEnv(c, 'APPLE_SIGN_IN_OAUTH_CALLBACK_URL').trim() : ''
  if (web && !redirectUri.startsWith('https://'))
    throw new Error('Apple callback unavailable')
  const key = await importPKCS8(getEnv(c, 'APPLE_SIGN_IN_PRIVATE_KEY').replace(/\\n/g, '\n'), 'ES256')
  const secret = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: getEnv(c, 'APPLE_SIGN_IN_KEY_ID') })
    .setIssuer(getEnv(c, 'APPLE_SIGN_IN_TEAM_ID'))
    .setSubject(clientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key)

  const exchanged = await fetch('https://appleid.apple.com/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: secret,
      code,
      grant_type: 'authorization_code',
      ...(web ? { redirect_uri: redirectUri } : {}),
    }),
    signal: AbortSignal.timeout(5000),
  })
  if (!exchanged.ok)
    throw new Error('Apple code exchange failed')
  const tokens = await exchanged.json() as { id_token?: string, access_token?: string }
  if (!tokens.id_token || !tokens.access_token)
    throw new Error('Apple code exchange did not return credentials')

  const { payload } = await jwtVerify(tokens.id_token, appleKeys, { issuer: 'https://appleid.apple.com', audience: clientId, algorithms: ['RS256'] })
  if (payload.sub !== expectedSubject)
    throw new Error('Apple authorization does not belong to the authenticated user')

  const revoked = await fetch('https://appleid.apple.com/auth/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: secret, token: tokens.access_token, token_type_hint: 'access_token' }),
    signal: AbortSignal.timeout(5000),
  })
  if (!revoked.ok)
    throw new Error('Apple authorization revocation failed')
}
