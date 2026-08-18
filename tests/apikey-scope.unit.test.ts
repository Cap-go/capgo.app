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

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: vi.fn(),
  getPgClient: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
  checkPermissionPg: checkPermissionPgMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: vi.fn(),
  supabaseWithAuth: vi.fn(),
}))

const { assertApiKeyManagerCanAssignBindings } = await import('../supabase/functions/_backend/public/apikey/scope.ts')

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
