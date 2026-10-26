import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn()
const getPgClientMock = vi.fn((_c: unknown, _readOnly?: boolean) => ({}))
const getUserIdFromApikeyMock = vi.fn()
const checkPermissionPgFreshRetryMock = vi.fn(async () => true)

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: any
    env: any
    constructor(ctx: any, env: any) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'workerd',
  }
})

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: () => Promise.resolve(),
  sendDiscordAlert: () => Promise.resolve(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: () => Promise.resolve(),
  getDrizzleClient: vi.fn(() => ({ execute: executeMock })),
  getPgClient: getPgClientMock,
  logPgError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_files.ts', () => ({
  getAppPlanStatePg: vi.fn(),
  withFreshPgRetry: vi.fn(),
  getUserIdFromApikey: getUserIdFromApikeyMock,
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  setAPIKeyRateLimitHeaders: vi.fn(),
  setFailedAuthRateLimitPolicyHeader: vi.fn(),
  isAPIKeyRateLimited: vi.fn(async () => ({ limited: false })),
  isIPRateLimited: vi.fn(async () => ({ limited: false })),
  recordAPIKeyUsage: vi.fn(async () => undefined),
  recordFailedAuth: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermissionPg: vi.fn(async () => true),
  checkPermissionPgFreshRetry: checkPermissionPgFreshRetryMock,
}))

const attackerPrefix = 'orgs/attacker-org/apps/com.attacker.app'
const victimSuffix = 'orgs/victim-org/apps/com.victim.app/1.0.0.zip'
const traversalKey = `${attackerPrefix}/../../../../${victimSuffix}`

describe('attachment key path validation', () => {
  it.concurrent.each([
    `${attackerPrefix}/1.0.0.zip`,
    `${attackerPrefix}/delta/hash_%2Eenv`,
    `${attackerPrefix}/delta/hash_sad_post_grey%402x.png`,
    `${attackerPrefix}/test-%zz 100%.zip`,
    `${attackerPrefix}/..foo/a.zip`,
  ])('accepts a normal app-scoped key: %s', async (key) => {
    const { isSafeAttachmentKey, parseAppScopedAttachmentPath } = await import('../supabase/functions/_backend/files/util.ts')
    expect(isSafeAttachmentKey(key)).toBe(true)
    expect(parseAppScopedAttachmentPath(key)).toEqual({ kind: 'scoped', owner_org: 'attacker-org', app_id: 'com.attacker.app' })
  })

  it.concurrent.each([
    traversalKey,
    `${attackerPrefix}/./1.0.0.zip`,
    `${attackerPrefix}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/${victimSuffix}`,
    `${attackerPrefix}/%2E/1.0.0.zip`,
    `${attackerPrefix}/.%2e/1.0.0.zip`,
    `${attackerPrefix}/..%2f..%2f..%2f..%2f${victimSuffix}`,
    `${attackerPrefix}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f${victimSuffix}`,
    `${attackerPrefix}/..%5c..%5c${victimSuffix}`,
    `${attackerPrefix}/..\\..\\${victimSuffix}`,
    `${attackerPrefix}/a\0.zip`,
    `${attackerPrefix}//1.0.0.zip`,
    'orgs/../apps/com.attacker.app/1.0.0.zip',
    'orgs/attacker-org/apps/../1.0.0.zip',
  ])('rejects a key that can resolve outside its app scope: %s', async (key) => {
    const { isSafeAttachmentKey, parseAppScopedAttachmentPath } = await import('../supabase/functions/_backend/files/util.ts')
    expect(isSafeAttachmentKey(key)).toBe(false)
    expect(parseAppScopedAttachmentPath(key)).toEqual({ kind: 'invalid_scoped' })
  })

  it.concurrent('round-trips safe keys through the upload location encoding', async () => {
    const { decodeUploadLocationKey, encodeR2KeyForUploadLocation } = await import('../supabase/functions/_backend/files/util.ts')
    const key = `${attackerPrefix}/test-%zz 100%.zip`
    const url = new URL(`http://localhost/files/upload/attachments/${encodeR2KeyForUploadLocation(key)}`)
    expect(decodeUploadLocationKey(url.pathname.slice('/files/upload/attachments/'.length))).toBe(key)
  })
})

