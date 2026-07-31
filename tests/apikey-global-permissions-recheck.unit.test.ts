import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  assertApiKeyManagerCanAssignBindingsMock,
  assertCanKeepOrgCreateMock,
  checkPermissionMock,
  checkPermissionPgMock,
  closeClientMock,
  ensureApiKeyManagementAllowedMock,
  getApiKeyBindingOrgIdsMock,
  getDrizzleClientMock,
  getPgClientMock,
  lockRbacOrgsMock,
  parseApiKeyGlobalPermissionsMock,
  replaceApiKeyGlobalPermissionsMock,
  requireApiKeyManagementAuthMock,
  sanitizeClientBindingsMock,
  selectOwnedApiKeyByIdentifierMock,
} = vi.hoisted(() => ({
  assertApiKeyManagerCanAssignBindingsMock: vi.fn(),
  assertCanKeepOrgCreateMock: vi.fn(),
  checkPermissionMock: vi.fn(),
  checkPermissionPgMock: vi.fn(),
  closeClientMock: vi.fn(),
  ensureApiKeyManagementAllowedMock: vi.fn(),
  getApiKeyBindingOrgIdsMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  lockRbacOrgsMock: vi.fn(),
  parseApiKeyGlobalPermissionsMock: vi.fn(),
  replaceApiKeyGlobalPermissionsMock: vi.fn(),
  requireApiKeyManagementAuthMock: vi.fn(),
  sanitizeClientBindingsMock: vi.fn(),
  selectOwnedApiKeyByIdentifierMock: vi.fn(),
}))

const ORG_ID = '00000000-0000-4000-8000-000000000111'
const USER_ID = '00000000-0000-4000-8000-000000000222'
const APIKEY_RBAC_ID = '00000000-0000-4000-8000-000000000333'

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', {
      authType: 'jwt',
      userId: USER_ID,
    })
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkPermission: checkPermissionMock,
  checkPermissionPg: checkPermissionPgMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/private/role_bindings.ts', () => ({
  createRoleBindingForPrincipal: vi.fn(),
  lockRbacOrgs: lockRbacOrgsMock,
}))

vi.mock('../supabase/functions/_backend/public/apikey/global_permissions.ts', () => ({
  apiKeyBindingsAllowOrgCreate: vi.fn(),
  assertApiKeyCanKeepOrgCreate: assertCanKeepOrgCreateMock,
  parseApiKeyGlobalPermissions: parseApiKeyGlobalPermissionsMock,
  replaceApiKeyGlobalPermissions: replaceApiKeyGlobalPermissionsMock,
  validateApiKeyGlobalPermissionsForBindings: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/public/apikey/scope.ts', () => ({
  assertApiKeyManagerCanAssignBindings: assertApiKeyManagerCanAssignBindingsMock,
  ensureApiKeyCanManageTargetOrgIds: vi.fn(),
  ensureApiKeyManagementAllowed: ensureApiKeyManagementAllowedMock,
  getApiKeyBindingOrgIds: getApiKeyBindingOrgIdsMock,
  isValidApiKeyIdFormat: () => true,
  requireApiKeyManagementAuth: requireApiKeyManagementAuthMock,
  sanitizeClientBindings: sanitizeClientBindingsMock,
  selectOwnedApiKeyByIdentifier: selectOwnedApiKeyByIdentifierMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: vi.fn(() => ({})),
  supabaseWithAuth: vi.fn(() => ({})),
  validateExpirationAgainstOrgPolicies: vi.fn(),
  validateExpirationDate: vi.fn(),
}))

describe('api key update authorization recheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    requireApiKeyManagementAuthMock.mockReturnValue({ authType: 'jwt', userId: USER_ID })
    ensureApiKeyManagementAllowedMock.mockResolvedValue(undefined)
    getApiKeyBindingOrgIdsMock.mockResolvedValue([ORG_ID])
    selectOwnedApiKeyByIdentifierMock.mockResolvedValue({
      data: {
        id: 41,
        rbac_id: APIKEY_RBAC_ID,
        expires_at: null,
        key: null,
        key_hash: null,
      },
      error: null,
    })
    parseApiKeyGlobalPermissionsMock.mockReturnValue(['org.create'])
    assertApiKeyManagerCanAssignBindingsMock.mockResolvedValue(undefined)
    sanitizeClientBindingsMock.mockImplementation((bindings: unknown[]) => bindings)
    checkPermissionMock.mockResolvedValue(true)
    checkPermissionPgMock.mockResolvedValue(false)
    closeClientMock.mockResolvedValue(undefined)
    getPgClientMock.mockReturnValue({ id: 'pg-client' })
    getDrizzleClientMock.mockReturnValue({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => await callback({ id: 'tx' }),
    })
    lockRbacOrgsMock.mockResolvedValue(undefined)
  })

  it('rejects a global-permissions-only update when the locked permission recheck loses access', async () => {
    const { default: app } = await import('../supabase/functions/_backend/public/apikey/put.ts')

    const response = await app.request(new Request('http://local/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 41,
        global_permissions: ['org.create'],
      }),
    }))

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain('Forbidden - Admin rights required')
    expect(checkPermissionMock).toHaveBeenCalledWith(expect.anything(), 'org.update_user_roles', { orgId: ORG_ID })
    expect(lockRbacOrgsMock).toHaveBeenCalledWith(expect.anything(), [ORG_ID])
    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      expect.anything(),
      'org.update_user_roles',
      { orgId: ORG_ID },
      expect.anything(),
      USER_ID,
    )
    expect(assertCanKeepOrgCreateMock).not.toHaveBeenCalled()
    expect(replaceApiKeyGlobalPermissionsMock).not.toHaveBeenCalled()
  })

  it('runs the binding role guard before the update-role precheck', async () => {
    const { default: app } = await import('../supabase/functions/_backend/public/apikey/put.ts')
    const bindings = [{
      role_name: 'app_preview',
      scope_type: 'app',
      org_id: ORG_ID,
      app_id: '00000000-0000-4000-8000-000000000444',
    }]

    const response = await app.request(new Request('http://local/', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 41,
        bindings,
      }),
    }))

    expect(response.status).toBe(403)
    expect(assertApiKeyManagerCanAssignBindingsMock).toHaveBeenCalledWith(
      expect.anything(),
      { authType: 'jwt', userId: USER_ID },
      bindings,
    )
    expect(checkPermissionMock).toHaveBeenCalledWith(
      expect.anything(),
      'org.update_user_roles',
      { orgId: ORG_ID },
    )
    expect(assertApiKeyManagerCanAssignBindingsMock.mock.invocationCallOrder[0])
      .toBeLessThan(checkPermissionMock.mock.invocationCallOrder[0])
  })
})
