import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeMock = vi.fn()
const getPgClientMock = vi.fn(() => ({}))
const getDrizzleClientMock = vi.fn(() => ({
  execute: executeMock,
}))
const closeClientMock = vi.fn()

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
}))

const { checkPermission, checkPermissionPg } = await import('../supabase/functions/_backend/utils/rbac.ts')

function makeContext(auth: Record<string, unknown> | undefined = {
  userId: '00000000-0000-4000-8000-000000000001',
  authType: 'apikey',
  apikey: {
    key: 'capgo_test_key',
    rbac_id: 42,
  },
}) {
  return {
    get: (key: string) => {
      if (key === 'auth')
        return auth
      if (key === 'requestId')
        return 'req-test'
      if (key === 'capgkey')
        return 'capgo_test_key'
      return undefined
    },
  } as any
}

describe('rbac permission infra errors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checkPermission returns false for real ACL denials', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ allowed: false }] })

    await expect(checkPermission(makeContext(), 'app.upload_bundle', { appId: 'ai.offthetools.app' }))
      .resolves
      .toBe(false)
  })

  it('checkPermission surfaces Postgres failures as 503 upstream_unavailable', async () => {
    executeMock.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'))

    await expect(checkPermission(makeContext(), 'app.upload_bundle', { appId: 'ai.offthetools.app' }))
      .rejects
      .toMatchObject({
        status: 503,
        cause: {
          error: 'upstream_unavailable',
          message: 'Permission check temporarily unavailable',
        },
      })

    expect(closeClientMock).toHaveBeenCalled()
  })

  it('checkPermissionPg surfaces Postgres failures as 503 upstream_unavailable', async () => {
    executeMock.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))

    await expect(checkPermissionPg(
      makeContext(),
      'app.upload_bundle',
      { appId: 'ai.offthetools.app' },
      getDrizzleClientMock() as any,
      '00000000-0000-4000-8000-000000000001',
      'capgo_test_key',
    )).rejects.toMatchObject({
      status: 503,
      cause: {
        error: 'upstream_unavailable',
      },
    })
  })

  it('checkPermissionPg rethrows existing HTTPException without remapping', async () => {
    const httpError = new HTTPException(409, { message: 'conflict' })
    executeMock.mockRejectedValueOnce(httpError)

    await expect(checkPermissionPg(
      makeContext(),
      'app.upload_bundle',
      { appId: 'ai.offthetools.app' },
      getDrizzleClientMock() as any,
      '00000000-0000-4000-8000-000000000001',
      'capgo_test_key',
    )).rejects.toBe(httpError)
  })

  it('checkPermissionPg returns false for real ACL denials', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ allowed: false }] })

    await expect(checkPermissionPg(
      makeContext(),
      'app.upload_bundle',
      { appId: 'ai.offthetools.app' },
      getDrizzleClientMock() as any,
      '00000000-0000-4000-8000-000000000001',
      'capgo_test_key',
    )).resolves.toBe(false)
  })
})
