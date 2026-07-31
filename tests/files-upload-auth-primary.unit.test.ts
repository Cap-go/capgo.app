import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn()
const getPgClientMock = vi.fn((_c: unknown, _readOnly?: boolean) => ({}))
const getDrizzleClientMock = vi.fn(() => ({
  execute: executeMock,
}))
const isAPIKeyRateLimitedMock = vi.fn<(_c: unknown, _apiKeyId: number, _scope?: string) => Promise<{ limited: boolean }>>(async () => ({ limited: false }))
const recordAPIKeyUsageMock = vi.fn<(_c: unknown, _apiKeyId: number, _scope?: string) => Promise<void>>(async () => undefined)

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    getRuntimeKey: () => 'node',
  }
})

vi.mock('../supabase/functions/_backend/utils/discord.ts', () => ({
  sendDiscordAlert500: () => Promise.resolve(),
  sendDiscordAlert: () => Promise.resolve(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: () => Promise.resolve(),
  getAppByIdPg: vi.fn(),
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
  logPgError: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg_files.ts', () => ({
  getAppByAppIdPg: vi.fn(),
  getUserIdFromApikey: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rate_limit.ts', () => ({
  isAPIKeyRateLimited: isAPIKeyRateLimitedMock,
  isIPRateLimited: vi.fn(async () => ({ limited: false })),
  recordAPIKeyUsage: recordAPIKeyUsageMock,
  recordFailedAuth: vi.fn(async () => undefined),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermissionPg: vi.fn(async () => true),
}))

describe('files upload auth', () => {
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

  it('checks upload API keys against the primary database before reading upload metadata', async () => {
    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')

    const response = await files.fetch(
      new Request('http://localhost/upload/attachments', {
        method: 'POST',
        headers: {
          Authorization: 'valid-upload-key',
        },
      }),
      {},
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(404)
    expect(getPgClientMock).toHaveBeenCalledTimes(1)
    expect(getPgClientMock.mock.calls[0][1]).toBe(false)
  })

  it('uses the upload API-key rate-limit scope for upload creation', async () => {
    const { app: files } = await import('../supabase/functions/_backend/files/files.ts')

    const response = await files.fetch(
      new Request('http://localhost/upload/attachments', {
        method: 'POST',
        headers: {
          Authorization: 'valid-upload-key',
        },
      }),
      {},
      { waitUntil: () => { } } as any,
    )

    expect(response.status).toBe(404)
    expect(recordAPIKeyUsageMock).toHaveBeenCalledWith(expect.anything(), 123, 'upload')
    expect(isAPIKeyRateLimitedMock).toHaveBeenCalledWith(expect.anything(), 123, 'upload')
  })
})
