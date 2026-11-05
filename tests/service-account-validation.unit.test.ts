import { Buffer } from 'node:buffer'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseServiceAccountKey, validateServiceAccountJson } from '../cli/src/build/onboarding/android/service-account-validation.ts'

// ─── Test fixtures ──────────────────────────────────────────────────
//
// Generate a real RSA key once per file so JWT signing inside the
// validator doesn't blow up — even though the token endpoint is mocked,
// `jwt.sign(..., key.private_key, { algorithm: 'RS256' })` still runs
// for real and needs a parseable PEM.

const RSA_KEY = (() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  return privateKey as string
})()

const TEST_PACKAGE = 'com.example.app'
const TEST_SA_EMAIL = 'sa@my-project.iam.gserviceaccount.com'
const TEST_PROJECT_ID = 'my-project'

function buildSaJson(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'service_account',
    client_email: TEST_SA_EMAIL,
    private_key: RSA_KEY,
    project_id: TEST_PROJECT_ID,
    token_uri: 'https://oauth2.googleapis.com/token',
    private_key_id: 'abc123',
    ...overrides,
  }))
}

// ─── Mock fetch ─────────────────────────────────────────────────────
//
// Route requests by URL so each test can wire just the response shape
// it cares about. Anything unexpected throws so a forgotten mock fails
// loudly rather than silently making a real outbound call.

interface FetchHandlers {
  /** Response for POST to the SA's `token_uri`. */
  token?: (req: { url: string, init?: RequestInit }) => Response | Promise<Response>
  /** Response for POST to `applications/{pkg}/edits`. */
  insert?: (req: { url: string, init?: RequestInit }) => Response | Promise<Response>
  /** Response for DELETE to `applications/{pkg}/edits/{editId}`. */
  delete?: (req: { url: string, init?: RequestInit }) => Response | Promise<Response>
}

interface FetchCalls {
  token: number
  insert: number
  delete: number
}

function makeMockFetch(handlers: FetchHandlers): { fetch: typeof fetch, calls: FetchCalls } {
  const calls: FetchCalls = { token: 0, insert: 0, delete: 0 }
  const fetchImpl: typeof fetch = async (url, init) => {
    const urlStr = typeof url === 'string' ? url : (url as URL).toString()
    if (urlStr.includes('oauth2.googleapis.com/token') || /\btoken$/.test(urlStr)) {
      calls.token++
      if (!handlers.token)
        throw new Error(`Unexpected token request: ${urlStr}`)
      return handlers.token({ url: urlStr, init })
    }
    if (/\/edits\/[^/]+$/.test(urlStr) || (init?.method === 'DELETE' && urlStr.includes('/edits/'))) {
      calls.delete++
      if (!handlers.delete)
        throw new Error(`Unexpected delete request: ${urlStr}`)
      return handlers.delete({ url: urlStr, init })
    }
    if (urlStr.endsWith('/edits') || urlStr.includes('/edits')) {
      calls.insert++
      if (!handlers.insert)
        throw new Error(`Unexpected insert request: ${urlStr}`)
      return handlers.insert({ url: urlStr, init })
    }
    throw new Error(`Unexpected URL in mock fetch: ${urlStr}`)
  }
  return { fetch: fetchImpl, calls }
}

