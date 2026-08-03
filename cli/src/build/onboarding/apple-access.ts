// src/build/onboarding/apple-access.ts
//
// Thin shared "can this ASC API key reach this app?" probe, used by the
// ios/asc-key-access prescan check (and reusable by the onboarding verify-key
// step) so the two never drift. Composes generateJwt (ES256) + a signal-aware,
// injectable-fetch GET /v1/apps?filter[bundleId]=<id>&limit=1 and returns a
// discriminated union shaped like the Play service-account validator's result.
//
// SECRET-HANDLING: the result's `message` is printed to the terminal and
// serialized into --json reports. It NEVER contains the .p8 PEM, the JWT, the
// Authorization header, or any credential field value - only Apple's
// human-readable error copy (or the shared verifyApiKey wording).
import { appendInternalLog, safeHeaders } from '../../support/internal-log.js'
import { redactSecrets } from '../../support/redact.js'
import {
  AppleApiHttpError,
  classifyAscAuthError,
  generateJwt,
  parseAppsResponse,
} from './apple-api.js'

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1'
const DEFAULT_TIMEOUT_MS = 7000

export interface AssertAscAccessOptions {
  keyId: string
  issuerId: string
  /** The decoded .p8 PEM string (forge.util.decode64(APPLE_KEY_CONTENT)). */
  p8Pem: string
  /** Project bundle id; when present we confirm it is reachable by the key. */
  bundleId?: string
  signal?: AbortSignal
  /** Per-request timeout. Defaults to 7s (under the engine's 10s race). */
  timeoutMs?: number
  /** Test-only injection point. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
}

interface AscProviderFailure {
  /** Apple HTTP status and sanitized structured error fields, when available. */
  status?: number
  code?: string
  title?: string
  detail?: string
}

export type AscAccessResult
  = | { ok: true }
    | ({ ok: false, kind: 'no-app-access' | 'auth-error' | 'network', message: string }
      & AscProviderFailure)

const NETWORKY_RE = /timeout|timed out|network|fetch failed|aborted|ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED/i
const MAX_ERROR_FIELD_LENGTH = 500

function safeErrorField(value: unknown, credentialValues: string[]): string | undefined {
  if (typeof value !== 'string')
    return undefined
  let safe = redactSecrets(value)
  for (const credential of credentialValues) {
    if (credential)
      safe = safe.replaceAll(credential, '[REDACTED IDENTIFIER]')
  }
  safe = safe.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()
  return safe ? safe.slice(0, MAX_ERROR_FIELD_LENGTH) : undefined
}

/**
 * Probe App Store Connect for app access. Never throws - every failure shape is
 * returned as `{ ok: false, kind }` so the prescan check can self-classify the
 * severity from the HTTP status and sanitized Apple reason. Network failures
 * remain distinguishable so prescan can surface them as warnings.
 */
export async function assertAscAccess(opts: AssertAscAccessOptions): Promise<AscAccessResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (opts.signal?.aborted)
    return { ok: false, kind: 'network', message: 'App Store Connect check cancelled.' }

  // Sign the request JWT. A malformed/non-EC PEM throws here - treat as
  // auth-error (the key material itself is unusable), never leaking the PEM.
  let token: string
  try {
    token = generateJwt(opts.keyId, opts.issuerId, opts.p8Pem)
  }
  catch {
    return { ok: false, kind: 'auth-error', message: 'Could not sign the App Store Connect request - the .p8 key, Key ID, or Issuer ID is invalid.' }
  }

  // Own 7s AbortController so the fetch aborts cleanly BEFORE the engine's 10s
  // Promise.race (which resolves a timeout Finding but does not cancel fetches).
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = (): void => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const filter = opts.bundleId ? `?filter[bundleId]=${encodeURIComponent(opts.bundleId)}&limit=1` : '?limit=1'
  const path = `/apps${filter}`

  try {
    const res = await fetchImpl(`${ASC_BASE_URL}${path}`, {
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })
    const body: any = await res.json().catch(() => null)

    if (!res.ok) {
      const first = (body?.errors ?? [])[0]
      // Mirror ascFetch's internal logging (Authorization never logged via safeHeaders).
      appendInternalLog(`apple-access GET ${path}: HTTP ${res.status} ${res.statusText} ${JSON.stringify(body?.errors ?? null)} | ${safeHeaders(res.headers)}`)
      const httpErr = new AppleApiHttpError(
        res.status,
        first ? `Apple API error (${res.status}): ${first.title} - ${first.detail} (${first.code})` : `Apple API error: HTTP ${res.status} ${res.statusText}`,
        first?.code,
      )
      const cls = classifyAscAuthError(httpErr)
      const credentialValues = [opts.keyId, opts.issuerId]
      const providerFailure: AscProviderFailure = {
        status: res.status,
        code: safeErrorField(first?.code, credentialValues),
        title: safeErrorField(first?.title, credentialValues),
        detail: safeErrorField(first?.detail, credentialValues),
      }
      if (cls.is401or403)
        return { ok: false, kind: 'auth-error', message: cls.message, ...providerFailure }
      // 5xx / 429 / other transport-ish HTTP: warning upstream.
      return { ok: false, kind: 'network', message: `App Store Connect returned HTTP ${res.status}.`, ...providerFailure }
    }

    appendInternalLog(`apple-access GET ${path}: HTTP ${res.status} | ${safeHeaders(res.headers)}`)

    if (opts.bundleId) {
      const apps = parseAppsResponse(body)
      const found = apps.some(a => a.bundleId === opts.bundleId)
      if (!found) {
        return {
          ok: false,
          kind: 'no-app-access',
          message: `The App Store Connect API key cannot see an app with bundle id ${opts.bundleId}.`,
        }
      }
    }
    return { ok: true }
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isAbort = (err as { name?: string } | null)?.name === 'AbortError' || controller.signal.aborted
    if (isAbort || NETWORKY_RE.test(message))
      return { ok: false, kind: 'network', message: 'Could not reach App Store Connect (network error or timeout).' }
    // Unknown failure: degrade to non-blocking network rather than guess auth.
    return { ok: false, kind: 'network', message: 'App Store Connect check failed unexpectedly.' }
  }
  finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
