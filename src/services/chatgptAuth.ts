import type { ChatGptCallback } from '~/utils/chatgptCallback'
import { assistantRequest } from '~/services/assistantHttp'

/**
 * "Continue with ChatGPT" (OpenAI Sign in with ChatGPT, plan usage). Sign-in and token storage stay
 * on this device for this Capgo user; browser model requests relay access tokens through Capgo.
 * The first sign-in registers an agent client (dynamic_agent_client) and OpenAI issues a
 * per-user oaiapp_ client in the callback, which later sign-ins reuse.
 */

export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const CHATGPT_PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct'
export const CHATGPT_AGENT_NAME = 'Capgo'
/** Dynamic registration only accepts an http loopback redirect; the code is read from it. */
export const CHATGPT_REDIRECT_URI = 'http://127.0.0.1:1455/auth/callback'
/** Where users review their ChatGPT plan usage and per-app limits. */
export const CHATGPT_MANAGE_USAGE_URL = 'https://chatgpt.com/#settings'

const PENDING_TTL_MS = 10 * 60_000
const REFRESH_MARGIN_MS = 60_000
const AUTH_TIMEOUT_MS = 15_000
const TERMINAL_REFRESH_ERRORS = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']

export interface ChatGptCredentials {
  clientId: string
  email: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

interface PendingSignIn {
  state: string
  nonce: string
  verifier: string
  clientId: string
  expiresAt: number
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
}

export class ChatGptAuthError extends Error {}

const credentialsKey = (userId: string) => `capgo-assistant-chatgpt:${userId}`
const hostIdKey = (userId: string) => `capgo-assistant-chatgpt-host:${userId}`
const pendingKey = (userId: string) => `capgo-assistant-chatgpt-pending:${userId}`

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  }
  catch {
    return null
  }
}

export function loadChatGptCredentials(userId: string): ChatGptCredentials | null {
  return readJson<ChatGptCredentials>(localStorage, credentialsKey(userId))
}

function saveCredentials(userId: string, credentials: ChatGptCredentials) {
  localStorage.setItem(credentialsKey(userId), JSON.stringify(credentials))
}

/** Sign out: forget the tokens and the issued client so the next sign-in can pick any ChatGPT account. */
export function signOutChatGpt(userId: string) {
  localStorage.removeItem(credentialsKey(userId))
  sessionStorage.removeItem(pendingKey(userId))
}

/** Stable per-host id OpenAI binds the issued client to. */
function hostId(userId: string): string {
  let value = localStorage.getItem(hostIdKey(userId))
  if (!value) {
    value = `urn:uuid:${crypto.randomUUID()}`
    localStorage.setItem(hostIdKey(userId), value)
  }
  return value
}

export function buildAuthorizeUrl(params: { clientId: string, state: string, nonce: string, codeChallenge: string, hostId: string, loginHint?: string }): string {
  const url = new URL(CHATGPT_AUTHORIZE_URL)
  url.searchParams.set('client_id', params.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', CHATGPT_REDIRECT_URI)
  url.searchParams.set('scope', CHATGPT_SCOPES)
  url.searchParams.set('resource', CHATGPT_RESOURCE)
  url.searchParams.set('state', params.state)
  url.searchParams.set('nonce', params.nonce)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('ext_agent_host_id', params.hostId)
  if (params.clientId === CHATGPT_DYNAMIC_CLIENT_ID)
    url.searchParams.set('agent_name_hint', CHATGPT_AGENT_NAME)
  if (params.loginHint)
    url.searchParams.set('login_hint', params.loginHint)
  return url.toString()
}

/**
 * A registration must return a newly issued client; a re-authorization may omit it but must never
 * switch to another client.
 */
export function resolveIssuedClientId(pendingClientId: string, callbackClientId: string | undefined): string | null {
  if (pendingClientId === CHATGPT_DYNAMIC_CLIENT_ID)
    return callbackClientId && callbackClientId !== CHATGPT_DYNAMIC_CLIENT_ID ? callbackClientId : null
  if (callbackClientId && callbackClientId !== pendingClientId)
    return null
  return pendingClientId
}

/** Claims of the ID token received straight from OpenAI's token endpoint over TLS. */
export function decodeIdToken(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1]
  if (!part)
    return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = new TextDecoder().decode(Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), char => char.charCodeAt(0)))
    return JSON.parse(json) as Record<string, unknown>
  }
  catch {
    return null
  }
}

