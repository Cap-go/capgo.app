// Validates an Apple ID + app-specific password by calling the iTMSTransporter
// authenticateForSession JSON-RPC. ADVISORY ONLY: never throws on failure and
// never blocks; callers surface the result (pass / warning) but always continue.
//
// The result distinguishes a genuine AUTH REJECTION (Apple replied, credentials
// rejected) from a TRANSPORT/CHECK failure (network error, non-2xx, unparseable
// body) via `kind`, so callers don't misreport "could not reach Apple" as
// "password is wrong". Both remain advisory.
const ENDPOINT = 'https://contentdelivery.itunes.apple.com/WebObjects/MZLabelService.woa/json/MZITunesSoftwareService'

export type AppPasswordResultKind = 'authenticated' | 'rejected' | 'unreachable'
export interface AppPasswordResult { valid: boolean, kind: AppPasswordResultKind, code?: unknown, message?: string }

// Apple's iTMSTransporter ErrorMessage (and our own error strings) flow into the
// migration's validate-results view and the MCP NextStepResult.summary. Cap them
// to a single line of bounded length — stripping newlines/control chars — so a
// very large or control-character-laden Apple response cannot blow up that
// response (defense-in-depth: HTTPS already prevents network-layer injection).
const MAX_ADVISORY_MESSAGE = 200
// This validation is ADVISORY and must never block migration. Bound the Apple
// endpoint fetch so a stalled network call returns an `unreachable` result instead
// of hanging the flow forever.
const VALIDATION_TIMEOUT_MS = 15_000
function capAdvisoryMessage(raw: string): string {
  const stripped = Array.from(raw, ch => ((ch.codePointAt(0) ?? 0) < 0x20 || ch.codePointAt(0) === 0x7F ? ' ' : ch)).join('')
  const flat = stripped.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ADVISORY_MESSAGE ? `${flat.slice(0, MAX_ADVISORY_MESSAGE - 1)}…` : flat
}

export async function validateAppleAppPassword(username: string, appPassword: string, fetchImpl: typeof fetch = fetch): Promise<AppPasswordResult> {
  let res: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'iTMSTransporter/2.0.0' },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'authenticateForSession',
        id: String(Date.now()),
        params: { Username: username, Password: appPassword },
      }),
    })
  }
  catch (e) {
    // Network/DNS/TLS failure OR our own timeout abort — we could not reach Apple,
    // so we cannot judge the credential. Distinct from a rejection; never blocks.
    return { valid: false, kind: 'unreachable', message: capAdvisoryMessage(`could not reach Apple to verify (${e instanceof Error ? e.message : String(e)})`) }
  }
  finally {
    clearTimeout(timeout)
  }

  // Read the body once. Prefer text() (lets us treat an unparseable body as a
  // check failure), and fall back to json() for fetch shims that only expose it.
  let j: any = null
  let bodyParsed = true
  if (typeof (res as { text?: unknown }).text === 'function') {
    const text = await res.text().catch(() => null)
    if (text === null) {
      bodyParsed = false
    }
    else {
      try {
        j = text ? JSON.parse(text) : null
      }
      catch {
        bodyParsed = false
      }
    }
  }
  else {
    j = await (res as { json?: () => Promise<unknown> }).json?.().catch?.(() => null) ?? null
  }

  // A non-2xx response or an unparseable body means the CHECK failed, not that
  // the password was rejected.
  if (!res.ok || !bodyParsed)
    return { valid: false, kind: 'unreachable', message: capAdvisoryMessage(`verification endpoint returned HTTP ${res.status}${!bodyParsed ? ' with no parseable body' : ''}`) }
  if (j?.result?.Success === true)
    return { valid: true, kind: 'authenticated', message: 'authenticated with Apple' }
  // Apple replied but did not authenticate: a genuine rejection.
  return {
    valid: false,
    kind: 'rejected',
    code: j?.result?.ErrorCode ?? j?.error?.code,
    message: capAdvisoryMessage(String(j?.result?.ErrorMessage ?? j?.error?.message ?? 'Apple rejected the credentials')),
  }
}
