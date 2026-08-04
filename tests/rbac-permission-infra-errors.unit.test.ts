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

  it('checkPermission surfaces connection failures as 503 upstream_unavailable', async () => {
    executeMock.mockRejectedValueOnce(Object.assign(new Error('Connection terminated unexpectedly'), {
      code: 'ECONNRESET',
    }))

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

  it('checkPermissionPg surfaces Hyperdrive connect timeouts as 503', async () => {
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

  it('checkPermissionPg treats invalid UUID cast errors as ACL deny, not 503', async () => {
    const invalidUuidError = Object.assign(new Error('invalid input syntax for type uuid: "non-user-org-id"'), {
      code: '22P02',
    })
    executeMock.mockRejectedValueOnce(invalidUuidError)

    await expect(checkPermissionPg(
      makeContext(),
      'org.read',
      { orgId: 'non-user-org-id' },
      getDrizzleClientMock() as any,
      '00000000-0000-4000-8000-000000000001',
      'capgo_test_key',
    )).resolves.toBe(false)
  })

  it('checkPermission treats Drizzle-wrapped invalid UUID cast as ACL deny', async () => {
    const drizzleWrapped = Object.assign(new Error('Failed query: SELECT ...'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('invalid input syntax for type uuid: "046a...-missing"'), {
        code: '22P02',
      }),
    })
    executeMock.mockRejectedValueOnce(drizzleWrapped)

    await expect(checkPermission(makeContext(), 'org.invite_user', { orgId: '046a36ac-e03c-4590-9257-bd6c9dba9ee8-missing' }))
      .resolves
      .toBe(false)
  })

  it('checkPermissionPg unwraps Drizzle cause for transient PG connection codes', async () => {
    const drizzleWrapped = Object.assign(new Error('Failed query: SELECT ...'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('terminating connection due to administrator command'), {
        code: '57P01',
      }),
    })
    executeMock.mockRejectedValueOnce(drizzleWrapped)

    await expect(checkPermissionPg(
      makeContext(),
      'app.upload_bundle',
      { appId: 'ai.offthetools.app' },
      getDrizzleClientMock() as any,
      '00000000-0000-4000-8000-000000000001',
      'capgo_test_key',
    )).rejects.toMatchObject({
      status: 503,
      cause: { error: 'upstream_unavailable' },
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
