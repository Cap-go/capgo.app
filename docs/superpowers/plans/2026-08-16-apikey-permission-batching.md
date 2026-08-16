# API-Key Creation Permission Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the exact `POST /apikey` authorization and locking behavior while replacing 40 sequential permission SQL statements for ten organizations with one batched statement before the transaction and one after locking.

**Architecture:** Add one PostgreSQL-backed TypeScript helper that evaluates `org.manage_apikeys` and `org.update_user_roles` for an array of organization IDs using `unnest()`. Keep the existing preflight and post-lock phases, their validation order, the RBAC function, and all writes unchanged; only their permission-query transport changes.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, node-postgres, PostgreSQL, Vitest

---

## Scope and File Map

Production changes are limited to:

- `supabase/functions/_backend/utils/rbac.ts`: execute and map one batched permission query while reusing existing transient-error classification.
- `supabase/functions/_backend/public/apikey/scope.ts`: expose the existing sensitive-role decision as a query-free per-organization assertion.
- `supabase/functions/_backend/public/apikey/post.ts`: call the batch helper before the transaction and again after `lockRbacOrgs`.

Test changes are limited to:

- `tests/rbac-permission-infra-errors.unit.test.ts`: batch mapping, one-statement behavior, and infrastructure-error behavior.
- `tests/apikey-scope.unit.test.ts`: query-free sensitive-role assertion behavior.
- `tests/apikey-post-permission-batching.unit.test.ts`: two-phase route wiring and lock ordering.

Do not add an RPC, migration, PostgreSQL function, pool-size change, `Promise.all`, new production file, lock optimization, or role-binding optimization. Do not touch `put.ts` behavior. At plan-writing time, `post.ts` already has an unrelated uncommitted import edit; inspect and preserve or explicitly reconcile that edit before modifying the same import block.

## Required Behavior to Preserve

The route must retain this exact order:

```text
validate expiration policy
load preflight snapshot once
check update_user_roles binding restrictions
check manage_apikeys for every org
begin transaction
lock all RBAC orgs
load locked snapshot once
check manage_apikeys for every org
check update_user_roles binding restrictions
create key and bindings
commit
```

The first phase prevents unauthorized callers from acquiring organization locks. The
second phase must use a fresh query through the transaction executor after the locks;
it must never reuse the preflight result.

### Task 1: Add the one-statement organization permission loader

**Files:**
- Modify: `tests/rbac-permission-infra-errors.unit.test.ts`
- Modify: `supabase/functions/_backend/utils/rbac.ts:24-45,156-193,393-478`

- [ ] **Step 1: Add failing tests for one-query mapping and failure semantics**

Extend the existing dynamic import:

```ts
const {
  checkApiKeyOrgPermissionsPg,
  checkPermission,
  checkPermissionPg,
} = await import('../supabase/functions/_backend/utils/rbac.ts')
```

Add these tests inside `describe('rbac permission infra errors', ...)`:

