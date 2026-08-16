import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  assertApiKeyManagerCanAssignBindingsForOrgMock,
  checkApiKeyOrgPermissionsPgMock,
  closeClientMock,
  createRoleBindingForPrincipalMock,
  ensureApiKeyManagementAllowedMock,
  getDrizzleClientMock,
  getPgClientMock,
  lockRbacOrgsMock,
  parseApiKeyGlobalPermissionsMock,
  replaceApiKeyGlobalPermissionsMock,
  requireApiKeyManagementAuthMock,
  sanitizeClientBindingsMock,
} = vi.hoisted(() => ({
  assertApiKeyManagerCanAssignBindingsForOrgMock: vi.fn(),
  checkApiKeyOrgPermissionsPgMock: vi.fn(),
  closeClientMock: vi.fn(),
  createRoleBindingForPrincipalMock: vi.fn(),
  ensureApiKeyManagementAllowedMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  lockRbacOrgsMock: vi.fn(),
  parseApiKeyGlobalPermissionsMock: vi.fn(),
  replaceApiKeyGlobalPermissionsMock: vi.fn(),
  requireApiKeyManagementAuthMock: vi.fn(),
  sanitizeClientBindingsMock: vi.fn(),
}))

const ORG_ONE = '00000000-0000-4000-8000-000000000111'
const ORG_TWO = '00000000-0000-4000-8000-000000000222'
const USER_ID = '00000000-0000-4000-8000-000000000333'
const APIKEY_RBAC_ID = '00000000-0000-4000-8000-000000000444'

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (_c: unknown, next: () => Promise<void>) => await next(),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkApiKeyOrgPermissionsPg: checkApiKeyOrgPermissionsPgMock,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: closeClientMock,
  getDrizzleClient: getDrizzleClientMock,
  getPgClient: getPgClientMock,
}))

vi.mock('../supabase/functions/_backend/private/role_bindings.ts', () => ({
  createRoleBindingForPrincipal: createRoleBindingForPrincipalMock,
  lockRbacOrgs: lockRbacOrgsMock,
}))

vi.mock('../supabase/functions/_backend/public/apikey/global_permissions.ts', () => ({
  parseApiKeyGlobalPermissions: parseApiKeyGlobalPermissionsMock,
  replaceApiKeyGlobalPermissions: replaceApiKeyGlobalPermissionsMock,
  validateApiKeyGlobalPermissionsForBindings: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/public/apikey/scope.ts', () => ({
  assertApiKeyManagerCanAssignBindingsForOrg: assertApiKeyManagerCanAssignBindingsForOrgMock,
  ensureApiKeyManagementAllowed: ensureApiKeyManagementAllowedMock,
  requireApiKeyManagementAuth: requireApiKeyManagementAuthMock,
  sanitizeClientBindings: sanitizeClientBindingsMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  e: vi.fn(),
  supabaseWithAuth: vi.fn(() => ({})),
  validateExpirationAgainstOrgPolicies: vi.fn(),
  validateExpirationDate: vi.fn(),
}))

