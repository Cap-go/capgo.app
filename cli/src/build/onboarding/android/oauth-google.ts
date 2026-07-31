// src/build/onboarding/android/oauth-google.ts
//
// Google OAuth 2.0 authorization-code flow with PKCE for a desktop/CLI app.
//
// Flow:
//   1. Generate PKCE code_verifier + code_challenge (SHA-256).
//   2. Start a tiny HTTP server bound to 127.0.0.1 on a random port.
//   3. Build the authorization URL with redirect_uri=http://127.0.0.1:PORT/callback
//      and open it in the user's browser.
//   4. Google redirects back with an auth code; our loopback server catches it.
//   5. Exchange the code + verifier at the token endpoint for access + refresh
//      tokens.
//
// Desktop clients are public — Google's "client secret" isn't truly secret,
// but the token endpoint accepts requests without one if PKCE is used. We pass
// it when present because Google's Console still hands one out and the API
// accepts either shape.

import type { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import open from 'open'
import { appendInternalLog } from '../../../support/internal-log.js'

export const GOOGLE_OAUTH_SCOPES_ANDROIDPUBLISHER = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/androidpublisher',
] as const

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

const DEFAULT_FLOW_TIMEOUT_MS = 5 * 60 * 1000
const LOOPBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'

export interface GoogleOAuthConfig {
  clientId: string
  /**
   * Desktop clients receive a "secret" from the Console that isn't truly
   * confidential; pass it when available — Google accepts the token exchange
   * with or without it as long as PKCE is used.
   */
  clientSecret?: string
  scopes: readonly string[]
  /**
   * Subset of `scopes` whose absence must FAIL sign-in (throw
   * MissingScopesError). Scopes in `scopes` but NOT here are OPTIONAL — the user
   * may decline them on the consent screen and sign-in still succeeds; the
   * caller is responsible for degrading gracefully. Defaults to all `scopes`.
   */
  requiredScopes?: readonly string[]
  /** Extra params to include on the auth URL (e.g. `login_hint`, `prompt`). */
  extraAuthParams?: Record<string, string>
}

export interface GoogleOAuthTokens {
  accessToken: string
  refreshToken?: string
  /**
   * Unix epoch in milliseconds — the wall-clock time the access token stops
   * being accepted. Callers should refresh before this.
   */
  expiresAt: number
  idToken?: string
  scope: string
  tokenType: string
}

export interface GoogleUserInfo {
  sub: string
  email: string
  emailVerified: boolean
  name?: string
  picture?: string
}

export interface RunOAuthFlowOptions {
  /**
   * Called once with the authorization URL right before we open it. Useful
   * for logging the URL in case `open()` fails.
   */
  onAuthUrl?: (url: string) => void
  /** Called with user-visible status updates while we wait for the redirect. */
  onStatus?: (message: string) => void
  /** Overall deadline for the whole flow. Defaults to 5 minutes. */
  timeoutMs?: number
  /** Abort the flow early — useful for React cleanup. */
  signal?: AbortSignal
}

export interface PkcePair {
  verifier: string
  challenge: string
  method: 'S256'
}

/** Base64url-encode a buffer (URL-safe, no padding). */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Generate a PKCE verifier (43–128 chars of unreserved URL chars) and its
 * SHA-256 challenge. The verifier must be held until the token exchange.
 */
export function generatePkcePair(): PkcePair {
  // 32 bytes → 43 char base64url — Google recommends ≥43 chars.
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge, method: 'S256' }
}

export function generateState(): string {
  return base64url(crypto.randomBytes(16))
}

export function buildAuthUrl(args: {
  clientId: string
  redirectUri: string
  scopes: readonly string[]
  state: string
  codeChallenge: string
  extra?: Record<string, string>
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: args.scopes.join(' '),
    access_type: 'offline',
    // Force the consent screen so we always get a refresh_token back. Google
    // only issues a refresh_token on the first consent unless prompt=consent.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  })
  if (args.extra) {
    for (const [k, v] of Object.entries(args.extra))
      params.set(k, v)
  }
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

interface RawTokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope: string
  token_type: string
  id_token?: string
}

export function parseTokenResponse(raw: RawTokenResponse, now: number = Date.now()): GoogleOAuthTokens {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    expiresAt: now + raw.expires_in * 1000,
    idToken: raw.id_token,
    scope: raw.scope,
    tokenType: raw.token_type,
  }
}

