import type { Context, Next } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  closeClientMock,
  doFetchMock,
  getPgClientMock,
  isIPRateLimitedMock,
  legacyAuthenticationMock,
  recordFailedAuthMock,
} = vi.hoisted(() => ({
  closeClientMock: vi.fn(),
  doFetchMock: vi.fn(),
  getPgClientMock: vi.fn(() => {
    throw new Error('capability uploads must not open a database connection')
  }),
  isIPRateLimitedMock: vi.fn(),
  legacyAuthenticationMock: vi.fn(),
  recordFailedAuthMock: vi.fn(),
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'workerd',
  }
})

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareKey: () => async (_c: Context, next: Next) => {
    legacyAuthenticationMock()
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  isIPRateLimited: isIPRateLimitedMock,
  recordFailedAuth: recordFailedAuthMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getAppByIdPg: vi.fn(),
  getDatabaseURL: vi.fn(() => 'postgres://test'),
  getDrizzleClient: vi.fn(() => ({})),
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg_files.ts', () => ({
  getAppByAppIdPg: vi.fn(),
  getUserIdFromApikey: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermissionPg: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert: vi.fn(),
  sendDiscordAlert500: vi.fn(),
}))

const keyId = '2026-10-a'
const secret = 'manifest-upload-capability-secret-for-unit-tests'
const path = 'orgs/00000000-0000-0000-0000-000000000001/apps/com.example.app/delta/hash_assets%20logo.png'
const capabilityEnv = {
  MANIFEST_UPLOAD_CAPABILITY_KEY_ID: keyId,
  MANIFEST_UPLOAD_CAPABILITY_SECRET: secret,
}

function encodePathForRoute(value: string): string {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/')
}

function uploadMetadata(value: string): string {
  return `filename ${btoa(String.fromCharCode(...new TextEncoder().encode(value)))}`
}

async function createFilesApp() {
  const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
  const { Hono } = await import('hono/tiny')
  const app = new Hono()
  app.route('/files', files)
  return app
}

async function createToken(options: { autoEnabled?: boolean, expiresAt?: number, tokenPath?: string } = {}) {
  const { createManifestUploadCapability } = await import('../supabase/functions/_backend/utils/manifest_upload_capability.ts')
  const nowUnixSeconds = Math.floor(Date.now() / 1000)
  const expiresAt = options.expiresAt ?? nowUnixSeconds + 600
  return await createManifestUploadCapability({
    expiresAt,
    keyId,
    manifestUploadAutoEnabled: options.autoEnabled ?? false,
    path: options.tokenPath ?? path,
    secret,
    versionId: 12345,
  }, expiresAt > nowUnixSeconds ? nowUnixSeconds : expiresAt - 600)
}

function buildEnv() {
  return {
    ...capabilityEnv,
    ATTACHMENT_UPLOAD_HANDLER: {
      get: () => ({ fetch: doFetchMock }),
      idFromName: (name: string) => name,
    },
  }
}

async function capabilityRequest(method: 'HEAD' | 'PATCH' | 'POST', token: string, requestPath = path) {
  const headers = new Headers({
    'Tus-Resumable': '1.0.0',
    'X-Capgo-Upload-Token': token,
  })
  let url = 'http://localhost/files/upload/attachments'
  let body: string | undefined

  if (method === 'POST') {
    headers.set('Content-Type', 'application/offset+octet-stream')
    headers.set('Upload-Length', '0')
    headers.set('Upload-Metadata', uploadMetadata(requestPath))
  }
  else {
    url += `/${encodePathForRoute(requestPath)}`
    if (method === 'PATCH') {
      headers.set('Content-Type', 'application/offset+octet-stream')
      headers.set('Upload-Offset', '0')
      body = 'x'
    }
  }

  const app = await createFilesApp()
  return await app.fetch(new Request(url, { method, headers, body }), buildEnv(), { waitUntil: () => {} } as any)
}