```ts
it('loads both API-key permissions for all orgs with one SQL statement', async () => {
  const orgOne = '00000000-0000-4000-8000-000000000101'
  const orgTwo = '00000000-0000-4000-8000-000000000102'
  executeMock.mockResolvedValueOnce({
    rows: [
      {
        org_id: orgOne,
        can_manage_apikeys: true,
        can_update_user_roles: false,
      },
      {
        org_id: orgTwo,
        can_manage_apikeys: false,
        can_update_user_roles: true,
      },
    ],
  })

  const result = await checkApiKeyOrgPermissionsPg(
    makeContext({
      userId: '00000000-0000-4000-8000-000000000001',
      authType: 'jwt',
      apikey: null,
    }),
    [orgOne, orgTwo],
    getDrizzleClientMock() as any,
    '00000000-0000-4000-8000-000000000001',
    null,
    'org.update_user_roles',
  )

  expect(executeMock).toHaveBeenCalledTimes(1)
  expect(result).toEqual(new Map([
    [orgOne, { canManageApiKeys: true, canUpdateUserRoles: false }],
    [orgTwo, { canManageApiKeys: false, canUpdateUserRoles: true }],
  ]))
})

it('treats a non-transient batch query failure as all permissions denied', async () => {
  executeMock.mockRejectedValueOnce(Object.assign(
    new Error('invalid input syntax for type uuid'),
    { code: '22P02' },
  ))

  await expect(checkApiKeyOrgPermissionsPg(
    makeContext({
      userId: '00000000-0000-4000-8000-000000000001',
      authType: 'jwt',
      apikey: null,
    }),
    ['not-a-uuid'],
    getDrizzleClientMock() as any,
    '00000000-0000-4000-8000-000000000001',
    null,
    'org.update_user_roles',
  )).resolves.toEqual(new Map())
})

it('surfaces transient batch permission failures as 503', async () => {
  executeMock.mockRejectedValueOnce(Object.assign(
    new Error('Connection terminated unexpectedly'),
    { code: 'ECONNRESET' },
  ))

  await expect(checkApiKeyOrgPermissionsPg(
    makeContext({
      userId: '00000000-0000-4000-8000-000000000001',
      authType: 'jwt',
      apikey: null,
    }),
    ['00000000-0000-4000-8000-000000000101'],
    getDrizzleClientMock() as any,
    '00000000-0000-4000-8000-000000000001',
    null,
    'org.update_user_roles',
  )).rejects.toMatchObject({
    status: 503,
    cause: { error: 'upstream_unavailable' },
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/rbac-permission-infra-errors.unit.test.ts
```

Expected: FAIL because `checkApiKeyOrgPermissionsPg` is not exported.

- [ ] **Step 3: Add the minimal batch result types and helper**

Add these types near the existing RBAC types in `rbac.ts`:

```ts
export interface ApiKeyOrgPermissions {
  canManageApiKeys: boolean
  canUpdateUserRoles: boolean
}

interface ApiKeyOrgPermissionRow {
  org_id: string
  can_manage_apikeys: boolean
  can_update_user_roles: boolean
}

type ApiKeyPermissionFailure = 'org.manage_apikeys' | 'org.update_user_roles'
```

Add this helper immediately after `checkPermissionPg` so it shares the same error
handling implementation:

```ts
export async function checkApiKeyOrgPermissionsPg(
  c: Context<MiddlewareKeyVariables>,
  orgIds: string[],
  drizzleClient: ReturnType<typeof getDrizzleClient>,
  userId: string,
  apikeyString: string | null,
  failurePermission: ApiKeyPermissionFailure,
): Promise<Map<string, ApiKeyOrgPermissions>> {
  if (!userId || orgIds.length === 0)
    return new Map()

  try {
    const result = await drizzleClient.execute<ApiKeyOrgPermissionRow>(sql`
      SELECT
        requested_orgs.org_id::text AS org_id,
        public.rbac_check_permission_direct(
          'org.manage_apikeys'::text,
          ${userId}::uuid,
          requested_orgs.org_id,
          NULL::varchar,
          NULL::bigint,
          ${apikeyString}::text
        ) AS can_manage_apikeys,
        public.rbac_check_permission_direct(
          'org.update_user_roles'::text,
          ${userId}::uuid,
          requested_orgs.org_id,
          NULL::varchar,
          NULL::bigint,
          ${apikeyString}::text
        ) AS can_update_user_roles
      FROM unnest(${orgIds}::uuid[]) WITH ORDINALITY AS requested_orgs(org_id, ordinal)
      ORDER BY requested_orgs.ordinal
    `)

    return new Map(result.rows.map(row => [
      row.org_id,
      {
        canManageApiKeys: row.can_manage_apikeys === true,
        canUpdateUserRoles: row.can_update_user_roles === true,
      },
    ] as const))
  }
  catch (error) {
    handlePermissionCheckError(
      c,
      failurePermission,
      { orgId: orgIds[0] },
      error,
      'checkPermissionPg',
    )
    return new Map()
  }
}
```