async function postTokenEndpoint(body: URLSearchParams): Promise<GoogleOAuthTokens> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) {
    let detail: string = text
    try {
      const parsed = JSON.parse(text) as { error?: string, error_description?: string }
      if (parsed.error_description || parsed.error)
        detail = `${parsed.error ?? ''}${parsed.error && parsed.error_description ? ': ' : ''}${parsed.error_description ?? ''}`
    }
    catch {}
    throw new Error(`Google token exchange failed (${res.status}): ${detail}`)
  }
  let parsed: RawTokenResponse
  try {
    parsed = JSON.parse(text) as RawTokenResponse
  }
  catch {
    throw new Error(`Google token endpoint returned non-JSON response: ${text.slice(0, 200)}`)
  }
  return parseTokenResponse(parsed)
}

/** Exchange an authorization code + PKCE verifier for tokens. */
export async function exchangeAuthCode(args: {
  config: GoogleOAuthConfig
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: args.config.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  })
  if (args.config.clientSecret)
    body.set('client_secret', args.config.clientSecret)
  return postTokenEndpoint(body)
}

/**
 * Use a stored refresh token to mint a new access token. Refresh tokens may be
 * revoked by the user at any time; callers should surface a clean re-auth
 * prompt if this throws.
 */
export async function refreshAccessToken(
  config: GoogleOAuthConfig,
  refreshToken: string,
): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  })
  if (config.clientSecret)
    body.set('client_secret', config.clientSecret)
  const tokens = await postTokenEndpoint(body)
  // Refresh grants don't return a new refresh_token; carry the old one forward.
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

/** Fetch the signed-in user's email and subject (stable Google ID). */
export async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`userinfo failed (${res.status}): ${text.slice(0, 200)}`)
  }
  const data = await res.json() as {
    sub: string
    email: string
    email_verified?: boolean
    name?: string
    picture?: string
  }
  return {
    sub: data.sub,
    email: data.email,
    emailVerified: !!data.email_verified,
    name: data.name,
    picture: data.picture,
  }
}

/**
 * Revoke a Google OAuth token. Accepts either an access or refresh token —
 * revoking a refresh token also invalidates any access tokens minted from it.
 */
export async function revokeToken(token: string): Promise<void> {
  const res = await fetch(GOOGLE_REVOKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  })
  // Google returns 400 when the token is already invalid/revoked — treat as success.
  if (!res.ok && res.status !== 400) {
    const text = await res.text().catch(() => '')
    throw new Error(`revoke failed (${res.status}): ${text.slice(0, 200)}`)
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c] as string))
}

/**
 * Human blurbs for OPTIONAL scopes a user may decline on the consent screen —
 * shown on the success page so they understand the implication right where the
 * decision happened (Google's consent wording, e.g. "see metrics and data", is
 * vaguer/scarier than what the CLI actually does).
 */
const OPTIONAL_SCOPE_BLURBS: Record<string, string> = {
  'https://www.googleapis.com/auth/playdeveloperreporting':
    'Play app list (Google words it "see metrics and data"): without it the CLI can\'t check that the app you\'re building exists in your Play Console, so it will trust the package from your Gradle config as-is.',
}

function successHtml(skippedOptionalScopes: readonly string[] = []): string {
  const warning = skippedOptionalScopes.length > 0
    ? `<div class="warn"><strong>Heads-up:</strong> you skipped ${skippedOptionalScopes.length === 1 ? 'an optional permission' : 'some optional permissions'} — that's fine, onboarding continues without it.<ul>${skippedOptionalScopes.map(s => `<li>${escapeHtml(OPTIONAL_SCOPE_BLURBS[s] ?? s)}</li>`).join('')}</ul>Want it after all? Re-run onboarding and leave it checked on the consent screen.</div>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capgo — signed in</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#222}h1{font-size:22px}p{color:#555;line-height:1.5}.warn{background:#fff7e6;border:1px solid #f0d59c;border-radius:6px;padding:12px 16px;color:#5c4a1a;font-size:14px;line-height:1.5}.warn ul{margin:8px 0;padding-left:20px}</style>
</head><body><h1>✅ You can close this tab</h1>
<p>Capgo CLI received your Google sign-in. Head back to your terminal to continue.</p>
${warning}
</body></html>`
}

function errorHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capgo — sign-in failed</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#222}h1{font-size:22px;color:#b00020}pre{background:#f6f6f6;padding:12px;border-radius:6px;font-size:13px;overflow-x:auto}</style>
</head><body><h1>Sign-in failed</h1>
<p>You can close this tab and try again in the terminal.</p>
<pre>${escapeHtml(message)}</pre></body></html>`
}

function scopeMissingHtml(missing: readonly string[]): string {
  const items = missing.map(s => `<li><code>${escapeHtml(s)}</code></li>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>Capgo — missing permissions</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:80px auto;padding:0 20px;color:#222;line-height:1.55}h1{font-size:22px;color:#b85c00}p{color:#444}ul{background:#fff7e6;padding:14px 18px 14px 36px;border-radius:6px;border:1px solid #f0d59c}code{font-family:ui-monospace,Menlo,monospace;font-size:13px}</style>
</head><body>
<h1>⚠️ Some required permissions weren't granted</h1>
<p>Capgo needs every permission it asks for in order to set up Play Store publishing. The following requested permissions were not approved on the consent screen:</p>
<ul>${items}</ul>
<p>Head back to your terminal — the CLI will offer to retry sign-in. When the consent screen appears again, please make sure every requested permission is checked before approving.</p>
</body></html>`
}

/**
 * Error thrown by runOAuthFlow when the user approves the consent screen but
 * deselects one or more requested scopes. The CLI catches this specifically
 * to route the user back to a "please grant all permissions" re-sign-in step
 * instead of failing several phases later with confusing API errors.
 */
export class MissingScopesError extends Error {
  readonly missing: readonly string[]
  readonly granted: string

  constructor(missing: readonly string[], granted: string) {
    super(`User did not grant all required OAuth scopes. Missing: ${missing.join(', ')}`)
    this.name = 'MissingScopesError'
    this.missing = missing
    this.granted = granted
  }
}

/**
 * Compare a space-separated `scope` string from a token response against the
 * scopes the CLI requested. Returns the subset of requested scopes that the
 * user did not grant.
 *
 * Google's tokeninfo response uses a space-separated, unordered list — the
 * order in `requestedScopes` is not preserved. Empty strings are filtered out.
 */
export function findMissingScopes(grantedScope: string, requestedScopes: readonly string[]): string[] {
  const granted = new Set(grantedScope.split(/\s+/).filter(s => s.length > 0))
  return requestedScopes.filter(s => !granted.has(s))
}

export interface MissingScopeSplit {
  /** Required scopes the user didn't grant — sign-in must fail with a retry. */
  missingRequired: string[]
  /** Optional scopes the user declined — proceed, but tell them what they lose. */
  skippedOptional: string[]
}

/**
 * Split the requested-but-not-granted scopes into the required ones (block
 * sign-in → MissingScopesError) and the optional ones (sign-in proceeds; the
 * success page + caller warn about the degraded behavior).
 */
export function splitMissingScopes(
  grantedScope: string,
  scopes: readonly string[],
  requiredScopes: readonly string[],
): MissingScopeSplit {
  const missingAll = findMissingScopes(grantedScope, scopes)
  return {
    missingRequired: missingAll.filter(s => requiredScopes.includes(s)),
    skippedOptional: missingAll.filter(s => !requiredScopes.includes(s)),
  }
}

export interface LoopbackCallbackResult {
  /** Authorization code Google returned in the query string. */
  code: string
  /**
   * Finishes the browser response with the given HTML. Call this AFTER doing
   * the token exchange and scope validation so the user sees a result that
   * reflects the post-exchange state (e.g. "missing permissions") rather than
   * a generic "you can close this tab" page that's stale by the time it
   * matters. Idempotent — second call is a no-op.
   */
  finishResponse: (html: string, statusCode?: number) => void
}

interface LoopbackServerHandle {
  /** Chosen ephemeral port. */
  port: number
  /** Full redirect URI the caller should use when building the auth URL. */
  redirectUri: string
  /** Resolves with the code + a finishResponse callback. */
  code: Promise<LoopbackCallbackResult>
  /** Force-close the server (safe to call after `code` settles). */
  close: () => void
}

/**
 * Start an HTTP server bound to 127.0.0.1 on an OS-chosen port and wait for
 * exactly one successful callback request. The returned promise resolves only
 * if the callback has the expected `state` and a `code` param.
 *
 * Bound to 127.0.0.1 so no external network interface sees the server at any
 * point; Google accepts any `http://127.0.0.1:PORT` redirect URI for
 * desktop-type clients.
 */
