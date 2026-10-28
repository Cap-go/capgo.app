import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  assertApiKeyManagerCanAssignBindingsMock,
  assertCanKeepOrgCreateMock,
  assertExpirationMatchesOrgPoliciesMock,
  checkPermissionMock,
  checkPermissionPgMock,
  closeClientMock,
  createRoleBindingForPrincipalMock,
  ensureApiKeyManagementAllowedMock,
  getApiKeyBindingOrgIdsMock,
  getDrizzleClientMock,
  getPgClientMock,
  lockRbacOrgsMock,
  parseApiKeyGlobalPermissionsMock,
  replaceApiKeyGlobalPermissionsMock,
  requireApiKeyManagementAuthMock,
  requireJwtMfaForPrivilegedActionMock,
  sanitizeClientBindingsMock,
  selectOwnedApiKeyByIdentifierMock,
  supabaseWithAuthMock,
} = vi.hoisted(() => ({
  assertApiKeyManagerCanAssignBindingsMock: vi.fn(),
  assertCanKeepOrgCreateMock: vi.fn(),
  assertExpirationMatchesOrgPoliciesMock: vi.fn(),
  checkPermissionMock: vi.fn(),
  checkPermissionPgMock: vi.fn(),
  closeClientMock: vi.fn(),
  createRoleBindingForPrincipalMock: vi.fn(),
  ensureApiKeyManagementAllowedMock: vi.fn(),
  getApiKeyBindingOrgIdsMock: vi.fn(),
  getDrizzleClientMock: vi.fn(),
  getPgClientMock: vi.fn(),
  lockRbacOrgsMock: vi.fn(),
  parseApiKeyGlobalPermissionsMock: vi.fn(),
  replaceApiKeyGlobalPermissionsMock: vi.fn(),
  requireApiKeyManagementAuthMock: vi.fn(),
  requireJwtMfaForPrivilegedActionMock: vi.fn(),
  sanitizeClientBindingsMock: vi.fn(),
  selectOwnedApiKeyByIdentifierMock: vi.fn(),
  supabaseWithAuthMock: vi.fn(),
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
  createRoleBindingForPrincipal: createRoleBindingForPrincipalMock,
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
  apiKeyManagerPrincipal: vi.fn(() => ({ kind: 'service' })),
  assertApiKeyManagerCanAssignBindings: assertApiKeyManagerCanAssignBindingsMock,
  ensureApiKeyCanManageTargetOrgIds: vi.fn(),
  ensureApiKeyManagementAllowed: ensureApiKeyManagementAllowedMock,
  getApiKeyBindingOrgIds: getApiKeyBindingOrgIdsMock,
  isValidApiKeyIdFormat: () => true,
  requireApiKeyManagementAuth: requireApiKeyManagementAuthMock,
  requireJwtMfaForPrivilegedAction: requireJwtMfaForPrivilegedActionMock,
  sanitizeClientBindings: sanitizeClientBindingsMock,
  selectOwnedApiKeyByIdentifier: selectOwnedApiKeyByIdentifierMock,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  assertExpirationMatchesOrgPolicies: assertExpirationMatchesOrgPoliciesMock,
  supabaseAdmin: vi.fn(() => ({})),
  supabaseWithAuth: supabaseWithAuthMock,
  validateExpirationAgainstOrgPolicies: vi.fn(),
  validateExpirationDate: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.resetModules()

  requireApiKeyManagementAuthMock.mockReturnValue({ authType: 'jwt', userId: USER_ID })
  requireJwtMfaForPrivilegedActionMock.mockResolvedValue(undefined)
  ensureApiKeyManagementAllowedMock.mockResolvedValue(undefined)
  assertApiKeyManagerCanAssignBindingsMock.mockResolvedValue(undefined)
  sanitizeClientBindingsMock.mockImplementation((bindings: unknown[]) => bindings)
  checkPermissionMock.mockResolvedValue(true)
  closeClientMock.mockResolvedValue(undefined)
  getPgClientMock.mockReturnValue({ id: 'pg-client' })
  supabaseWithAuthMock.mockReturnValue({ id: 'supabase-auth' })
  lockRbacOrgsMock.mockResolvedValue(undefined)
})

describe('api key create postgres round trips', () => {
  // Before this change, POST /apikey opened extra Postgres pools via
  // checkPermission() and ran a PostgREST org-policy lookup before the
  // transaction, then repeated the same RBAC checks after lockRbacOrgs().
  // Measured on this mocked handler: checkPermission x1, assertApiKeyManagerCanAssignBindings x2,
  // validateExpirationAgainstOrgPolicies x1, createRoleBindingForPrincipal without skip flags.
  // After: one getPgClient, in-transaction RBAC only, assertExpirationMatchesOrgPolicies x1,
  // no PostgREST, skipOrgLock + skipPrincipalValidation.
  // The JWT MFA gate is mocked here; production POST /apikey also calls
  // requireJwtMfaForPrivilegedAction before this handler body.
  beforeEach(() => {
    parseApiKeyGlobalPermissionsMock.mockReturnValue([])
    checkPermissionPgMock.mockResolvedValue(true)
    assertExpirationMatchesOrgPoliciesMock.mockReturnValue(undefined)
    createRoleBindingForPrincipalMock.mockResolvedValue({ ok: true, data: { id: 'binding-1' } })
    replaceApiKeyGlobalPermissionsMock.mockResolvedValue(undefined)
    getDrizzleClientMock.mockReturnValue({
      transaction: async (callback: (tx: { execute: () => Promise<{ rows: unknown[] }> }) => Promise<unknown>) => await callback({
        execute: async () => ({
          rows: [{
            id: 99,
            rbac_id: APIKEY_RBAC_ID,
            user_id: USER_ID,
            name: 'fast-key',
            key: null,
            key_hash: null,
            expires_at: null,
            created_at: null,
            updated_at: null,
            require_apikey_expiration: false,
            max_apikey_expiration_days: null,
          }],
        }),
      }),
    })
  })

  it('creates an org-scoped key without extra postgres pools or pre-transaction RBAC lookups', async () => {
    const { default: app } = await import('../supabase/functions/_backend/public/apikey/post.ts')
    const bindings = [{
      role_name: 'org_admin',
      scope_type: 'org',
      org_id: ORG_ID,
    }]

    const response = await app.request(new Request('http://local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'fast-key',
        bindings,
      }),
    }))

    expect(response.status).toBe(200)
    expect(requireJwtMfaForPrivilegedActionMock).toHaveBeenCalledTimes(1)
    expect(getPgClientMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(supabaseWithAuthMock).not.toHaveBeenCalled()
    expect(assertExpirationMatchesOrgPoliciesMock).toHaveBeenCalledTimes(1)
    expect(assertExpirationMatchesOrgPoliciesMock).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({
        require_apikey_expiration: false,
        max_apikey_expiration_days: null,
      })]),
      null,
    )
    expect(assertApiKeyManagerCanAssignBindingsMock).toHaveBeenCalledTimes(1)
    expect(assertApiKeyManagerCanAssignBindingsMock).toHaveBeenCalledWith(
      expect.anything(),
      { authType: 'jwt', userId: USER_ID },
      bindings,
      expect.anything(),
    )
    expect(checkPermissionPgMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionPgMock).toHaveBeenCalledWith(
      expect.anything(),
      'org.manage_apikeys',
      { orgId: ORG_ID },
      expect.anything(),
      USER_ID,
      null,
    )
    expect(createRoleBindingForPrincipalMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        principal_type: 'apikey',
        principal_id: APIKEY_RBAC_ID,
        role_name: 'org_admin',
        org_id: ORG_ID,
      }),
      USER_ID,
      'jwt',
      USER_ID,
      expect.objectContaining({
        skipOrgLock: true,
        skipPrincipalValidation: true,
      }),
    )
    expect(replaceApiKeyGlobalPermissionsMock).not.toHaveBeenCalled()
  })
})

describe('api key update authorization recheck', () => {
  beforeEach(() => {
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
    checkPermissionPgMock.mockResolvedValue(false)
    getDrizzleClientMock.mockReturnValue({
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => await callback({ id: 'tx' }),
    })
  })

  it('rejects JWT updates when MFA assurance fails', async () => {
    requireJwtMfaForPrivilegedActionMock.mockRejectedValue(new HTTPException(403, {
      cause: { error: 'mfa_required' },
    }))

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
    expect(requireJwtMfaForPrivilegedActionMock).toHaveBeenCalledTimes(1)
    expect(checkPermissionMock).not.toHaveBeenCalled()
    expect(replaceApiKeyGlobalPermissionsMock).not.toHaveBeenCalled()
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
    expect(requireJwtMfaForPrivilegedActionMock).toHaveBeenCalledTimes(1)
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
    expect(requireJwtMfaForPrivilegedActionMock).toHaveBeenCalledTimes(1)
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