The `failurePermission` argument preserves which permission appears in transient-error
metadata for each phase: preflight passes `org.update_user_roles`, while the locked
phase passes `org.manage_apikeys`. Returning an empty map after a non-transient query
failure is deny-by-default; callers must interpret a missing entry as both permissions
being false.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bunx vitest run tests/rbac-permission-infra-errors.unit.test.ts
```

Expected: all tests in the file pass, including the existing `checkPermission` and
`checkPermissionPg` error cases.

- [ ] **Step 5: Commit the isolated RBAC helper**

```bash
git add supabase/functions/_backend/utils/rbac.ts tests/rbac-permission-infra-errors.unit.test.ts
git commit -m "perf(rbac): batch API key org permission checks"
```

### Task 2: Reuse the existing sensitive-role decision without another query

**Files:**
- Modify: `tests/apikey-scope.unit.test.ts`
- Modify: `supabase/functions/_backend/public/apikey/scope.ts:158-193`

- [ ] **Step 1: Add failing unit tests for the query-free per-org assertion**

Change the import to include the new assertion:

```ts
const {
  assertApiKeyManagerCanAssignBindings,
  assertApiKeyManagerCanAssignBindingsForOrg,
} = await import('../supabase/functions/_backend/public/apikey/scope.ts')
```

Add these tests:

```ts
it('rejects a sensitive role from a precomputed denied org decision', () => {
  expect(() => assertApiKeyManagerCanAssignBindingsForOrg([{
    role_name: 'app_preview',
    org_id: ORG_ID,
  }], ORG_ID, false)).toThrow('Forbidden - API key managers cannot assign the app_preview role')

  expect(checkPermissionMock).not.toHaveBeenCalled()
  expect(checkPermissionPgMock).not.toHaveBeenCalled()
})

it('allows a non-sensitive role from a precomputed denied org decision', () => {
  expect(() => assertApiKeyManagerCanAssignBindingsForOrg([{
    role_name: 'app_uploader',
    org_id: ORG_ID,
  }], ORG_ID, false)).not.toThrow()

  expect(checkPermissionMock).not.toHaveBeenCalled()
  expect(checkPermissionPgMock).not.toHaveBeenCalled()
})

