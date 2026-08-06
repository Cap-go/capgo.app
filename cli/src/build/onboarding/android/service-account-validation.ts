// src/build/onboarding/android/service-account-validation.ts
//
// Validates a user-supplied Google Play service account JSON before we save it
// as PLAY_CONFIG_JSON. Three layers:
//
//   1. Shape check — JSON.parse and confirm the file looks like a service
//      account key (type, private_key, client_email, project_id, token_uri).
//   2. Token exchange — sign a JWT with the SA private key and POST it to the
//      SA's token endpoint. Proves the key is cryptographically valid and the
//      account isn't revoked.
//   3. App-access check — open and immediately close a draft edit on the user's
//      Play Console app (`applications/{packageName}/edits`). This is exactly
//      what fastlane's `supply` will do at build time — if this passes the
//      build will pass.
//
// All network calls forward an AbortSignal so the React UI can cancel mid-flight.

import type { Buffer } from 'node:buffer'
import jwt from 'jsonwebtoken'
import { appendInternalLog } from '../../../support/internal-log.js'

const ANDROIDPUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'
const ANDROIDPUBLISHER_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3'
const JWT_LIFETIME_SECONDS = 3600
const DEFAULT_FETCH_TIMEOUT_MS = 30_000
const ALLOWED_GOOGLE_TOKEN_URIS = new Set([
  'https://oauth2.googleapis.com/token',
  'https://accounts.google.com/o/oauth2/token',
  'https://www.googleapis.com/oauth2/v4/token',
])

export interface ServiceAccountKey {
  type: 'service_account'
  client_email: string
  private_key: string
  project_id: string
  token_uri: string
  private_key_id?: string
  client_id?: string
}

export type ValidationResult
  = | { ok: true, serviceAccountEmail: string, projectId: string }
    | { ok: false, kind: 'shape-error', message: string }
    | { ok: false, kind: 'token-error', message: string }
    | { ok: false, kind: 'no-app-access', message: string, serviceAccountEmail: string }
    | { ok: false, kind: 'network-error', message: string }

export interface ValidateOptions {
  jsonBytes: Buffer
  packageName: string
  signal?: AbortSignal
  /** Override per-request timeout. Defaults to 30s. */
  timeoutMs?: number
  /** Test-only injection point. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

/**
 * Parse + minimally validate the service account JSON structure.
 *
 * Google's SA JSON for `service_account` type has more optional fields, but
 * these five are the ones we actually need to authenticate. Missing any of
 * them means we can't proceed — surface a precise error so the user knows
 * what's wrong rather than discovering it at token-exchange time with an
 * opaque crypto error.
 */
export function parseServiceAccountKey(jsonBytes: Buffer): ServiceAccountKey {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBytes.toString('utf-8'))
  }
  catch (err) {
    throw new Error(`Service account file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Service account file is not a JSON object.')

  const obj = parsed as Record<string, unknown>
  if (obj.type !== 'service_account')
    throw new Error(`Expected "type": "service_account" — found ${JSON.stringify(obj.type)}. This file is not a service account key.`)

  const required = ['client_email', 'private_key', 'project_id', 'token_uri'] as const
  for (const field of required) {
    const value = obj[field]
    if (typeof value !== 'string' || value.length === 0)
      throw new Error(`Service account JSON is missing required field "${field}".`)
  }
  if (!ALLOWED_GOOGLE_TOKEN_URIS.has(obj.token_uri as string))
    throw new Error('Service account JSON has an unsupported token_uri. Expected a Google OAuth token endpoint.')

  return {
    type: 'service_account',
    client_email: obj.client_email as string,
    private_key: obj.private_key as string,
    project_id: obj.project_id as string,
    token_uri: obj.token_uri as string,
    private_key_id: typeof obj.private_key_id === 'string' ? obj.private_key_id : undefined,
    client_id: typeof obj.client_id === 'string' ? obj.client_id : undefined,
  }
}

/**
 * Sign a JWT bearer assertion suitable for Google's OAuth2 token endpoint.
 *
 * Google requires:
 *   - alg: RS256
 *   - iss: service account email
 *   - scope: space-separated OAuth scopes
 *   - aud: the token endpoint URL
 *   - exp: now + 3600 (max accepted by Google)
 *   - iat: now
 *
 * Ref: https://developers.google.com/identity/protocols/oauth2/service-account#authorizingrequests
 */
function signSaAssertion(key: ServiceAccountKey): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      iss: key.client_email,
      scope: ANDROIDPUBLISHER_SCOPE,
      aud: key.token_uri,
      exp: now + JWT_LIFETIME_SECONDS,
      iat: now,
    },
    key.private_key,
    {
      algorithm: 'RS256',
      header: { alg: 'RS256', typ: 'JWT', kid: key.private_key_id ?? '' },
    },
  )
}

interface GoogleTokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

interface GoogleTokenErrorResponse {
  error?: string
  error_description?: string
}

/**
 * Marker thrown by `exchangeJwtForAccessToken` for transient/transport-class
 * failures (5xx from Google, non-JSON, etc.) so the outer `validate*` catch
 * can route them to `network-error` instead of `token-error`. 4xx responses
 * still throw a plain Error and map to `token-error` (credentials genuinely
 * rejected).
 */
class TokenExchangeTransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenExchangeTransientError'
  }
}

/**
 * Exchange a signed JWT bearer assertion for an OAuth access token at Google's
 * token endpoint. The token is short-lived (1h) and is used only for the
 * downstream `edits.insert` / `edits.delete` round trip.
 */
async function exchangeJwtForAccessToken(args: {
  key: ServiceAccountKey
  assertion: string
  signal?: AbortSignal
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: args.assertion,
  })

  const res = await fetchWithTimeout({
    url: args.key.token_uri,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    },
    signal: args.signal,
    timeoutMs: args.timeoutMs,
    fetchImpl: args.fetchImpl,
  })

  const text = await res.text()
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`
    try {
      const errBody = JSON.parse(text) as GoogleTokenErrorResponse
      if (errBody.error) {
        detail = errBody.error_description
          ? `${errBody.error}: ${errBody.error_description}`
          : errBody.error
      }
    }
    catch {}
    // 5xx (and unexpected 1xx/3xx) are server-side or transport problems, not
    // credential rejections — flag them as transient so the outer validator
    // surfaces a network-error and the UI offers retry rather than telling
    // the user their key is bad.
    if (res.status >= 500 || res.status < 400)
      throw new TokenExchangeTransientError(`Google's token endpoint returned ${detail}. Try again in a moment.`)
    throw new Error(`Google rejected the service account credentials (${detail}). The private key may be revoked or invalid.`)
  }

  let parsed: GoogleTokenResponse
  try {
    parsed = JSON.parse(text) as GoogleTokenResponse
  }
  catch {
    throw new TokenExchangeTransientError(`Google's token endpoint returned a non-JSON response (${res.status}).`)
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0)
    throw new TokenExchangeTransientError('Google\'s token response was missing an access_token field.')
  return parsed.access_token
}

