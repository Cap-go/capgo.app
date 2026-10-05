import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('EdgeRuntime', {})

const mocks = vi.hoisted(() => ({
  closeClient: vi.fn(async () => undefined),
  getAppByIdPg: vi.fn(),
  getDrizzleClient: vi.fn(),
  getPgClient: vi.fn(() => ({ id: 'primary-client' })),
  checkPermissionPg: vi.fn(),
  versionRows: [] as Array<Record<string, unknown>>,
}))

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/hono_middleware.ts')>()
  return {
    ...actual,
    middlewareKey: vi.fn(() => async (c: any, next: () => Promise<void>) => {
      c.set('auth', {
        userId: '00000000-0000-0000-0000-000000000001',
        authType: 'apikey',
        apikey: { id: 1, user_id: '00000000-0000-0000-0000-000000000001' },
        jwt: null,
      })
      c.set('apikey', { id: 1, user_id: '00000000-0000-0000-0000-000000000001' })
      c.set('capgkey', 'test-api-key')
      await next()
    }),
  }
})

vi.mock('../supabase/functions/_backend/utils/pg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/pg.ts')>()
  return {
    ...actual,
    closeClient: mocks.closeClient,
    getAppByIdPg: mocks.getAppByIdPg,
    getDrizzleClient: mocks.getDrizzleClient,
    getPgClient: mocks.getPgClient,
  }
})

vi.mock('../supabase/functions/_backend/utils/rbac.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../supabase/functions/_backend/utils/rbac.ts')>()
  return { ...actual, checkPermissionPg: mocks.checkPermissionPg }
})

const { default: apiWorker } = await import('../cloudflare_workers/api/index.ts')

function validRequestBody() {
  return {
    protocol_version: 1,
    version_id: 123,
    delta_encryption: { enabled: false },
    manifest_upload_auto_enabled: false,
    file_hash_format: 'sha256_hex',
    entries: [{
      id: 0,
      file_name: 'index.html',
      compression: 'none',
      file_hash: 'a'.repeat(64),
      uploaded_bytes_sha256: 'b'.repeat(64),
      uploaded_bytes_size: 123,
    }],
  }
}

