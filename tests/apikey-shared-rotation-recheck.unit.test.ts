import { PgDialect } from 'drizzle-orm/pg-core'
import { HTTPException } from 'hono/http-exception'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  ceiling: vi.fn(),
  lockOrgs: vi.fn(),
  execute: vi.fn(),
  update: vi.fn(),
  withActor: vi.fn(),
  stampRecipient: vi.fn(),
  replaceGlobalPermissions: vi.fn(),
}))

const ORG_ID = '00000000-0000-4000-8000-000000000111'
const USER_ID = '00000000-0000-4000-8000-000000000222'
const SUCCESSOR_ID = '00000000-0000-4000-8000-000000000444'
const RBAC_ID = '00000000-0000-4000-8000-000000000333'
const target = {
  id: 41,
  rbac_id: RBAC_ID,
  owner_org_id: ORG_ID,
  user_id: USER_ID,
  key: null,
  key_hash: 'hash',
  expires_at: null,
}
const auth = { authType: 'jwt', userId: USER_ID }

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', auth)
    await next()
  },
}))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: vi.fn(), cloudlogErr: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({ checkPermission: vi.fn(), checkPermissionPg: mocks.permission }))
vi.mock('../supabase/functions/_backend/private/role_bindings.ts', () => ({
  createRoleBindingForPrincipal: vi.fn(),
  lockRbacOrgs: mocks.lockOrgs,
}))
vi.mock('../supabase/functions/_backend/public/apikey/global_permissions.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../supabase/functions/_backend/public/apikey/global_permissions.ts')>(),
  assertApiKeyCanKeepOrgCreateGrant: mocks.replaceGlobalPermissions,
  replaceApiKeyGlobalPermissions: mocks.replaceGlobalPermissions,
}))
vi.mock('../supabase/functions/_backend/public/apikey/scope.ts', () => ({
  assertApiKeyManagerCanAssignBindings: vi.fn(),
  assertApiKeyManagerCanRotateTarget: vi.fn(),
  assertCallerHoldsSharedApiKeyPermissions: mocks.ceiling,
  ensureApiKeyCanManageTargetOrgIds: vi.fn(),
  ensureApiKeyManagementAllowed: vi.fn(),
  getApiKeyBindingOrgIds: vi.fn(async () => [ORG_ID]),
  isValidApiKeyIdFormat: () => true,
  requireApiKeyManagementAuth: () => auth,
  requireJwtMfaForPrivilegedAction: vi.fn(),
  sanitizeClientBindings: vi.fn(),
  selectManageableApiKeyByIdentifier: vi.fn(async () => ({ data: target, error: null })),
  setApiKeyAuditActor: vi.fn(),
  stampSharedApiKeySecretRecipient: mocks.stampRecipient,
  withApiKeyAuditActor: mocks.withActor,
}))
vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: vi.fn(() => ({})),
  supabaseWithAuth: vi.fn(() => ({})),
  validateExpirationAgainstOrgPolicies: vi.fn(),
  validateExpirationDate: vi.fn(),
}))

async function rotate(body: Record<string, unknown> = {}) {
  const { default: app } = await import('../supabase/functions/_backend/public/apikey/put.ts')
  return app.request('/', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 41, regenerate: true, ...body }),
  })
}