interface EditResponse {
  id: string
  expiryTimeSeconds?: string
}

async function fetchWithTimeout(args: {
  url: string
  init: RequestInit
  signal?: AbortSignal
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<Response> {
  // Compose the caller's AbortSignal with a per-request timeout signal so
  // either source can cancel the request.
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), args.timeoutMs)

  let combinedSignal: AbortSignal
  // Captured so the `finally` block can detach them on success. Without this,
  // a long-lived caller `signal` would accumulate one listener per request
  // (each `{ once: true }` listener auto-detaches on fire, but never on
  // successful completion).
  let abortComposite: (() => void) | null = null
  if (args.signal) {
    const composite = new AbortController()
    abortComposite = () => composite.abort()
    args.signal.addEventListener('abort', abortComposite, { once: true })
    timeoutController.signal.addEventListener('abort', abortComposite, { once: true })
    if (args.signal.aborted || timeoutController.signal.aborted)
      composite.abort()
    combinedSignal = composite.signal
  }
  else {
    combinedSignal = timeoutController.signal
  }

  try {
    return await args.fetchImpl(args.url, { ...args.init, signal: combinedSignal })
  }
  finally {
    clearTimeout(timer)
    if (abortComposite) {
      args.signal?.removeEventListener('abort', abortComposite)
      timeoutController.signal.removeEventListener('abort', abortComposite)
    }
  }
}

/**
 * Open a draft edit on the Play Console app, then immediately delete it.
 *
 * Mirrors fastlane's auth code path — if this round trip succeeds, every
 * subsequent supply call will succeed too. The draft itself is invisible in
 * Play Console for most views and auto-expires after 7 days even if our
 * cleanup DELETE fails.
 */