function allowedPermissions() {
  return new Map([
    [ORG_ONE, { canManageApiKeys: true, canUpdateUserRoles: true }],
    [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
  ])
}

async function createRequest(body: Record<string, unknown>) {
  const { default: app } = await import('../supabase/functions/_backend/public/apikey/post.ts')
  return await app.request(new Request('http://local/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('post /apikey permission batching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()

    requireApiKeyManagementAuthMock.mockReturnValue({ authType: 'jwt', userId: USER_ID })
    ensureApiKeyManagementAllowedMock.mockResolvedValue(undefined)
    sanitizeClientBindingsMock.mockImplementation((bindings: unknown[]) => bindings)
    parseApiKeyGlobalPermissionsMock.mockReturnValue([])
    getPgClientMock.mockReturnValue({ id: 'pg-client' })
    closeClientMock.mockResolvedValue(undefined)
    lockRbacOrgsMock.mockResolvedValue(undefined)
    createRoleBindingForPrincipalMock.mockResolvedValue({ ok: true, data: {} })
    replaceApiKeyGlobalPermissionsMock.mockResolvedValue(undefined)
  })

  it('uses preflight and post-lock permission batches for two unique binding organizations', async () => {
    const tx = {
      id: 'tx',
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 41, rbac_id: APIKEY_RBAC_ID }] }),
    }
    const drizzle = {
      id: 'drizzle',
      transaction: async (callback: (executor: unknown) => Promise<unknown>) => await callback(tx),
    }
    getDrizzleClientMock.mockReturnValue(drizzle)
    checkApiKeyOrgPermissionsPgMock.mockResolvedValue(allowedPermissions())

    const response = await createRequest({
      name: 'new key',
      bindings: [
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_ONE },
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_TWO },
      ],
    })

    expect(response.status).toBe(200)
    expect(checkApiKeyOrgPermissionsPgMock).toHaveBeenCalledTimes(2)
    expect(checkApiKeyOrgPermissionsPgMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      [ORG_ONE, ORG_TWO],
      drizzle,
      USER_ID,
      null,
      'org.update_user_roles',
    )
    expect(checkApiKeyOrgPermissionsPgMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      [ORG_ONE, ORG_TWO],
      tx,
      USER_ID,
      null,
      'org.manage_apikeys',
    )
    expect(checkApiKeyOrgPermissionsPgMock.mock.invocationCallOrder[0])
      .toBeLessThan(lockRbacOrgsMock.mock.invocationCallOrder[0])
    expect(lockRbacOrgsMock.mock.invocationCallOrder[0])
      .toBeLessThan(checkApiKeyOrgPermissionsPgMock.mock.invocationCallOrder[1])
  })

  it('rejects a preflight snapshot that lacks API-key management for the first organization', async () => {
    const drizzle = { id: 'drizzle', transaction: vi.fn() }
    getDrizzleClientMock.mockReturnValue(drizzle)
    checkApiKeyOrgPermissionsPgMock.mockResolvedValue(new Map([
      [ORG_ONE, { canManageApiKeys: false, canUpdateUserRoles: true }],
      [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
    ]))

    const response = await createRequest({
      name: 'new key',
      bindings: [
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_ONE },
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_TWO },
      ],
    })

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain(`Forbidden - API key management rights required for org ${ORG_ONE}`)
    expect(checkApiKeyOrgPermissionsPgMock).toHaveBeenCalledTimes(1)
    expect(drizzle.transaction).not.toHaveBeenCalled()
    expect(lockRbacOrgsMock).not.toHaveBeenCalled()
  })

  it('rejects a post-lock snapshot that loses API-key management without writing bindings or an API key', async () => {
    const tx = { id: 'tx', execute: vi.fn() }
    const drizzle = {
      id: 'drizzle',
      transaction: async (callback: (executor: unknown) => Promise<unknown>) => await callback(tx),
    }
    getDrizzleClientMock.mockReturnValue(drizzle)
    checkApiKeyOrgPermissionsPgMock
      .mockResolvedValueOnce(allowedPermissions())
      .mockResolvedValueOnce(new Map([
        [ORG_ONE, { canManageApiKeys: false, canUpdateUserRoles: true }],
        [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
      ]))

    const response = await createRequest({
      name: 'new key',
      bindings: [
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_ONE },
        { role_name: 'app_uploader', scope_type: 'org', org_id: ORG_TWO },
      ],
    })

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain(`Forbidden - API key management rights required for org ${ORG_ONE}`)
    expect(lockRbacOrgsMock).toHaveBeenCalledWith(tx, [ORG_ONE, ORG_TWO])
    expect(checkApiKeyOrgPermissionsPgMock).toHaveBeenCalledTimes(2)
    expect(tx.execute).not.toHaveBeenCalled()
    expect(createRoleBindingForPrincipalMock).not.toHaveBeenCalled()
  })
})