describe('shared API key rotation authorization transaction', () => {
  let events: string[]
  let rotated: boolean
  let transaction: { execute: typeof mocks.execute, update: typeof mocks.update }

  beforeEach(() => {
    vi.clearAllMocks()
    events = []
    rotated = false
    transaction = { execute: mocks.execute, update: mocks.update }
    mocks.update.mockImplementation(() => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            events.push('metadata-update')
            return [{ id: 41 }]
          },
        }),
      }),
    }))
    mocks.withActor.mockImplementation(async (_c, _auth, callback) => {
      events.push('transaction')
      return callback(transaction)
    })
    mocks.lockOrgs.mockImplementation(async () => {
      events.push('org-lock')
    })
    mocks.permission.mockImplementation(async () => {
      events.push('management-recheck')
      return true
    })
    mocks.ceiling.mockImplementation(async () => {
      events.push('ceiling-recheck')
    })
    mocks.stampRecipient.mockImplementation(async () => {
      events.push('stamp-recipient')
    })
    mocks.execute.mockImplementation(async (query) => {
      const { sql } = new PgDialect().sqlToQuery(query)
      if (sql.includes('lock_rbac_apikey_principal')) {
        events.push('principal-lock')
        return { rows: [] }
      }
      if (sql.includes('FOR UPDATE')) {
        events.push('row-lock')
        return { rows: [{ ...target, user_id: SUCCESSOR_ID }] }
      }
      if (sql.includes('regenerate_hashed_apikey_for_user')) {
        events.push('rotate')
        rotated = true
        return { rows: [{ ...target, key: 'new-secret' }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    })
  })

  it('locks and rechecks using the rotation transaction, including fresh attribution', async () => {
    const response = await rotate()
    expect(response.status).toBe(200)
    expect(events).toEqual(['transaction', 'org-lock', 'principal-lock', 'row-lock', 'management-recheck', 'ceiling-recheck', 'rotate', 'stamp-recipient'])
    expect(mocks.lockOrgs).toHaveBeenCalledWith(transaction, [ORG_ID])
    expect(mocks.permission).toHaveBeenCalledWith(expect.anything(), 'org.manage_apikeys', { orgId: ORG_ID }, transaction, USER_ID, null)
    expect(mocks.ceiling).toHaveBeenCalledWith(transaction, auth, RBAC_ID)
    expect(mocks.stampRecipient).toHaveBeenCalledWith(transaction, auth, RBAC_ID)
    const rotationQuery = new PgDialect().sqlToQuery(mocks.execute.mock.calls.at(-1)![0])
    expect(rotationQuery.params).toEqual([41, SUCCESSOR_ID])
  })

  it('does not issue a secret when management rights disappeared after the initial lookup', async () => {
    mocks.permission.mockResolvedValue(false)
    const response = await rotate()
    expect(response.status).toBe(403)
    expect(rotated).toBe(false)
    expect(mocks.ceiling).not.toHaveBeenCalled()
  })

  it('does not issue a secret when the locked key has permissions the caller lacks', async () => {
    mocks.ceiling.mockRejectedValue(new HTTPException(403, { cause: { error: 'forbidden_binding' } }))
    const response = await rotate()
    expect(response.status).toBe(403)
    expect(rotated).toBe(false)
    expect(events).toContain('principal-lock')
    expect(mocks.ceiling).toHaveBeenCalledWith(transaction, auth, RBAC_ID)
  })

  it('applies metadata only after the rotation rechecks pass', async () => {
    const response = await rotate({ expires_at: null, name: 'renamed' })
    expect(response.status).toBe(200)
    expect(events).toEqual(['transaction', 'org-lock', 'principal-lock', 'row-lock', 'management-recheck', 'ceiling-recheck', 'metadata-update', 'rotate', 'stamp-recipient'])
  })

  it('does not write metadata when a combined rotation fails the permission ceiling', async () => {
    mocks.ceiling.mockRejectedValue(new HTTPException(403, { cause: { error: 'forbidden_binding' } }))
    const response = await rotate({ expires_at: null })
    expect(response.status).toBe(403)
    expect(rotated).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(events).not.toContain('metadata-update')
  })

  it('does not write global permissions or metadata before a failed combined rotation', async () => {
    mocks.ceiling.mockRejectedValue(new HTTPException(403, { cause: { error: 'forbidden_binding' } }))
    const response = await rotate({ global_permissions: [], name: 'renamed' })
    expect(response.status).toBe(403)
    expect(rotated).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.replaceGlobalPermissions).not.toHaveBeenCalled()
    expect(events).toEqual(['transaction', 'org-lock', 'principal-lock', 'row-lock', 'management-recheck'])
  })

  it('returns the stamped shared secret recipient as the user the key acts as', async () => {
    const stampedExpiry = '2030-01-01T00:00:00.000Z'
    const baseExecute = mocks.execute.getMockImplementation()!
    // The rotation row still carries the previous attribution until the stamp.
    mocks.execute.mockImplementation(async (query) => {
      const result = await baseExecute(query)
      return result.rows[0]?.key === 'new-secret' ? { rows: [{ ...result.rows[0], user_id: SUCCESSOR_ID }] } : result
    })
    mocks.stampRecipient.mockResolvedValue({ user_id: USER_ID, shared_secret_user_id: USER_ID, shared_secret_expires_at: stampedExpiry })
    const response = await rotate()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ key: 'new-secret', user_id: USER_ID, shared_secret_user_id: USER_ID, shared_secret_expires_at: stampedExpiry })
  })

  it('does not issue a secret when the key was deleted after the initial lookup', async () => {
    mocks.execute.mockResolvedValue({ rows: [] })
    const response = await rotate()
    expect(response.status).toBe(404)
    expect(rotated).toBe(false)
    expect(mocks.permission).not.toHaveBeenCalled()
  })
})