function startLoopbackServer(args: {
  expectedState: string
  timeoutMs: number
  signal?: AbortSignal
}): Promise<LoopbackServerHandle> {
  return new Promise<LoopbackServerHandle>((resolveHandle, rejectHandle) => {
    let codeResolve: (result: LoopbackCallbackResult) => void
    let codeReject: (err: Error) => void
    const codePromise = new Promise<LoopbackCallbackResult>((resolve, reject) => {
      codeResolve = resolve
      codeReject = reject
    })

    const server = createServer((req, res) => {
      try {
        if (!req.url || !req.url.startsWith(CALLBACK_PATH)) {
          res.statusCode = 404
          res.end('not found')
          return
        }
        const url = new URL(req.url, `http://${LOOPBACK_HOST}`)
        const error = url.searchParams.get('error')
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')

        if (error) {
          const detail = url.searchParams.get('error_description') || error
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.statusCode = 400
          res.end(errorHtml(detail))
          codeReject(new Error(`Google returned an auth error: ${detail}`))
          return
        }
        if (!code || !state) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.statusCode = 400
          res.end(errorHtml('Missing code or state in redirect'))
          codeReject(new Error('Google redirect was missing the authorization code or state parameter'))
          return
        }
        if (state !== args.expectedState) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.statusCode = 400
          res.end(errorHtml('State mismatch — possible CSRF attempt'))
          codeReject(new Error('OAuth state parameter did not match — aborting'))
          return
        }

        // Hold the response open until the CLI calls finishResponse() after
        // token exchange + scope validation. This lets the browser show a
        // result that reflects the post-exchange state ("missing permissions"
        // vs "you're done") instead of a stale generic success page.
        let finished = false
        const finishResponse = (html: string, statusCode = 200) => {
          if (finished)
            return
          finished = true
          try {
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.statusCode = statusCode
            res.end(html)
          }
          catch {
            // Response already closed by the client — ignore.
          }
        }
        codeResolve({ code, finishResponse })
      }
      catch (err) {
        res.statusCode = 500
        res.end('internal error')
        codeReject(err instanceof Error ? err : new Error(String(err)))
      }
    })

    const timer = setTimeout(() => {
      codeReject(new Error(`Timed out after ${Math.round(args.timeoutMs / 1000)}s waiting for browser sign-in`))
    }, args.timeoutMs)

    function onAbort() {
      const err = new Error('OAuth flow aborted')
      codeReject(err)
      // Also reject the outer Promise. Before `server.listen` resolves this is
      // the only path to surface the abort to the caller; afterwards
      // `rejectHandle` is a no-op on an already-resolved promise.
      rejectHandle(err)
    }
    if (args.signal) {
      if (args.signal.aborted) {
        onAbort()
        return
      }
      args.signal.addEventListener('abort', onAbort, { once: true })
    }

    function close() {
      clearTimeout(timer)
      if (args.signal)
        args.signal.removeEventListener('abort', onAbort)
      server.close()
    }

    // Always clean up on either outcome.
    codePromise.then(close, close)

    server.on('error', (err) => {
      close()
      rejectHandle(err)
      codeReject(err)
    })

    server.listen(0, LOOPBACK_HOST, () => {
      const addr = server.address() as AddressInfo | null
      if (!addr) {
        close()
        rejectHandle(new Error('Failed to read loopback server port after bind'))
        return
      }
      const redirectUri = `http://${LOOPBACK_HOST}:${addr.port}${CALLBACK_PATH}`
      resolveHandle({
        port: addr.port,
        redirectUri,
        code: codePromise,
        close,
      })
    })
  })
}

/**
 * The shape returned by `startOAuthFlow`. The loopback server is already
 * running and the browser has been opened; the caller awaits `result` at a
 * later point (fire-and-poll pattern for MCP).
 */
export interface PendingOAuthSession {
  /** Full Google authorization URL that was opened in the browser. */
  authUrl: string
  /** The loopback redirect URI embedded in the authUrl. */
  redirectUri: string
  /**
   * Resolves with validated tokens once the browser callback lands,
   * code is exchanged and scopes pass. Rejects on error/timeout/missing-scopes.
   */
  result: Promise<GoogleOAuthTokens>
  /** Force-close the loopback server (safe after result settles). */
  close: () => void
}