function goodTokenResponse() {
  return new Response(
    JSON.stringify({ access_token: 'fake-token', expires_in: 3600, token_type: 'Bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

// ─── parseServiceAccountKey (synchronous shape checks) ──────────────

describe('parseServiceAccountKey', () => {
  it('parses a valid service account JSON', () => {
    const key = parseServiceAccountKey(buildSaJson())
    expect(key.client_email).toBe(TEST_SA_EMAIL)
    expect(key.project_id).toBe(TEST_PROJECT_ID)
    expect(key.token_uri).toBe('https://oauth2.googleapis.com/token')
  })

  it.each([
    ['malformed JSON', Buffer.from('not json'), /not valid JSON/],
    ['a non-service-account `type`', Buffer.from(JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: 'y', project_id: 'z', token_uri: 'u' })), /not a service account key/],
    // JSON.stringify drops undefined keys, so the field is genuinely missing
    ['a missing private_key', buildSaJson({ private_key: undefined }), /missing required field "private_key"/],
    ['an empty client_email', buildSaJson({ client_email: '' }), /missing required field "client_email"/],
  ])('throws on %s', (_name, buf, message) => {
    expect(() => parseServiceAccountKey(buf)).toThrow(message)
  })
})

// ─── validateServiceAccountJson — failure modes ────────────────────

describe('validateServiceAccountJson — shape errors', () => {
  it.each([
    ['malformed JSON', Buffer.from('garbage'), undefined],
    ['private_key is missing', buildSaJson({ private_key: undefined }), /private_key/],
    ['type !== "service_account"', Buffer.from(JSON.stringify({ type: 'user', client_email: 'x', private_key: 'y', project_id: 'z', token_uri: 'u' })), undefined],
  ])('returns shape-error when %s', async (_name, jsonBytes, message) => {
    const result = await validateServiceAccountJson({
      jsonBytes,
      packageName: TEST_PACKAGE,
      fetchImpl: makeMockFetch({}).fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('shape-error')
      if (message)
        expect(result.message).toMatch(message)
    }
  })
})

describe('validateServiceAccountJson — token exchange', () => {
  it('returns token-error for 401 from token endpoint (credentials rejected)', async () => {
    const { fetch } = makeMockFetch({
      token: () => new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Account disabled' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('token-error')
      expect(result.message).toMatch(/invalid_grant/)
    }
  })

  it('returns network-error for 500 from token endpoint (transient)', async () => {
    // 5xx must NOT be classified as a credential rejection — the user's key
    // could be perfectly fine, Google is just having a moment. The recovery
    // UI offers retry for network-error vs. "your key is bad" for token-error.
    const { fetch } = makeMockFetch({
      token: () => new Response('Internal Server Error', { status: 500 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
  })

  it('returns network-error when token endpoint returns non-JSON (transient)', async () => {
    const { fetch } = makeMockFetch({
      token: () => new Response('<html>nginx error</html>', { status: 200 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
  })

  it('returns network-error when token response is missing access_token', async () => {
    const { fetch } = makeMockFetch({
      token: () => new Response(
        JSON.stringify({ expires_in: 3600 }), // no access_token
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
  })

  it('returns network-error when fetch itself rejects (DNS / offline)', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw Object.assign(new Error('ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' })
    }
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
  })
})

describe('validateServiceAccountJson — app-access probe', () => {
  it('returns ok with email + projectId on the happy path', async () => {
    const { fetch, calls } = makeMockFetch({
      token: goodTokenResponse,
      insert: () => new Response(
        JSON.stringify({ id: 'edit-123', expiryTimeSeconds: '1' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      delete: () => new Response(null, { status: 204 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.serviceAccountEmail).toBe(TEST_SA_EMAIL)
      expect(result.projectId).toBe(TEST_PROJECT_ID)
    }
    // Mirror of fastlane's auth path: insert + delete must both fire.
    expect(calls.token).toBe(1)
    expect(calls.insert).toBe(1)
    expect(calls.delete).toBe(1)
  })

  it('returns no-app-access on 403 from edits.insert (SA not invited)', async () => {
    const { fetch } = makeMockFetch({
      token: goodTokenResponse,
      insert: () => new Response(
        JSON.stringify({ error: { code: 403, message: 'The caller does not have permission', status: 'PERMISSION_DENIED' } }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      ),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.kind).toBe('no-app-access')
      // The recovery UI surfaces these — the SA email AND the package name
      // must both appear so the user knows exactly which invite to add.
      if (result.kind === 'no-app-access')
        expect(result.serviceAccountEmail).toBe(TEST_SA_EMAIL)
      expect(result.message).toMatch(/com\.example\.app/)
      expect(result.message).toMatch(TEST_SA_EMAIL)
    }
  })

  it('returns no-app-access on 404 from edits.insert (wrong package)', async () => {
    const { fetch } = makeMockFetch({
      token: goodTokenResponse,
      insert: () => new Response('Not Found', { status: 404 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('no-app-access')
  })

  it('returns network-error on 503 from edits.insert (transient Play API)', async () => {
    const { fetch } = makeMockFetch({
      token: goodTokenResponse,
      insert: () => new Response('Service Unavailable', { status: 503 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
  })

  it('returns ok even if cleanup DELETE fails (best-effort contract)', async () => {
    // The draft edit auto-expires after 7 days regardless — losing the
    // cleanup DELETE is a logged warning, not a failure. If we treated
    // delete-failure as fatal, a transient Google blip on the second call
    // would tell the user their key is bad. Wrong.
    const { fetch } = makeMockFetch({
      token: goodTokenResponse,
      insert: () => new Response(
        JSON.stringify({ id: 'edit-leaked', expiryTimeSeconds: '1' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
      delete: () => new Response('Internal Server Error', { status: 500 }),
    })
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl: fetch,
    })
    expect(result.ok).toBe(true)
  })
})

describe('validateServiceAccountJson — AbortSignal', () => {
  it('returns network-error when signal is already aborted before token exchange', async () => {
    const controller = new AbortController()
    controller.abort()
    // Mock fetch should never be called — we abort before reaching it.
    let tokenFired = false
    const fetchImpl: typeof fetch = async () => {
      tokenFired = true
      return new Response('{}')
    }
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl,
      signal: controller.signal,
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.kind).toBe('network-error')
    expect(tokenFired).toBe(false)
  })

  it('forwards the caller signal into fetch so mid-flight abort propagates', async () => {
    let receivedSignal: AbortSignal | undefined
    const controller = new AbortController()
    const fetchImpl: typeof fetch = async (_url, init) => {
      receivedSignal = init?.signal ?? undefined
      return new Response(
        JSON.stringify({ access_token: 'tok', expires_in: 3600, token_type: 'Bearer' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // Don't abort — just verify the signal threads through. The
    // fetchWithTimeout helper composes the caller signal with a per-request
    // timeout signal, so what fetch receives is a composite, but it must
    // exist.
    const result = await validateServiceAccountJson({
      jsonBytes: buildSaJson(),
      packageName: TEST_PACKAGE,
      fetchImpl,
      signal: controller.signal,
      // Short timeout so the test doesn't hang if something regresses.
      timeoutMs: 5000,
    })
    // The insert call wasn't mocked — validation will error out as network.
    // We only care that the signal made it into the first fetch.
    expect(receivedSignal).toBeDefined()
    expect(result.ok).toBe(false)
  })
})