it('ignores bindings belonging to another org', () => {
  expect(() => assertApiKeyManagerCanAssignBindingsForOrg([{
    role_name: 'org_super_admin',
    org_id: '00000000-0000-4000-8000-000000000999',
  }], ORG_ID, false)).not.toThrow()
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
bunx vitest run tests/apikey-scope.unit.test.ts
```

Expected: FAIL because `assertApiKeyManagerCanAssignBindingsForOrg` is not exported.

- [ ] **Step 3: Extract the existing per-org assertion without changing its rules**

Add this function below `APIKEY_MANAGER_DENIED_ASSIGNABLE_ROLES`:

```ts
export function assertApiKeyManagerCanAssignBindingsForOrg(
  bindings: Array<{ role_name: string, org_id: string }>,
  orgId: string,
  canUpdateUserRoles: boolean,
): void {
  if (canUpdateUserRoles)
    return

  for (const binding of bindings) {
    if (binding.org_id !== orgId)
      continue
    if (APIKEY_MANAGER_DENIED_ASSIGNABLE_ROLES.has(binding.role_name)) {
      throw quickError(403, 'forbidden_binding', `Forbidden - API key managers cannot assign the ${binding.role_name} role`)
    }
  }
}
```

Replace only the decision block inside the existing async helper:

```ts
for (const orgId of orgIds) {
  const canUpdateUserRoles = drizzle
    ? await checkPermissionPg(c, 'org.update_user_roles', { orgId }, drizzle, auth.userId, apikeyString)
    : await checkPermission(c, 'org.update_user_roles', { orgId })

  assertApiKeyManagerCanAssignBindingsForOrg(bindings, orgId, canUpdateUserRoles)
}
```

Do not change the denied role set, error status, error code, error message, organization
iteration order, or the existing async helper's public signature. This keeps `PUT
/apikey` behavior unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
bunx vitest run tests/apikey-scope.unit.test.ts
```

Expected: all existing and new scope tests pass.

- [ ] **Step 5: Commit the assertion extraction**

```bash
git add supabase/functions/_backend/public/apikey/scope.ts tests/apikey-scope.unit.test.ts
git commit -m "refactor(apikey): reuse binding permission decisions"
```

### Task 3: Wire the two permission snapshots into `POST /apikey`

**Files:**
- Create: `tests/apikey-post-permission-batching.unit.test.ts`
- Modify: `supabase/functions/_backend/public/apikey/post.ts:1-14,61-69,111-155`

- [ ] **Step 1: Confirm and preserve the overlapping worktree edit**

Run:

```bash
git diff -- supabase/functions/_backend/public/apikey/post.ts
```

Expected at plan-writing time: an uncommitted import-line edit involving
`validateExpirationAgainstOrgPolicies`. Do not discard it with checkout/reset. Ensure
the final import block still provides every symbol used by the endpoint before running
tests.

- [ ] **Step 2: Add the failing route-level regression test**

Create `tests/apikey-post-permission-batching.unit.test.ts` with the following focused
test harness:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  assertForOrg: vi.fn(),
  batchPermissions: vi.fn(),
  closeClient: vi.fn(),
  createBinding: vi.fn(),
  ensureManagement: vi.fn(),
  getDrizzleClient: vi.fn(),
  getPgClient: vi.fn(),
  lockOrgs: vi.fn(),
  parseGlobalPermissions: vi.fn(),
  replaceGlobalPermissions: vi.fn(),
  requireAuth: vi.fn(),
  sanitizeBindings: vi.fn(),
  transaction: vi.fn(),
  txExecute: vi.fn(),
}))

const USER_ID = '00000000-0000-4000-8000-000000000001'
const ORG_ONE = '00000000-0000-4000-8000-000000000101'
const ORG_TWO = '00000000-0000-4000-8000-000000000102'
const RBAC_ID = '00000000-0000-4000-8000-000000000201'

const tx = { execute: mocks.txExecute }
const drizzle = { transaction: mocks.transaction }