async function tokenRequest(form: Record<string, string>): Promise<{ status: number, data: TokenResponse }> {
  const response = await assistantRequest(CHATGPT_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
    body: new URLSearchParams(form).toString(),
    timeoutMs: AUTH_TIMEOUT_MS,
  })
  let data: TokenResponse = {}
  try {
    data = JSON.parse(response.text) as TokenResponse
  }
  catch {}
  return { status: response.status, data }
}

/** Start a sign-in: keep state, nonce and the PKCE verifier for this tab and return the ChatGPT URL. */
export async function beginChatGptSignIn(userId: string): Promise<string> {
  const previous = loadChatGptCredentials(userId)
  const pending: PendingSignIn = {
    state: randomToken(),
    nonce: randomToken(),
    verifier: randomToken(48),
    clientId: previous?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID,
    expiresAt: Date.now() + PENDING_TTL_MS,
  }
  sessionStorage.setItem(pendingKey(userId), JSON.stringify(pending))
  return buildAuthorizeUrl({
    clientId: pending.clientId,
    state: pending.state,
    nonce: pending.nonce,
    codeChallenge: await pkceChallenge(pending.verifier),
    hostId: hostId(userId),
    loginHint: previous?.email || undefined,
  })
}

/** Finish a sign-in from the loopback callback: exchange the code and keep the tokens on this device. */
export async function completeChatGptSignIn(userId: string, callback: ChatGptCallback): Promise<ChatGptCredentials> {
  const pending = readJson<PendingSignIn>(sessionStorage, pendingKey(userId))
  if (callback.error)
    throw new ChatGptAuthError(callback.error)
  if (!pending || pending.expiresAt < Date.now() || !callback.code || callback.state !== pending.state)
    throw new ChatGptAuthError('chatgpt_sign_in_expired')
  const clientId = resolveIssuedClientId(pending.clientId, callback.clientId)
  if (!clientId)
    throw new ChatGptAuthError('chatgpt_invalid_client')

  const { status, data } = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: clientId,
    code: callback.code,
    code_verifier: pending.verifier,
    redirect_uri: CHATGPT_REDIRECT_URI,
    resource: CHATGPT_RESOURCE,
  })
  sessionStorage.removeItem(pendingKey(userId))
  if (status !== 200 || !data.access_token || !data.id_token)
    throw new ChatGptAuthError('chatgpt_exchange_failed')

  const claims = decodeIdToken(data.id_token)
  const audience = claims?.aud
  const audiences = Array.isArray(audience) ? audience : [audience]
  if (!claims || claims.iss !== CHATGPT_ISSUER || !audiences.includes(clientId) || claims.nonce !== pending.nonce)
    throw new ChatGptAuthError('chatgpt_invalid_id_token')

  const scopes = (data.scope ?? '').split(/\s+/).filter(Boolean)
  if (!scopes.includes(CHATGPT_PLAN_USAGE_SCOPE))
    throw new ChatGptAuthError('chatgpt_plan_usage_not_granted')

  const credentials: ChatGptCredentials = {
    clientId,
    email: typeof claims.email === 'string' ? claims.email : '',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? '',
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scopes,
  }
  saveCredentials(userId, credentials)
  return credentials
}

/** Access token for the user's ChatGPT plan, refreshed close to expiry. Null when not signed in. */
export async function getChatGptAccessToken(userId: string, forceRefresh = false): Promise<string | null> {
  const credentials = loadChatGptCredentials(userId)
  if (!credentials)
    return null
  if (!forceRefresh && credentials.expiresAt - REFRESH_MARGIN_MS > Date.now())
    return credentials.accessToken
  if (!credentials.refreshToken) {
    signOutChatGpt(userId)
    throw new ChatGptAuthError('chatgpt_reconnect_required')
  }
  const { status, data } = await tokenRequest({
    grant_type: 'refresh_token',
    client_id: credentials.clientId,
    refresh_token: credentials.refreshToken,
    resource: CHATGPT_RESOURCE,
  })
  if (status !== 200 || !data.access_token) {
    if (TERMINAL_REFRESH_ERRORS.includes(data.error ?? '')) {
      signOutChatGpt(userId)
      throw new ChatGptAuthError('chatgpt_reconnect_required')
    }
    throw new ChatGptAuthError('chatgpt_unavailable')
  }
  // Refresh tokens rotate: replace access token, refresh token, expiry and scopes together.
  const refreshed: ChatGptCredentials = {
    ...credentials,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? credentials.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scopes: data.scope ? data.scope.split(/\s+/).filter(Boolean) : credentials.scopes,
  }
  saveCredentials(userId, refreshed)
  return refreshed.accessToken
}