async function probeAppAccess(args: {
  accessToken: string
  packageName: string
  signal?: AbortSignal
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<{ kind: 'ok' } | { kind: 'no-access', detail: string } | { kind: 'network', detail: string }> {
  const insertUrl = `${ANDROIDPUBLISHER_BASE}/applications/${encodeURIComponent(args.packageName)}/edits`

  let insertRes: Response
  try {
    insertRes = await fetchWithTimeout({
      url: insertUrl,
      init: {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${args.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: '{}',
      },
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      fetchImpl: args.fetchImpl,
    })
  }
  catch (err) {
    return {
      kind: 'network',
      detail: err instanceof Error ? err.message : String(err),
    }
  }

  const insertText = await insertRes.text()

  // Record exactly what Play returned for this package so the support bundle can
  // show whether "verified" came from the RIGHT package and what HTTP status the
  // androidpublisher edits.insert probe actually got (2xx = SA can edit this app).
  appendInternalLog(`probeAppAccess: POST ${insertUrl} → HTTP ${insertRes.status} ${insertRes.statusText}${insertRes.ok ? '' : ` :: ${insertText.slice(0, 300)}`}`)

  // 401 / 403 / 404 = SA exists and auth worked at the token-exchange level,
  // but this SA can't see this package. Anything in the 5xx range or other
  // unexpected codes is a network/server failure, not an access failure —
  // surface that distinction so the user gets the right recovery options.
  if (insertRes.status === 401 || insertRes.status === 403 || insertRes.status === 404) {
    return {
      kind: 'no-access',
      detail: parseGoogleErrorMessage(insertText) ?? `${insertRes.status} ${insertRes.statusText}`,
    }
  }
  if (!insertRes.ok) {
    return {
      kind: 'network',
      detail: `${insertRes.status} ${insertRes.statusText}: ${insertText.slice(0, 200)}`,
    }
  }

  let edit: EditResponse
  try {
    edit = JSON.parse(insertText) as EditResponse
  }
  catch {
    return { kind: 'network', detail: 'Play API returned non-JSON on edits.insert' }
  }
  if (typeof edit.id !== 'string' || edit.id.length === 0)
    return { kind: 'network', detail: 'Play API returned no edit id' }

  // Best-effort cleanup — the draft auto-expires regardless. Don't surface
  // failures here, just log internally via the caller.
  const deleteUrl = `${ANDROIDPUBLISHER_BASE}/applications/${encodeURIComponent(args.packageName)}/edits/${encodeURIComponent(edit.id)}`
  try {
    await fetchWithTimeout({
      url: deleteUrl,
      init: {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${args.accessToken}` },
      },
      signal: args.signal,
      timeoutMs: args.timeoutMs,
      fetchImpl: args.fetchImpl,
    })
  }
  catch {
    // swallowed by contract — auto-expiry covers us
  }

  return { kind: 'ok' }
}

function parseGoogleErrorMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string, status?: string } }
    if (parsed.error?.message) {
      return parsed.error.status
        ? `${parsed.error.status}: ${parsed.error.message}`
        : parsed.error.message
    }
  }
  catch {}
  return null
}

/**
 * Run the full validation chain. The function never throws — all failure
 * shapes are returned as `{ ok: false, kind: … }` so the UI can react to each
 * case independently (e.g. "no-app-access" routes to a recovery screen with
 * actionable Play Console invite instructions).
 */
export async function validateServiceAccountJson(opts: ValidateOptions): Promise<ValidationResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)

  // 1. Shape
  let key: ServiceAccountKey
  try {
    key = parseServiceAccountKey(opts.jsonBytes)
  }
  catch (err) {
    return {
      ok: false,
      kind: 'shape-error',
      message: err instanceof Error ? err.message : String(err),
    }
  }

  if (opts.signal?.aborted)
    return { ok: false, kind: 'network-error', message: 'Validation cancelled.' }

  // 2. Token exchange. Distinguishes between "Google rejected the key" (real
  // token-error) and transport/transient failures (network-error). Aborts and
  // fetch-level rejections always go to network-error so the recovery UI can
  // offer retry rather than a misleading "your credentials are bad" message.
  let accessToken: string
  try {
    const assertion = signSaAssertion(key)
    accessToken = await exchangeJwtForAccessToken({
      key,
      assertion,
      signal: opts.signal,
      timeoutMs,
      fetchImpl,
    })
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isAbort = (err as { name?: string } | null)?.name === 'AbortError'
    const isTransient = err instanceof TokenExchangeTransientError
    const looksNetworky = /timeout|timed out|network|fetch failed|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i.test(message)
    if (isAbort || isTransient || looksNetworky) {
      return {
        ok: false,
        kind: 'network-error',
        message,
      }
    }
    return {
      ok: false,
      kind: 'token-error',
      message,
    }
  }

  if (opts.signal?.aborted)
    return { ok: false, kind: 'network-error', message: 'Validation cancelled.' }

  // 3. App-access check
  const probe = await probeAppAccess({
    accessToken,
    packageName: opts.packageName,
    signal: opts.signal,
    timeoutMs,
    fetchImpl,
  })

  if (probe.kind === 'ok') {
    return {
      ok: true,
      serviceAccountEmail: key.client_email,
      projectId: key.project_id,
    }
  }
  if (probe.kind === 'no-access') {
    return {
      ok: false,
      kind: 'no-app-access',
      serviceAccountEmail: key.client_email,
      message: `Service account "${key.client_email}" cannot access package "${opts.packageName}" on Google Play (${probe.detail}). Create the app in Play Console (if it does not exist yet), invite this service account under Users and permissions, and grant release access for this app — or skip Play upload and get the AAB via Capgo with --no-playstore-upload --output-upload.`,
    }
  }
  return {
    ok: false,
    kind: 'network-error',
    message: probe.detail,
  }
}
