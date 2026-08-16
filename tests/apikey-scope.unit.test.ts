import { beforeEach, describe, expect, it, vi } from 'vitest'

const { checkPermissionMock, checkPermissionPgMock } = vi.hoisted(() => ({
  checkPermissionMock: vi.fn(),
  checkPermissionPgMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/hono.ts', () => ({
  quickError: (status: number, error: string, message: string): never => {
    const issue = new Error(message)
    Object.assign(issue, { status, cause: { error } })
    throw issue
  },
}))

const { getPgClientMock } = vi.hoisted(() => ({
  getPgClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
  checkPermissionPg: checkPermissionPgMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: vi.fn(),
  supabaseWithAuth: vi.fn(),
}))

const { assertApiKeyManagerCanAssignBindings, assertApiKeyManagerCanRotateTarget } = await import('../supabase/functions/_backend/public/apikey/scope.ts')

const ORG_ID = '00000000-0000-4000-8000-000000000111'
const auth = { authType: 'jwt', userId: '00000000-0000-4000-8000-000000000222' } as any
const context = { get: vi.fn() } as any

describe('api key manager role assignment guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an app_preview key from a JWT API-key manager without role management', async () => {
    checkPermissionMock.mockResolvedValue(false)

    await expect(assertApiKeyManagerCanAssignBindings(context, auth, [{
      role_name: 'app_preview',
      org_id: ORG_ID,
    }])).rejects.toMatchObject({
      status: 403,
      cause: { error: 'forbidden_binding' },
    })
  })

  it('allows a non-destructive app role without role management', async () => {
    checkPermissionMock.mockResolvedValue(false)

    await expect(assertApiKeyManagerCanAssignBindings(context, auth, [{
      role_name: 'app_uploader',
      org_id: ORG_ID,
    }])).resolves.toBeUndefined()
  })

  it('allows app_preview when the caller can manage user roles', async () => {
    checkPermissionMock.mockResolvedValue(true)

    await expect(assertApiKeyManagerCanAssignBindings(context, auth, [{
      role_name: 'app_preview',
      org_id: ORG_ID,
    }])).resolves.toBeUndefined()
  })
})

describe('api key manager rotate guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects rotating a target key that already has org_super_admin', async () => {
    checkPermissionMock.mockResolvedValue(false)
    getPgClientMock.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        rows: [{ role_name: 'org_super_admin', org_id: ORG_ID }],
      }),
    })

    await expect(assertApiKeyManagerCanRotateTarget(context, auth, '00000000-0000-4000-8000-000000000333')).rejects.toMatchObject({
      status: 403,
      cause: { error: 'forbidden_binding' },
    })
  })

  it('allows rotating a target key when the caller can manage user roles', async () => {
    checkPermissionMock.mockResolvedValue(true)
    getPgClientMock.mockReturnValue({
      query: vi.fn().mockResolvedValue({
        rows: [{ role_name: 'org_super_admin', org_id: ORG_ID }],
      }),
    })

    await expect(assertApiKeyManagerCanRotateTarget(context, auth, '00000000-0000-4000-8000-000000000333')).resolves.toBeUndefined()
  })
})