function allowedPermissions() {
  return new Map([
    [ORG_ONE, { canManageApiKeys: true, canUpdateUserRoles: true }],
    [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
  ])
}

function requestBody() {
  return {
    name: 'batched-permissions-test',
    bindings: [
      { role_name: 'org_admin', scope_type: 'org', org_id: ORG_ONE },
      { role_name: 'org_admin', scope_type: 'org', org_id: ORG_TWO },
    ],
  }
}

vi.mock('../supabase/functions/_backend/utils/hono_middleware.ts', () => ({
  middlewareAuth: () => async (c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', { authType: 'jwt', userId: USER_ID })
    await next()
  },
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/rbac.ts', () => ({
  checkApiKeyOrgPermissionsPg: mocks.batchPermissions,
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  closeClient: mocks.closeClient,
  getDrizzleClient: mocks.getDrizzleClient,
  getPgClient: mocks.getPgClient,
}))

vi.mock('../supabase/functions/_backend/private/role_bindings.ts', () => ({
  createRoleBindingForPrincipal: mocks.createBinding,
  lockRbacOrgs: mocks.lockOrgs,
}))

vi.mock('../supabase/functions/_backend/public/apikey/global_permissions.ts', () => ({
  parseApiKeyGlobalPermissions: mocks.parseGlobalPermissions,
  replaceApiKeyGlobalPermissions: mocks.replaceGlobalPermissions,
  validateApiKeyGlobalPermissionsForBindings: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/public/apikey/scope.ts', () => ({
  assertApiKeyManagerCanAssignBindingsForOrg: mocks.assertForOrg,
  ensureApiKeyManagementAllowed: mocks.ensureManagement,
  requireApiKeyManagementAuth: mocks.requireAuth,
  sanitizeClientBindings: mocks.sanitizeBindings,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseWithAuth: vi.fn(() => ({})),
  validateExpirationAgainstOrgPolicies: vi.fn(),
  validateExpirationDate: vi.fn(),
}))

describe('POST /apikey permission batching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAuth.mockReturnValue({ authType: 'jwt', userId: USER_ID })
    mocks.ensureManagement.mockResolvedValue(undefined)
    mocks.sanitizeBindings.mockImplementation((bindings: unknown[]) => bindings)
    mocks.parseGlobalPermissions.mockReturnValue([])
    mocks.getPgClient.mockReturnValue({ id: 'pool' })
    mocks.getDrizzleClient.mockReturnValue(drizzle)
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => await callback(tx))
    mocks.txExecute.mockResolvedValue({
      rows: [{ id: 501, rbac_id: RBAC_ID, key: null }],
    })
    mocks.batchPermissions.mockResolvedValue(allowedPermissions())
    mocks.lockOrgs.mockResolvedValue(undefined)
    mocks.createBinding.mockResolvedValue({ ok: true, data: {} })
    mocks.replaceGlobalPermissions.mockResolvedValue(undefined)
    mocks.closeClient.mockResolvedValue(undefined)
  })

  it('loads one preflight snapshot and one fresh post-lock snapshot', async () => {
    const { default: app } = await import('../supabase/functions/_backend/public/apikey/post.ts')
    const response = await app.request(new Request('http://local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody()),
    }))

    expect(response.status).toBe(200)
    expect(mocks.batchPermissions).toHaveBeenCalledTimes(2)
    expect(mocks.batchPermissions).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      [ORG_ONE, ORG_TWO],
      drizzle,
      USER_ID,
      null,
      'org.update_user_roles',
    )
    expect(mocks.batchPermissions).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      [ORG_ONE, ORG_TWO],
      tx,
      USER_ID,
      null,
      'org.manage_apikeys',
    )
    expect(mocks.batchPermissions.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.lockOrgs.mock.invocationCallOrder[0])
    expect(mocks.lockOrgs.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.batchPermissions.mock.invocationCallOrder[1])
  })

  it('rejects failed preflight management before taking locks', async () => {
    mocks.batchPermissions.mockResolvedValueOnce(new Map([
      [ORG_ONE, { canManageApiKeys: false, canUpdateUserRoles: true }],
      [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
    ]))

    const { default: app } = await import('../supabase/functions/_backend/public/apikey/post.ts')
    const response = await app.request(new Request('http://local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody()),
    }))

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain(
      `Forbidden - API key management rights required for org ${ORG_ONE}`,
    )
    expect(mocks.batchPermissions).toHaveBeenCalledTimes(1)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.lockOrgs).not.toHaveBeenCalled()
  })

  it('rechecks management after locking and before inserting', async () => {
    mocks.batchPermissions
      .mockResolvedValueOnce(allowedPermissions())
      .mockResolvedValueOnce(new Map([
        [ORG_ONE, { canManageApiKeys: false, canUpdateUserRoles: true }],
        [ORG_TWO, { canManageApiKeys: true, canUpdateUserRoles: true }],
      ]))

    const { default: app } = await import('../supabase/functions/_backend/public/apikey/post.ts')
    const response = await app.request(new Request('http://local/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody()),
    }))

    expect(response.status).toBe(403)
    expect(mocks.lockOrgs).toHaveBeenCalledWith(tx, [ORG_ONE, ORG_TWO])
    expect(mocks.batchPermissions).toHaveBeenCalledTimes(2)
    expect(mocks.txExecute).not.toHaveBeenCalled()
    expect(mocks.createBinding).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the route test and verify RED**

Run:

```bash
bunx vitest run tests/apikey-post-permission-batching.unit.test.ts
```

Expected: FAIL because `post.ts` still imports and invokes the individual permission
helpers.

- [ ] **Step 4: Replace only the permission-query loops in `post.ts`**

Replace the RBAC and scope imports with:

```ts
import type { ApiKeyOrgPermissions } from '../../utils/rbac.ts'
import { checkApiKeyOrgPermissionsPg } from '../../utils/rbac.ts'
import {
  assertApiKeyManagerCanAssignBindingsForOrg,
  ensureApiKeyManagementAllowed,
  requireApiKeyManagementAuth,
  sanitizeClientBindings,
} from './scope.ts'
```

Keep the existing Supabase helpers used by the file, including
`validateExpirationAgainstOrgPolicies`; do not carry an unused import into the final
diff.

Replace `assertCanManageApiKeysForOrgs` with these two query-free validators:

```ts
function assertCanManageApiKeysForOrgs(
  orgIds: string[],
  permissionsByOrg: ReadonlyMap<string, ApiKeyOrgPermissions>,
): void {
  for (const orgId of orgIds) {
    if (permissionsByOrg.get(orgId)?.canManageApiKeys !== true) {
      throw quickError(403, 'forbidden_binding', `Forbidden - API key management rights required for org ${orgId}`)
    }
  }
}

function assertCanAssignBindingsForOrgs(
  bindings: Array<{ role_name: string, org_id: string }>,
  orgIds: string[],
  permissionsByOrg: ReadonlyMap<string, ApiKeyOrgPermissions>,
): void {
  for (const orgId of orgIds) {
    assertApiKeyManagerCanAssignBindingsForOrg(
      bindings,
      orgId,
      permissionsByOrg.get(orgId)?.canUpdateUserRoles === true,
    )
  }
}
```

Remove the standalone preflight call to
`assertApiKeyManagerCanAssignBindings(c, auth, resolvedBindings)`. Inside the existing
`try`, create the request-scoped client before authorization and perform the preflight
checks in their current order:

```ts
pgClient = getPgClient(c)
const drizzle = getDrizzleClient(pgClient)
const createdBindings: unknown[] = []
const callerPrincipalId = auth.userId
const apikeyString = auth.apikey?.key ?? c.get('capgkey') ?? null

const preflightPermissions = await checkApiKeyOrgPermissionsPg(
  c,
  allOrgIds,
  drizzle,
  auth.userId,
  apikeyString,
  'org.update_user_roles',
)
assertCanAssignBindingsForOrgs(resolvedBindings, allOrgIds, preflightPermissions)
assertCanManageApiKeysForOrgs(allOrgIds, preflightPermissions)
```

Inside the transaction, leave `lockRbacOrgs` first. Replace the hand-written
`org.manage_apikeys` loop and transactional assignment helper call with:

```ts
await lockRbacOrgs(txDrizzle, allOrgIds)

const lockedPermissions = await checkApiKeyOrgPermissionsPg(
  c,
  allOrgIds,
  txDrizzle,
  auth.userId,
  apikeyString,
  'org.manage_apikeys',
)
assertCanManageApiKeysForOrgs(allOrgIds, lockedPermissions)
assertCanAssignBindingsForOrgs(resolvedBindings, allOrgIds, lockedPermissions)
```

Leave `createApiKeyRecord`, every `createRoleBindingForPrincipal` call,
`replaceApiKeyGlobalPermissions`, the transaction, catch block, finally block, logging,
and response body unchanged. Do not introduce `Promise.all`.

- [ ] **Step 5: Run the focused unit tests and verify GREEN**

Run:

```bash
bunx vitest run tests/rbac-permission-infra-errors.unit.test.ts tests/apikey-scope.unit.test.ts tests/apikey-post-permission-batching.unit.test.ts
```

Expected: all focused unit tests pass. The route test must report two batch-helper
calls on the authorized path and one on the preflight-denied path.

- [ ] **Step 6: Commit the endpoint wiring**

Stage only the files intentionally changed by this task after reviewing the overlapping
worktree diff:

```bash
git add supabase/functions/_backend/public/apikey/post.ts tests/apikey-post-permission-batching.unit.test.ts
git commit -m "perf(apikey): batch creation permission checks"
```

### Task 4: Verify behavior, query shape, and scope

**Files:**
- Modify only if verification exposes a defect: the production and test files listed in Tasks 1-3
- Record in PR notes: focused test results, query-plan summary, and permission statement count

- [ ] **Step 1: Run backend formatting/lint before broader tests**

Run:

```bash
bun run lint:backend
```

Expected: exit code 0 with no new lint errors.

- [ ] **Step 2: Run backend type checking**

Run:

```bash
bun run typecheck:backend
```

Expected: exit code 0. In particular, the Drizzle result row type, transaction executor,
and `ReadonlyMap` types compile without casts beyond the endpoint's existing
transaction cast.

- [ ] **Step 3: Run all unit tests**

Run:

```bash
bun run test:unit
```

Expected: all unit tests pass.

- [ ] **Step 4: Run focused backend integration tests**

Ensure local Supabase is running, then run:

```bash
bun run supabase:start
bun run supabase:with-env -- bunx vitest run tests/apikeys.test.ts tests/apikey-atomic-bindings.test.ts
```

Expected: both files pass. Successful creation, forbidden organization, sensitive-role
denial, and atomic rollback assertions remain unchanged.

- [ ] **Step 5: Inspect the local query plan for ten organization inputs**

Through the configured local Supabase SQL connection, run this read-only statement
with `EXPLAIN (ANALYZE, BUFFERS)`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  requested_orgs.org_id::text AS org_id,
  public.rbac_check_permission_direct(
    'org.manage_apikeys'::text,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    requested_orgs.org_id,
    NULL::varchar,
    NULL::bigint,
    NULL::text
  ) AS can_manage_apikeys,
  public.rbac_check_permission_direct(
    'org.update_user_roles'::text,
    '6aa76066-55ef-4238-ade6-0b32334a4097'::uuid,
    requested_orgs.org_id,
    NULL::varchar,
    NULL::bigint,
    NULL::text
  ) AS can_update_user_roles
FROM unnest(ARRAY[
  '046a36ac-e03c-4590-9257-bd6c9dba9ee8',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008',
  '00000000-0000-4000-8000-000000000009',
  '00000000-0000-4000-8000-000000000010'
]::uuid[]) WITH ORDINALITY AS requested_orgs(org_id, ordinal)
ORDER BY requested_orgs.ordinal;
```

Expected: one statement returns ten rows, with no unbounded sequential scan over a
large RBAC table. Record execution time and buffer summary in the PR notes. This is
verification only; do not create an RPC, view, function, migration, or permanent SQL
test fixture.

- [ ] **Step 6: Review the production diff for accidental scope expansion**

Run:

```bash
git diff origin/main...HEAD -- supabase/functions/_backend/utils/rbac.ts supabase/functions/_backend/public/apikey/scope.ts supabase/functions/_backend/public/apikey/post.ts
```

Expected production diff:

- one batch query helper;
- one extracted per-org assertion;
- two calls from `POST /apikey`;
- removal of only the four sequential permission loops/call paths from POST;
- no RPC, migration, schema, pool-size, lock, binding-write, or Worker configuration changes.

- [ ] **Step 7: Add verification evidence to the PR description and push**

Include the first five fixed bullets below. For the final bullet, copy the exact total
execution time, shared-buffer hit/read counts, and scan nodes reported by Step 5 rather
than estimating them:

```text
- POST /apikey keeps preflight authorization before RBAC locks.
- POST /apikey rechecks permissions through the transaction after locks.
- Ten orgs: 40 RBAC evaluations remain, permission SQL statements drop from 40 to 2.
- No RPC, migration, pool-size change, Promise.all, or write-path batching.
- Focused unit/integration tests: PASS.
- EXPLAIN (ANALYZE, BUFFERS) evidence recorded with the measured execution and buffer summary.
```

Then push the current branch:

```bash
git push
```

Expected: the existing pull request updates and CI starts on the new head.
