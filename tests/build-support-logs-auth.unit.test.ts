import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkPermissionMock, drizzleExecuteMock, closeClientMock } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  drizzleExecuteMock: vi.fn(),
  closeClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(() => ({ id: 'pg-client' })),
  getDrizzleClient: vi.fn(() => ({ execute: drizzleExecuteMock })),
  closeClient: closeClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlogErr: vi.fn(),
}))

const { hasSupportLogUploadPermission } = await import('../supabase/functions/_backend/public/build/support_logs.ts')

function context() {
  return {
    get: vi.fn(() => 'test-request-id'),
  }
}

describe('support logs RBAC upload gate', () => {
  const apikey = {
    rbac_id: '00000000-0000-0000-0000-000000000123',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('allows registered app uploads only with app.build_native', async () => {
    checkPermissionMock.mockResolvedValueOnce(true)

    await expect(hasSupportLogUploadPermission(context() as any, apikey as any, 'com.test.app')).resolves.toBe(true)

    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'app.build_native', { appId: 'com.test.app' })
    expect(drizzleExecuteMock).not.toHaveBeenCalled()
  })

  it('denies read-only keys for registered apps', async () => {
    checkPermissionMock.mockResolvedValueOnce(false)
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ exists: true }] })

    await expect(hasSupportLogUploadPermission(context() as any, apikey as any, 'com.test.app')).resolves.toBe(false)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(1)
  })

  it('uses current org write capability only when the app is not registered yet', async () => {
    checkPermissionMock.mockResolvedValueOnce(false)
    drizzleExecuteMock
      .mockResolvedValueOnce({ rows: [{ exists: false }] })
      .mockResolvedValueOnce({ rows: [{ allowed: true }] })

    await expect(hasSupportLogUploadPermission(context() as any, apikey as any, 'com.new.app')).resolves.toBe(true)

    expect(drizzleExecuteMock).toHaveBeenCalledTimes(2)
  })

  it('denies app-less uploads without a current write-capable org binding', async () => {
    drizzleExecuteMock.mockResolvedValueOnce({ rows: [{ allowed: false }] })

    await expect(hasSupportLogUploadPermission(context() as any, apikey as any)).resolves.toBe(false)

    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(drizzleExecuteMock).toHaveBeenCalledTimes(1)
  })
})
