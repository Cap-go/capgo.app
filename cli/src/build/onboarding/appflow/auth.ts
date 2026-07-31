// Appflow OAuth (Authorization Code + PKCE / OpenID Connect) login, ported from
// the Ionic CLI's secure pathway. NO dependency on @ionic/cli. Used by the
// `capgo build init` Appflow migration to obtain an opaque `ion_` bearer token.
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import { spawn } from 'node:child_process'

const AUTHORIZE_URL = 'https://ionicframework.com/oauth/authorize'
const TOKEN_URL = 'https://api.ionicjs.com/oauth/token'
const AUDIENCE = 'https://api.ionicjs.com'
const CLIENT_ID = 'cli'
const REDIRECT_URI = 'http://localhost:8123'
const REDIRECT_PORT = 8123
const SCOPE = 'openid profile email offline_access'

export interface AppflowToken {
  access_token: string
  refresh_token?: string
  expires_in: number
  id_token?: string
  capturedAtMs: number
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function pkce(): { verifier: string, challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

const genNonce = (): string => b64url(randomBytes(32))

export function buildAuthorizeUrl(challenge: string, state: string, nonce: string): string {
  const u = new URL(AUTHORIZE_URL)
  for (const [k, v] of Object.entries({
    audience: AUDIENCE,
    scope: SCOPE,
    response_type: 'code',
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: REDIRECT_URI,
    nonce,
    state,
  }))
    u.searchParams.set(k, v)
  return u.toString()
}

export function isExpired(t: Pick<AppflowToken, 'expires_in' | 'capturedAtMs'>, marginMs = 60_000): boolean {
  return Date.now() >= t.capturedAtMs + t.expires_in * 1000 - marginMs
}

function defaultOpen(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url]
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref()
  }
  catch {
    // best-effort; the URL is also printed by the caller
  }
}

// Server-supplied OAuth error= strings are echoed back to the user; sanitize to a
// short, single-line, allow-listed snippet so a crafted redirect (a local process
// can hit the loopback) cannot inject control characters or huge payloads.
export function sanitizeOauthError(raw: string | null | undefined): string {
  const flat = String(raw ?? 'unknown').replace(/[^\w.\- ]+/g, ' ').replace(/\s+/g, ' ').trim()
  const capped = flat.slice(0, 80)
  return capped.length > 0 ? capped : 'unknown'
}

/**
 * Listen on the loopback redirect for the authorization code. VALIDATES the
 * redirect's `state` against the expected value (RFC 6749 §10.12) before
 * honoring it — a mismatch (or a crafted ?code= with the wrong/no state) is
 * IGNORED (answered 400, listener kept open) so a stray loopback hit cannot
 * abort an in-flight login; only the matching-state redirect resolves. This
 * defeats login-CSRF / code injection. The server is ALWAYS closed on the
 * resolving outcome (success, valid error, timeout, or external abort) and the
 * timeout timer is always cleared, so no listener or timer leaks past the login.
 *
 * `signal` lets a caller (e.g. a TUI unmount) abort the wait and free the port.
 */