describe('files manifest upload capabilities', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_KEY_ID', keyId)
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_SECRET', secret)
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS', '')
    isIPRateLimitedMock.mockResolvedValue({ limited: false })
    recordFailedAuthMock.mockResolvedValue(undefined)
    doFetchMock.mockImplementation(async (request: Request) => {
      expect(request.headers.has('X-Capgo-Upload-Token')).toBe(false)
      return new Response(null, { status: request.method === 'POST' ? 201 : request.method === 'PATCH' ? 204 : 200 })
    })
  })

  it('returns the shared prefix and opaque suffix and enforces the ten-minute lifetime', async () => {
    const { createManifestUploadCapability } = await import('../supabase/functions/_backend/utils/manifest_upload_capability.ts')
    const issuedAt = 1_790_956_800
    const input = {
      expiresAt: issuedAt + 600,
      keyId,
      manifestUploadAutoEnabled: false,
      path,
      secret,
      versionId: 12345,
    }

    const capability = await createManifestUploadCapability(input, issuedAt)

    expect(capability.tokenPrefix).toBe('v1.2026-10-a.1790957400.12345.0.')
    expect(capability.uploadToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(capability.token).toBe(`${capability.tokenPrefix}${capability.uploadToken}`)
    await expect(createManifestUploadCapability({ ...input, expiresAt: issuedAt + 601 }, issuedAt))
      .rejects.toThrow('Cannot sign invalid manifest upload capability')
  })

  it.each(['POST', 'HEAD', 'PATCH'] as const)('authorizes %s without API-key or database authentication', async (method) => {
    const capability = await createToken()

    const response = await capabilityRequest(method, capability.token)

    expect(response.status).toBe(method === 'POST' ? 201 : method === 'PATCH' ? 204 : 200)
    expect(isIPRateLimitedMock).toHaveBeenCalledOnce()
    expect(legacyAuthenticationMock).not.toHaveBeenCalled()
    expect(getPgClientMock).not.toHaveBeenCalled()
    expect(doFetchMock).toHaveBeenCalledOnce()
  })

  it.each(['HEAD', 'PATCH'] as const)('forwards the normalized path for %s requests that use a Supabase TUS ID', async (method) => {
    const capability = await createToken()
    const supabaseTusId = btoa(`capgo/${path}/00000000-0000-0000-0000-000000000002`)
    const headers = new Headers({
      'Tus-Resumable': '1.0.0',
      'X-Capgo-Upload-Token': capability.token,
    })
    let body: string | undefined
    if (method === 'PATCH') {
      headers.set('Content-Type', 'application/offset+octet-stream')
      headers.set('Upload-Offset', '0')
      body = 'x'
    }
    const app = await createFilesApp()

    const response = await app.fetch(new Request(
      `http://localhost/files/upload/attachments/${encodeURIComponent(supabaseTusId)}`,
      { method, headers, body },
    ), buildEnv(), { waitUntil: () => {} } as any)

    expect(response.status).toBe(method === 'PATCH' ? 204 : 200)
    const forwardedRequest = doFetchMock.mock.calls[0]?.[0] as Request
    expect(new URL(forwardedRequest.url).pathname).toBe(`/files/upload/attachments/${encodePathForRoute(path)}`)
  })

  it('does not fall back to an accompanying API key when the capability is invalid', async () => {
    const app = await createFilesApp()
    const response = await app.fetch(new Request('http://localhost/files/upload/attachments', {
      method: 'POST',
      headers: {
        'Authorization': 'valid-looking-api-key',
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '0',
        'Upload-Metadata': uploadMetadata(path),
        'X-Capgo-Upload-Token': 'malformed',
      },
    }), buildEnv(), { waitUntil: () => {} } as any)

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: 'upload_token_invalid',
      abandon_explicit_error: expect.any(String),
    })
    expect(legacyAuthenticationMock).not.toHaveBeenCalled()
    expect(recordFailedAuthMock).toHaveBeenCalledOnce()
    expect(doFetchMock).not.toHaveBeenCalled()
  })

  it('rejects capability requests from an IP blocked by failed-auth throttling', async () => {
    isIPRateLimitedMock.mockResolvedValue({ limited: true, resetAt: Date.now() + 60_000 })
    const capability = await createToken()

    const response = await capabilityRequest('POST', capability.token)

    expect(response.status).toBe(429)
    expect(recordFailedAuthMock).not.toHaveBeenCalled()
    expect(doFetchMock).not.toHaveBeenCalled()
  })

  it('rejects a token used for a different normalized path', async () => {
    const capability = await createToken({ tokenPath: `${path}.other` })

    const response = await capabilityRequest('POST', capability.token)

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: 'upload_token_invalid',
      abandon_explicit_error: expect.any(String),
    })
    expect(doFetchMock).not.toHaveBeenCalled()
  })

  it('accepts a still-valid capability signed by a configured previous key', async () => {
    const capability = await createToken()
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_KEY_ID', '2026-10-b')
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_SECRET', 'replacement-manifest-upload-secret-for-tests')
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_PREVIOUS_SECRETS', JSON.stringify({ [keyId]: secret }))

    const response = await capabilityRequest('POST', capability.token)

    expect(response.status).toBe(201)
    expect(doFetchMock).toHaveBeenCalledOnce()
  })

  it('allows one minute of issuer clock skew at the maximum token lifetime', async () => {
    const { createManifestUploadCapability } = await import('../supabase/functions/_backend/utils/manifest_upload_capability.ts')
    const verifierNow = Math.floor(Date.now() / 1000)
    const issuerNow = verifierNow + 60
    const capability = await createManifestUploadCapability({
      expiresAt: issuerNow + 600,
      keyId,
      manifestUploadAutoEnabled: false,
      path,
      secret,
      versionId: 12345,
    }, issuerNow)

    const response = await capabilityRequest('POST', capability.token)

    expect(response.status).toBe(201)
    expect(doFetchMock).toHaveBeenCalledOnce()
  })

  it.each([
    [false, 'abandon_explicit_error'],
    [true, 'abandon_manifest_only_explicit_error'],
  ] as const)('returns the signed expiry fallback for auto-enabled=%s', async (autoEnabled, abandonField) => {
    const capability = await createToken({
      autoEnabled,
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    })

    const response = await capabilityRequest('POST', capability.token)
    const body = await response.json() as Record<string, unknown>

    expect(response.status).toBe(401)
    expect(body).toMatchObject({ error: 'upload_token_expired', [abandonField]: expect.any(String) })
    expect(body[autoEnabled ? 'abandon_explicit_error' : 'abandon_manifest_only_explicit_error']).toBeUndefined()
    expect(doFetchMock).not.toHaveBeenCalled()
  })

  it('keeps the legacy authentication branch when the capability header is absent', async () => {
    const app = await createFilesApp()
    const response = await app.fetch(new Request('http://localhost/files/upload/attachments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Tus-Resumable': '1.0.0',
        'Upload-Length': '0',
      },
    }), buildEnv(), { waitUntil: () => {} } as any)

    expect(response.status).toBe(404)
    expect(legacyAuthenticationMock).toHaveBeenCalledOnce()
    expect(doFetchMock).not.toHaveBeenCalled()
  })

  it('allows the capability header in upload preflights', async () => {
    const app = await createFilesApp()
    const response = await app.fetch(new Request('http://localhost/files/upload/attachments', { method: 'OPTIONS' }), buildEnv())

    expect(response.status).toBe(204)
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Capgo-Upload-Token')
  })
})