describe('attachment upload routes reject traversal keys before authorization', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    executeMock.mockResolvedValue({
      rows: [{
        id: 123,
        created_at: new Date().toISOString(),
        user_id: '00000000-0000-0000-0000-000000000001',
        key: 'valid-upload-key',
        key_hash: null,
        updated_at: null,
        name: 'test key',
        limited_to_orgs: null,
        limited_to_apps: null,
        expires_at: null,
      }],
    })
  })

  async function send(method: string, path: string, headers: Record<string, string> = {}) {
    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')
    const durableObject = { fetch: vi.fn(async () => new Response(null, { status: 204 })) }
    const response = await files.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          'Authorization': 'valid-upload-key',
          'Tus-Resumable': '1.0.0',
          ...headers,
        },
        ...(method === 'PATCH' ? { body: new Uint8Array(4) } : {}),
      }),
      {
        ATTACHMENT_UPLOAD_HANDLER: {
          idFromName: (name: string) => name,
          get: () => durableObject,
        },
      },
      { waitUntil: () => { } } as any,
    )
    return { response, durableObject }
  }

  async function expectRejected(result: Awaited<ReturnType<typeof send>>) {
    expect(result.response.status).toBe(400)
    expect(await result.response.json()).toMatchObject({ error: 'invalid_file_path' })
    expect(result.durableObject.fetch).not.toHaveBeenCalled()
    expect(getUserIdFromApikeyMock).not.toHaveBeenCalled()
    expect(checkPermissionPgFreshRetryMock).not.toHaveBeenCalled()
  }

  it.each([
    traversalKey,
    `${attackerPrefix}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/${victimSuffix}`,
    `${attackerPrefix}/./1.0.0.zip`,
  ])('rejects upload creation for %s', async (key) => {
    await expectRejected(await send('POST', '/upload/attachments', {
      'Upload-Length': '4',
      'Upload-Metadata': `filename ${btoa(key)}`,
    }))
  })

  const encodedTraversalRoutes = [
    `${attackerPrefix}/..%2f..%2f..%2f..%2f${victimSuffix}`,
    `${attackerPrefix}/..%2F..%2F..%2F..%2F${victimSuffix}`,
    `${attackerPrefix}/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f${victimSuffix}`,
  ]

  it.each(encodedTraversalRoutes)('rejects PATCH for %s', async (route) => {
    await expectRejected(await send('PATCH', `/upload/attachments/${route}`, {
      'Content-Type': 'application/offset+octet-stream',
      'Upload-Offset': '0',
    }))
  })

  it.each(encodedTraversalRoutes)('rejects HEAD for %s', async (route) => {
    const { response, durableObject } = await send('HEAD', `/upload/attachments/${route}`)
    expect(response.status).toBe(400)
    expect(durableObject.fetch).not.toHaveBeenCalled()
    expect(getUserIdFromApikeyMock).not.toHaveBeenCalled()
    expect(checkPermissionPgFreshRetryMock).not.toHaveBeenCalled()
  })
})

describe('upload durable object binds the created key', () => {
  const key = `${attackerPrefix}/1.0.0.zip`
  const otherKey = victimSuffix

  async function setup(storedKey?: string) {
    const { UploadHandler } = await import('../supabase/functions/_backend/files/uploadHandler.ts')
    const { UPLOAD_INFO_KEY, UPLOAD_OFFSET_KEY, TUS_VERSION } = await import('../supabase/functions/_backend/files/util.ts')
    const data = new Map<string, unknown>([
      [UPLOAD_INFO_KEY, { uploadLength: 4, ...(storedKey ? { r2Key: storedKey } : {}) }],
      [UPLOAD_OFFSET_KEY, 0],
    ])
    const storage = {
      get: async (k: string) => data.get(k),
      put: async (k: string, value: unknown) => { data.set(k, value) },
      deleteAll: async () => data.clear(),
      deleteAlarm: async () => {},
      setAlarm: async () => {},
      getAlarm: async () => Date.now() + 86_400_000,
    }
    const bucket = {
      put: vi.fn(async (k: string) => ({ key: k, size: 4, uploaded: new Date(), etag: 'e', httpEtag: '"e"', version: 'v', checksums: { toJSON: () => ({}) }, customMetadata: {}, httpMetadata: {}, writeHttpMetadata: () => {} })),
      head: vi.fn(async () => null),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
      createMultipartUpload: vi.fn(),
      resumeMultipartUpload: vi.fn(),
    }
    const handler = new UploadHandler({ id: { toString: () => 'test-upload' }, storage, waitUntil: () => {} } as any, {
      ATTACHMENT_BUCKET: bucket as any,
      MANIFEST_SIZE_RECEIPT_SECRET: '',
      ENV_NAME: 'capgo_files-test',
    } as any)
    const request = (method: string, targetKey: string) => handler.fetch(new Request(`http://localhost/files/upload/attachments/${targetKey}`, {
      method,
      headers: { 'Content-Type': 'application/offset+octet-stream', 'Tus-Resumable': TUS_VERSION, 'Upload-Offset': '0' },
      ...(method === 'PATCH' ? { body: new Uint8Array(4) } : {}),
    }))
    return { bucket, request }
  }

  beforeEach(() => {
    vi.resetModules()
  })

  it('stores the created key and refuses PATCH to a different key', async () => {
    const { bucket, request } = await setup(key)
    const response = await request('PATCH', otherKey)
    expect(response.status).toBe(400)
    expect(bucket.put).not.toHaveBeenCalled()
  })

  it('refuses HEAD for a different key', async () => {
    const { request } = await setup(key)
    const response = await request('HEAD', otherKey)
    expect(response.status).toBe(400)
  })

  it('still accepts PATCH to the created key', async () => {
    const { bucket, request } = await setup(key)
    const response = await request('PATCH', key)
    expect(response.status).toBe(204)
    expect(bucket.put).toHaveBeenCalledWith(key, expect.anything(), expect.anything())
  })

  it('still accepts HEAD for the created key', async () => {
    const { request } = await setup(key)
    const response = await request('HEAD', key)
    expect(response.status).toBe(200)
  })

  it('keeps accepting uploads created before the key was stored', async () => {
    const { bucket, request } = await setup()
    expect((await request('HEAD', key)).status).toBe(200)
    expect((await request('PATCH', key)).status).toBe(204)
    expect(bucket.put).toHaveBeenCalledWith(key, expect.anything(), expect.anything())
  })
})