function waitForCode(expectedState: string, signal?: AbortSignal): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '', REDIRECT_URI)
      const code = u.searchParams.get('code')
      const error = u.searchParams.get('error')
      const state = u.searchParams.get('state')
      if (!code && !error) {
        res.writeHead(204)
        res.end()
        return
      }
      // Validate state BEFORE honoring either `code` or `error`. A local process can
      // hit the loopback first with a wrong/absent state (a stray probe, or a
      // CSRF/code-injection attempt). Such a redirect must be IGNORED — answer 400
      // and KEEP LISTENING for the genuine redirect, rather than tearing down a login
      // that is still in flight. Only a matching-state redirect proceeds.
      if (!state || state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end('Ignored Appflow redirect with invalid state.')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<html><body style="font-family:system-ui;padding:3rem"><h2>You can close this tab and return to your terminal.</h2></body></html>')
      req.socket.destroy()
      if (error) {
        finish(undefined, new Error(`Appflow authorize returned error=${sanitizeOauthError(error)}`))
        return
      }
      if (!code) {
        finish(undefined, new Error('Appflow authorize redirect carried no authorization code.'))
        return
      }
      finish({ code })
    })
    const finish = (value?: { code: string }, err?: Error): void => {
      if (settled)
        return
      settled = true
      if (timer)
        clearTimeout(timer)
      if (signal)
        signal.removeEventListener('abort', onAbort)
      server.close()
      if (err)
        reject(err)
      else if (value)
        resolve(value)
    }
    const onAbort = (): void => finish(undefined, new Error('Appflow login cancelled.'))
    server.on('error', e => finish(undefined, e instanceof Error ? e : new Error(String(e))))
    server.listen(REDIRECT_PORT, 'localhost')
    timer = setTimeout(() => finish(undefined, new Error('Timed out waiting for the browser redirect.')), 5 * 60 * 1000)
    if (signal) {
      if (signal.aborted)
        onAbort()
      else
        signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

// Minimal runtime validation that the token endpoint actually returned a usable
// token, so a malformed response surfaces here (loud) rather than as an opaque
// downstream failure when the cached token is later used.
function asAppflowToken(j: unknown): Omit<AppflowToken, 'capturedAtMs'> {
  const o = (j ?? {}) as Record<string, unknown>
  if (typeof o.access_token !== 'string' || o.access_token.length === 0)
    throw new Error('Appflow token endpoint returned no access_token.')
  if (typeof o.expires_in !== 'number')
    throw new Error('Appflow token endpoint returned no numeric expires_in.')
  return o as unknown as Omit<AppflowToken, 'capturedAtMs'>
}

// The post-redirect token request must also be cancellable + bounded: thread the
// caller's AbortSignal (e.g. a TUI unmount) into the fetch AND apply our own
// timeout so a stalled token endpoint cannot hang the login forever. Both the
// timer and the parent-signal listener are always cleaned up.
const TOKEN_EXCHANGE_TIMEOUT_MS = 20_000
async function exchange(body: Record<string, string>, signal?: AbortSignal): Promise<AppflowToken> {
  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  const timer = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS)
  if (signal) {
    if (signal.aborted)
      controller.abort()
    else
      signal.addEventListener('abort', onParentAbort, { once: true })
  }
  let res: Response
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body),
      signal: controller.signal,
    })
  }
  finally {
    clearTimeout(timer)
    if (signal)
      signal.removeEventListener('abort', onParentAbort)
  }
  const text = await res.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  }
  catch {
    parsed = null
  }
  if (!res.ok) {
    const detail = (parsed as { error_description?: string, error?: string } | null)
    const msg = detail?.error_description ?? detail?.error
    throw new Error(`Appflow token endpoint returned HTTP ${res.status}${msg ? `: ${String(msg).replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''}`)
  }
  return { ...asAppflowToken(parsed), capturedAtMs: Date.now() }
}

export async function loginWithBrowser(opts: { openBrowser?: (url: string) => void, signal?: AbortSignal } = {}): Promise<AppflowToken> {
  const { verifier, challenge } = pkce()
  const state = b64url(randomBytes(16))
  const url = buildAuthorizeUrl(challenge, state, genNonce())
  const codeP = waitForCode(state, opts.signal)
  ;(opts.openBrowser ?? defaultOpen)(url)
  const { code } = await codeP
  return exchange({ grant_type: 'authorization_code', client_id: CLIENT_ID, code_verifier: verifier, code, redirect_uri: REDIRECT_URI }, opts.signal)
}

export async function refresh(token: AppflowToken): Promise<AppflowToken> {
  if (!token.refresh_token)
    throw new Error('No refresh_token available.')
  const t = await exchange({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: token.refresh_token })
  return { refresh_token: token.refresh_token, ...t }
}