/**
 * Non-blocking OAuth starter: opens the browser and starts the loopback
 * listener, then returns IMMEDIATELY without waiting for the sign-in to
 * complete. The caller can `await session.result` later to collect tokens.
 *
 * This is the foundation for the MCP fire-and-poll sign-in model. The Ink
 * wizard uses `runOAuthFlow` (which internally calls this and then awaits
 * `result`) to preserve its blocking behavior.
 */
export async function startOAuthFlow(
  config: GoogleOAuthConfig,
  options: RunOAuthFlowOptions = {},
): Promise<PendingOAuthSession> {
  if (!config.clientId)
    throw new Error('Google OAuth clientId is required')
  if (!config.scopes.length)
    throw new Error('At least one OAuth scope is required')

  const pkce = generatePkcePair()
  const state = generateState()
  const timeoutMs = options.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS

  const server = await startLoopbackServer({
    expectedState: state,
    timeoutMs,
    signal: options.signal,
  })

  const authUrl = buildAuthUrl({
    clientId: config.clientId,
    redirectUri: server.redirectUri,
    scopes: config.scopes,
    state,
    codeChallenge: pkce.challenge,
    extra: config.extraAuthParams,
  })

  options.onAuthUrl?.(authUrl)
  options.onStatus?.('Opening browser for Google sign-in...')
  try {
    await open(authUrl)
  }
  catch (err) {
    appendInternalLog(`google sign-in: could not auto-open browser: ${err instanceof Error ? err.message : String(err)}`)
    options.onStatus?.('Could not open browser automatically — open the URL above manually.')
  }

  // Build `result` as an async IIFE that awaits the callback, exchanges the
  // code, validates scopes and delivers tokens. The server is closed in finally
  // regardless of outcome.
  const result: Promise<GoogleOAuthTokens> = (async () => {
    try {
      const { code, finishResponse } = await server.code
      options.onStatus?.('Exchanging code for tokens...')

      let tokens: GoogleOAuthTokens
      try {
        tokens = await exchangeAuthCode({
          config,
          code,
          codeVerifier: pkce.verifier,
          redirectUri: server.redirectUri,
        })
      }
      catch (err) {
        finishResponse(errorHtml(err instanceof Error ? err.message : String(err)), 500)
        throw err
      }

      // Scope validation — Google lets users deselect scopes on the consent
      // screen, and grants whatever subset they approved. Only REQUIRED scopes
      // block sign-in; OPTIONAL ones (in `scopes` but not `requiredScopes`) may
      // be declined and the caller degrades gracefully.
      const requiredScopes = config.requiredScopes ?? config.scopes
      const { missingRequired, skippedOptional } = splitMissingScopes(tokens.scope, config.scopes, requiredScopes)
      if (missingRequired.length > 0) {
        finishResponse(scopeMissingHtml(missingRequired), 400)
        throw new MissingScopesError(missingRequired, tokens.scope)
      }

      // Optional scopes declined → still a success, but say so in BOTH places:
      // the browser tab (where the decision was made) and the CLI status stream.
      if (skippedOptional.length > 0)
        options.onStatus?.('Note: you skipped the optional Play app-list permission — app-existence verification will be skipped.')
      finishResponse(successHtml(skippedOptional))
      return tokens
    }
    finally {
      server.close()
    }
  })()

  // Return immediately — do NOT await result.
  return { authUrl, redirectUri: server.redirectUri, result, close: server.close }
}

/**
 * Run the full browser-based OAuth flow and return tokens.
 *
 * Side effects:
 *  - Opens a browser window at Google's consent screen.
 *  - Starts (and later stops) a loopback HTTP server on 127.0.0.1.
 *
 * Delegates to `startOAuthFlow` and awaits the result — preserving the
 * original blocking behavior Ink depends on.
 */
export async function runOAuthFlow(
  config: GoogleOAuthConfig,
  options: RunOAuthFlowOptions = {},
): Promise<GoogleOAuthTokens> {
  const session = await startOAuthFlow(config, options)
  options.onStatus?.('Waiting for browser redirect...')
  return await session.result
}