async function postRequest(body: unknown) {
  return await apiWorker.fetch(new Request('https://api.capgo.app/private/request_manifest_upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('request_manifest_upload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_SECRET', 'dedicated-capability-secret-32-bytes')
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_KEY_ID', '2026-10-a')
    vi.stubEnv('PUBLIC_URL', 'https://api.capgo.app')
    mocks.versionRows = [{
      id: 123,
      appId: 'com.example.app',
      deleted: false,
      deletedAt: null,
      storageProvider: 'r2-direct',
      sessionKey: null,
    }]
    mocks.getDrizzleClient.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => mocks.versionRows),
          })),
        })),
      })),
    })
    mocks.checkPermissionPg.mockResolvedValue(true)
    mocks.getAppByIdPg.mockResolvedValue({
      owner_org: '00000000-0000-0000-0000-000000000001',
      plan_valid: true,
    })
  })

  it('uses the request-invalid contract for malformed JSON', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'error_manifest_upload_request_invalid',
      moreInfo: { field: 'body' },
    })
  })

  it('rejects a declared body larger than the bounded protocol limit', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(32 * 1024 * 1024 + 1),
      },
      body: '{}',
    }))

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ error: 'error_manifest_too_large' })
  })

  it('rejects client-owned path and ownership fields instead of ignoring them', async () => {
    const response = await apiWorker.fetch(new Request('https://api.capgo.app/private/request_manifest_upload', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...validRequestBody(), owner_org: 'attacker-selected-org' }),
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: 'error_manifest_upload_request_invalid',
      moreInfo: { field: 'owner_org' },
    })
  })

  it('authorizes once and returns server-selected paths with exact-path capabilities', async () => {
    const before = Math.floor(Date.now() / 1000)
    const response = await postRequest(validRequestBody())

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      protocol_version: 1,
      version_id: 123,
      default_action: 'upload_if_doesnt_exist',
      default_s3_path_prefix: 'orgs/00000000-0000-0000-0000-000000000001/apps/com.example.app/delta/',
      default_upload_target: 'capgo_tus_v1',
      upload_targets: [{
        id: 'capgo_tus_v1',
        protocol: 'tus',
        upload_url: 'https://api.capgo.app/files/upload/attachments/',
        existence_check_url_prefix: 'https://api.capgo.app/files/read/attachments/',
        authorization: {
          type: 'header',
          header_name: 'X-Capgo-Upload-Token',
        },
      }],
      entries: [{ id: 0 }],
    })
    const authorization = body.upload_targets[0].authorization
    expect(authorization.expires_at).toBeGreaterThanOrEqual(before + 599)
    expect(authorization.expires_at).toBeLessThanOrEqual(before + 600)
    expect(authorization.token_prefix).toBe(`v1.2026-10-a.${authorization.expires_at}.123.0.`)
    expect(body.entries[0].s3_path_suffix).toMatch(/^[0-9a-f]{64}_index\.html$/)
    expect(body.entries[0].upload_token).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(mocks.getPgClient).toHaveBeenCalledTimes(1)
    expect(mocks.getPgClient).toHaveBeenCalledWith(expect.anything(), false)
    expect(mocks.checkPermissionPg).toHaveBeenCalledTimes(1)
    expect(mocks.getAppByIdPg).toHaveBeenCalledTimes(1)
    expect(mocks.closeClient).toHaveBeenCalledTimes(1)
  })

  it('uses the configured files-service URL instead of the API request host', async () => {
    vi.stubEnv('FILES_PUBLIC_URL', 'https://files.example.invalid')
    const response = await postRequest(validRequestBody())
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.upload_targets[0]).toMatchObject({
      upload_url: 'https://files.example.invalid/files/upload/attachments/',
      existence_check_url_prefix: 'https://files.example.invalid/files/read/attachments/',
    })
  })

  it('uses the Supabase functions base outside the Worker runtime', async () => {
    vi.stubEnv('FILES_PUBLIC_URL', '')
    vi.stubEnv('PUBLIC_URL', '')
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    const response = await postRequest(validRequestBody())
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(body.upload_targets[0]).toMatchObject({
      upload_url: 'https://project.supabase.co/functions/v1/files/upload/attachments/',
      existence_check_url_prefix: 'https://project.supabase.co/functions/v1/files/read/attachments/',
    })
  })

  it('uses the same non-oracle response for missing and inaccessible versions', async () => {
    mocks.versionRows = []
    const missing = await postRequest(validRequestBody())
    const missingBody = await missing.json()

    mocks.versionRows = [{
      id: 123,
      appId: 'com.example.app',
      deleted: false,
      deletedAt: null,
      storageProvider: 'r2-direct',
      sessionKey: null,
    }]
    mocks.checkPermissionPg.mockResolvedValue(false)
    const inaccessible = await postRequest(validRequestBody())

    expect(missing.status).toBe(404)
    expect(inaccessible.status).toBe(404)
    expect(await inaccessible.json()).toEqual(missingBody)
    expect(missingBody).toMatchObject({ error: 'error_version_not_found' })
  })

  it.each([
    ['deleted', { deleted: true }],
    ['finalized', { storageProvider: 'r2' }],
  ])('rejects %s versions as not uploadable', async (_state, versionOverride) => {
    mocks.versionRows = [{ ...mocks.versionRows[0], ...versionOverride }]
    const response = await postRequest(validRequestBody())

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'error_version_not_uploadable' })
  })

  it('requires a stored session key for encrypted delta files', async () => {
    const body = validRequestBody()
    body.delta_encryption.enabled = true
    body.file_hash_format = 'rsa_v3_hex'
    body.entries[0]!.file_hash = 'c'.repeat(512)
    const response = await postRequest(body)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: 'error_delta_encryption_invalid' })
  })

  it('preserves the hosted-upload on-premise rejection contract', async () => {
    mocks.getAppByIdPg.mockResolvedValue({
      owner_org: '00000000-0000-0000-0000-000000000001',
      plan_valid: false,
    })
    const response = await postRequest(validRequestBody())

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toMatchObject({ error: 'on_premise_app' })
    expect(response.headers.get('cache-control')).toMatch(/^public, max-age=/)
  })

  it('fails closed when dedicated signing configuration is unavailable', async () => {
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_SECRET', '')
    const response = await postRequest(validRequestBody())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'upload_authorization_unavailable' })
    expect(mocks.closeClient).toHaveBeenCalledTimes(1)
  })

  it('refuses to reuse the manifest-size receipt secret', async () => {
    const reusedSecret = '0123456789abcdef0123456789abcdef'
    vi.stubEnv('MANIFEST_UPLOAD_CAPABILITY_SECRET', reusedSecret)
    vi.stubEnv('MANIFEST_SIZE_RECEIPT_SECRET', reusedSecret)
    const response = await postRequest(validRequestBody())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: 'upload_authorization_unavailable' })
  })
})
