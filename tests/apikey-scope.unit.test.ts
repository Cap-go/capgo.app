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
  checkPermissionsBatch: (c: unknown, checks: Array<{ permission: string, scope: unknown }>) =>
    Promise.all(checks.map(check => checkPermissionMock(c, check.permission, check.scope))),
  checkPermissionsBatchPg: (c: unknown, checks: Array<{ permission: string, scope: unknown }>, ...rest: unknown[]) =>
    Promise.all(checks.map(check => checkPermissionPgMock(c, check.permission, check.scope, ...rest))),
}))

const { assertApiKeyManagerCanAssignBindings, assertApiKeyManagerCanRotateTarget, MAX_API_KEY_BINDINGS, sanitizeClientBindings } = await import('../supabase/functions/_backend/public/apikey/scope.ts')

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

  it('allows a non-destructive app role without role management at the deny-list layer', async () => {
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

describe('api key bindings cap', () => {
  const binding = (index: number) => ({
    role_name: 'app_reader',
    scope_type: 'app',
    org_id: ORG_ID,
    app_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  })

  it('caps bindings at 100 per request', () => {
    expect(MAX_API_KEY_BINDINGS).toBe(100)
  })

  it('accepts exactly the maximum number of bindings', () => {
    const bindings = Array.from({ length: MAX_API_KEY_BINDINGS }, (_, index) => binding(index))
    expect(sanitizeClientBindings(bindings)).toHaveLength(MAX_API_KEY_BINDINGS)
  })

  it('rejects more than the maximum with a 400 too_many_bindings error', () => {
    const bindings = Array.from({ length: MAX_API_KEY_BINDINGS + 1 }, (_, index) => binding(index))
    expect(() => sanitizeClientBindings(bindings)).toThrow(expect.objectContaining({
      status: 400,
      cause: { error: 'too_many_bindings' },
    }))
  })

  it('checks the cap before validating individual bindings', () => {
    const bindings = Array.from({ length: MAX_API_KEY_BINDINGS + 1 }, () => ({ invalid: true }))
    expect(() => sanitizeClientBindings(bindings)).toThrow(expect.objectContaining({
      status: 400,
      cause: { error: 'too_many_bindings' },
    }))
  })
})

describe('api key manager assignment guard batches permission checks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('checks org.update_user_roles once per distinct org', async () => {
    checkPermissionMock.mockResolvedValue(true)
    const otherOrg = '00000000-0000-4000-8000-000000000999'

    await expect(assertApiKeyManagerCanAssignBindings(context, auth, [
      { role_name: 'app_preview', org_id: ORG_ID },
      { role_name: 'app_admin', org_id: ORG_ID },
      { role_name: 'app_preview', org_id: otherOrg },
    ])).resolves.toBeUndefined()

    expect(checkPermissionMock).toHaveBeenCalledTimes(2)
    expect(checkPermissionMock).toHaveBeenCalledWith(context, 'org.update_user_roles', { orgId: ORG_ID })
    expect(checkPermissionMock).toHaveBeenCalledWith(context, 'org.update_user_roles', { orgId: otherOrg })
  })

  it('still rejects a denied sensitive role in only one of several orgs', async () => {
    const otherOrg = '00000000-0000-4000-8000-000000000999'
    checkPermissionMock.mockImplementation(async (_c: unknown, _permission: string, scope: { orgId: string }) => scope.orgId === ORG_ID)

    await expect(assertApiKeyManagerCanAssignBindings(context, auth, [
      { role_name: 'app_preview', org_id: ORG_ID },
      { role_name: 'org_admin', org_id: otherOrg },
    ])).rejects.toMatchObject({
      status: 403,
      cause: { error: 'forbidden_binding' },
    })
  })
})
