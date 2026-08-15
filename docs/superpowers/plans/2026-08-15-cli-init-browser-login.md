# CLI Init Browser Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let interactive `npx @capgo/cli@latest init` obtain a dashboard-created API key through a masked copy/paste flow, without adding or changing any backend behavior.

**Architecture:** Add one frontend service that classifies organizations, computes the shared key policy, and reuses or creates an exact-scope `Capgo CLI` key through existing APIs. A focused `/login-cli` page owns secret display and existing Realtime subscriptions, while a small CLI helper owns nonce generation, browser launch, masked input, validation, persistence, and existing `/private/events` fan-out. Keep `init`, the auth guard, the global Realtime feed, and telemetry changes to narrow wiring edits.

**Tech Stack:** Vue 3 Composition API, Pinia, Supabase JS/Realtime, TypeScript, Bun, Vitest, `@clack/prompts`, and the existing Capgo API/event clients.

---

## Scope and size guardrails

- Do not create or modify anything under `supabase/`, including functions, migrations, schemas, tests, or generated types.
- Do not add device-flow polling, automatic browser-to-terminal secret transfer, invalid-key recovery, key cleanup, permission controls, or `/connect` component reuse.
- Support only `owner`, `org_super_admin`, and `org_admin` organization roles. Skip everything else and show one compact warning listing organization names.
- Use the existing `GET /apikey`, `POST /apikey`, direct RLS reads of `apikeys` and `role_bindings`, `get_orgs_v7`, and `POST /private/events` paths.
- Count product-code churn only in `src/`, `cli/src/`, and `messages/en.json`. Target 650–750 changed lines and stop before 800. Tests and files under `docs/superpowers/` do not count. If the implementation exceeds 800 product lines, remove optional error-detail parsing or decorative UI before adding abstractions.

### Planned product-code budget

| File | Responsibility | Estimated changed lines |
| --- | --- | ---: |
| `src/services/cliLogin.ts` | Eligibility, policy, exact reuse, creation dependencies, event/session helpers | 260–300 |
| `src/pages/login-cli.vue` | Page state, fake/revealed secret, copy, Realtime, success action | 220–260 |
| `cli/src/init/browser-login.ts` | Nonce, browser, masked prompt, save, event fan-out | 95–125 |
| Existing frontend/CLI files | Guard, permission union, init wiring, telemetry bypass, feed suppression | 25–40 |
| `messages/en.json` | Focused page copy | 18–24 |
| **Total** | | **618–749** |

## File map

**Create**

- `src/services/cliLogin.ts` — the only frontend domain/service module for the flow; contains pure helpers plus a thin dependency adapter over existing APIs.
- `src/pages/login-cli.vue` — naked-layout, zero-choice page; no extracted presentational components.
- `cli/src/init/browser-login.ts` — testable CLI-only browser login helper.
- `tests/cli-login-key.unit.test.ts` — pure frontend policy, naming, equality, reuse, and preparation tests.
- `tests/cli-login-page.unit.test.ts` — page security/state contract, session correlation, destination, and auth-guard tests.
- `cli/test/init/browser-login.test.ts` — CLI helper and entry-gate tests.
- `tests/realtime-cli-feed.unit.test.ts` — login-handshake suppression test.

**Modify**

- `src/services/permissions.ts` — add the existing `org.manage_apikeys` permission key to the frontend union.
- `src/modules/auth.ts` — allow `/login-cli` to bypass ordinary onboarding redirects while retaining normal authentication redirect behavior.
- `src/composables/useRealtimeCLIFeed.ts` — ignore `user-login` handshake broadcasts in the global toast feed.
- `messages/en.json` — add English strings used by the new page.
- `cli/src/init/command.ts` — invoke browser login only after supplied/env/global/local key resolution produced no key and the terminal is interactive.
- `cli/src/utils.ts` — allow `notifyConsole: true` workflow events through analytics opt-out.
- `cli/test/test-analytics.mjs` — prove console workflow delivery is not treated as analytics.

## Task 1: Build and test the frontend key-preparation service

**Files:**

- Create: `src/services/cliLogin.ts`
- Create: `tests/cli-login-key.unit.test.ts`
- Modify: `src/services/permissions.ts:15-42`

- [ ] **Step 1: Write failing tests for role eligibility, security gates, policy aggregation, strict names, exact bindings, and success destination**

Create `tests/cli-login-key.unit.test.ts` with table-driven tests using these public shapes:

```ts
import { describe, expect, it, vi } from 'vitest'
import {
  aggregateCliKeyPolicy,
  canonicalizeCliBindings,
  getCliLoginDestination,
  isMatchingCliLoginEvent,
  isValidCliLoginSession,
  nextManagedCliKeyName,
  prepareCliLoginKey,
  roleForCliKey,
} from '../src/services/cliLogin'

const now = new Date('2026-08-15T12:00:00.000Z')

const org = (overrides: Record<string, unknown> = {}) => ({
  gid: 'org-a',
  name: 'Alpha',
  role: 'org_admin',
  is_invite: false,
  enforcing_2fa: false,
  '2fa_has_access': true,
  password_policy_config: null,
  password_has_access: true,
  enforce_hashed_api_keys: false,
  require_apikey_expiration: false,
  max_apikey_expiration_days: null,
  ...overrides,
})

describe('CLI login key model', () => {
  it.each([
    ['owner', 'org_super_admin'],
    ['org_super_admin', 'org_super_admin'],
    ['org_admin', 'org_admin'],
    ['org_member', null],
    ['org_billing_admin', null],
    ['custom_role', null],
  ])('maps %s without guessing', (role, expected) => {
    expect(roleForCliKey(role)).toBe(expected)
  })

  it('combines hashing with the strictest expiration and clock margin', () => {
    expect(aggregateCliKeyPolicy([
      org({ enforce_hashed_api_keys: true, max_apikey_expiration_days: 30 }),
      org({ gid: 'org-b', require_apikey_expiration: true, max_apikey_expiration_days: 90 }),
    ], now)).toEqual({
      hashed: true,
      expiresAt: '2026-09-14T11:59:00.000Z',
    })
  })

  it('uses 365 days only when expiration is required and no positive max exists', () => {
    expect(aggregateCliKeyPolicy([
      org({ require_apikey_expiration: true, max_apikey_expiration_days: null }),
    ], now)).toEqual({
      hashed: false,
      expiresAt: '2027-08-15T11:59:00.000Z',
    })
  })

  it('parses only exact managed names and fills the first gap', () => {
    expect(nextManagedCliKeyName([
      'Capgo CLI',
      'Capgo CLI (3)',
      'Capgo CLI copy',
      'Capgo CLI (01)',
    ])).toBe('Capgo CLI (2)')
  })

  it('canonicalizes all scope fields so extra app or channel access is not equal', () => {
    const expected = canonicalizeCliBindings([
      { role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
    ])
    expect(canonicalizeCliBindings([
      { role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
      { role_name: 'app_admin', scope_type: 'app', org_id: 'org-a', app_id: 'app-a' },
    ])).not.toEqual(expected)
  })

  it('validates high-entropy sessions and matches only the exact login event', () => {
    const session = 'AbCdEfGhIjKlMnOpQrStUv'
    expect(isValidCliLoginSession(session)).toBe(true)
    expect(isValidCliLoginSession('short')).toBe(false)
    expect(isMatchingCliLoginEvent({
      event: 'User CLI login',
      channel: 'user-login',
      description: `cli-login:${session}`,
    }, session)).toBe(true)
    expect(isMatchingCliLoginEvent({
      event: 'User CLI login',
      channel: 'user-login',
      description: 'cli-login:different',
    }, session)).toBe(false)
  })

  it('offers onboarding only for one accepted org and one pending app', () => {
    expect(getCliLoginDestination(1, [
      { app_id: 'com.demo.app', need_onboarding: true },
    ])).toBe('/app/new?resume=com.demo.app')
    expect(getCliLoginDestination(2, [
      { app_id: 'com.demo.app', need_onboarding: true },
    ])).toBe('/dashboard')
    expect(getCliLoginDestination(1, [
      { app_id: 'com.demo.app', need_onboarding: false },
    ])).toBe('/dashboard')
  })
})
```

- [ ] **Step 2: Run the test and verify that the new module is missing**

Run:

```bash
bunx vitest run tests/cli-login-key.unit.test.ts
```

Expected: FAIL because `src/services/cliLogin.ts` does not exist.

- [ ] **Step 3: Add the existing API-key management permission to the frontend type**

In `src/services/permissions.ts`, add the real permission key beside the other organization permissions:

```ts
    | 'org.manage_apikeys'
    | 'org.update_user_roles'
```

Do not add an RPC, fallback permission, or backend constant.

- [ ] **Step 4: Implement the pure key model and dependency interface**

Create `src/services/cliLogin.ts` with these exported contracts and algorithms:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '~/types/supabase.types'
import { invokeCapgoApi } from '~/services/capgoApi'
import { checkPermissions } from '~/services/permissions'

export interface CliLoginOrganization {
  gid: string
  name: string
  role: string
  is_invite: boolean
  enforcing_2fa: boolean
  '2fa_has_access': boolean
  password_policy_config: { enabled?: boolean } | null
  password_has_access: boolean
  enforce_hashed_api_keys: boolean
  require_apikey_expiration: boolean
  max_apikey_expiration_days: number | null
}

export interface CliKeyBinding {
  role_name: string
  scope_type: string
  org_id: string | null
  app_id?: string | null
  channel_id?: string | null
  principal_id?: string | null
  expires_at?: string | null
}

export interface CliKeyPolicy {
  hashed: boolean
  expiresAt: string | null
}

export interface CliApiKeyMetadata {
  id: number
  name: string
  rbac_id: string | null
  created_at: string
  expires_at: string | null
  is_hashed_key: boolean
  global_permissions?: string[]
}

export interface CliOwnedKey {
  id: number
  name: string
  key: string | null
  rbac_id: string | null
  created_at: string
  expires_at: string | null
}

export interface CliLoginKeyDependencies {
  hasRequiredPermissions: (orgId: string) => Promise<boolean>
  listMetadata: () => Promise<CliApiKeyMetadata[]>
  listOwnedKeys: () => Promise<CliOwnedKey[]>
  listBindings: (principalIds: string[]) => Promise<CliKeyBinding[]>
  createKey: (input: {
    name: string
    hashed: boolean
    expires_at: string | null
    bindings: CliKeyBinding[]
    global_permissions: string[]
  }) => Promise<{ key: string | null }>
}

export type CliLoginKeyPreparation =
  | { status: 'empty', skippedOrganizationNames: string[] }
  | {
      status: 'ready'
      keyName: string
      secret: string
      eligibleOrgIds: string[]
      skippedOrganizationNames: string[]
      policy: CliKeyPolicy
      reused: boolean
    }

const CLI_KEY_NAME = /^Capgo CLI(?: \(([1-9]\d*)\))?$/
const DAY_MS = 86_400_000
const CLOCK_MARGIN_MS = 60_000

export function roleForCliKey(role: string | null | undefined): 'org_admin' | 'org_super_admin' | null {
  if (role === 'owner' || role === 'org_super_admin')
    return 'org_super_admin'
  return role === 'org_admin' ? 'org_admin' : null
}

function managedNameNumber(name: string): number | null {
  const match = CLI_KEY_NAME.exec(name)
  if (!match)
    return null
  if (!match[1])
    return 1
  const value = Number(match[1])
  return value >= 2 ? value : null
}

export function nextManagedCliKeyName(names: string[]): string {
  const used = new Set(names.map(managedNameNumber).filter((value): value is number => value !== null))
  for (let value = 1; ; value++) {
    if (!used.has(value))
      return value === 1 ? 'Capgo CLI' : `Capgo CLI (${value})`
  }
}

export function canonicalizeCliBindings(bindings: CliKeyBinding[]): string[] {
  return bindings.map(binding => [
    binding.role_name,
    binding.scope_type,
    binding.org_id ?? '',
    binding.app_id ?? '',
    binding.channel_id ?? '',
  ].join('|')).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

export function aggregateCliKeyPolicy(orgs: CliLoginOrganization[], now = new Date()): CliKeyPolicy {
  const requiresExpiration = orgs.some(org => org.require_apikey_expiration)
  if (!requiresExpiration) {
    return {
      hashed: orgs.some(org => org.enforce_hashed_api_keys),
      expiresAt: null,
    }
  }
  const limits = orgs
    .map(org => org.max_apikey_expiration_days)
    .filter((days): days is number => typeof days === 'number' && days > 0)
  const days = limits.length ? Math.min(...limits) : 365
  return {
    hashed: orgs.some(org => org.enforce_hashed_api_keys),
    expiresAt: new Date(now.getTime() + days * DAY_MS - CLOCK_MARGIN_MS).toISOString(),
  }
}

export function isValidCliLoginSession(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22,}$/.test(value)
}

export function isMatchingCliLoginEvent(
  payload: { event?: string, channel?: string, description?: string },
  session: string,
): boolean {
  return payload.event === 'User CLI login'
    && payload.channel === 'user-login'
    && payload.description === `cli-login:${session}`
}

export function getCliLoginDestination(
  organizationCount: number,
  apps: Array<{ app_id: string, need_onboarding: boolean }>,
): string {
  if (organizationCount !== 1 || apps.length !== 1 || !apps[0].need_onboarding)
    return '/dashboard'
  return `/app/new?resume=${encodeURIComponent(apps[0].app_id)}`
}
```

- [ ] **Step 5: Add failing orchestration tests for skip, reuse, and creation**

Append tests that use a dependency factory rather than mocking Supabase query builders:

```ts
function deps(overrides: Record<string, unknown> = {}) {
  return {
    hasRequiredPermissions: vi.fn(async () => true),
    listMetadata: vi.fn(async () => []),
    listOwnedKeys: vi.fn(async () => []),
    listBindings: vi.fn(async () => []),
    createKey: vi.fn(async () => ({ key: 'new-secret' })),
    ...overrides,
  }
}

describe('prepareCliLoginKey', () => {
  it('skips unsupported, invited, security-blocked, and permission-blocked orgs', async () => {
    const io = deps({
      hasRequiredPermissions: vi.fn(async (orgId: string) => orgId !== 'blocked'),
    })
    const result = await prepareCliLoginKey([
      org(),
      org({ gid: 'member', name: 'Member', role: 'org_member' }),
      org({ gid: 'invite', name: 'Invite', is_invite: true }),
      org({ gid: 'security', name: 'Security', enforcing_2fa: true, '2fa_has_access': false }),
      org({ gid: 'blocked', name: 'Blocked' }),
    ], io, now)

    expect(result.status).toBe('ready')
    expect(result.skippedOrganizationNames).toEqual(['Member', 'Invite', 'Security', 'Blocked'])
    expect(io.createKey).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Capgo CLI',
      global_permissions: [],
      bindings: [{ role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' }],
    }))
  })

  it('reuses the exact plaintext key and rejects any extra binding or global permission', async () => {
    const exact = {
      id: 1,
      name: 'Capgo CLI',
      rbac_id: 'rbac-1',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: null,
      is_hashed_key: false,
      global_permissions: [],
    }
    const io = deps({
      listMetadata: vi.fn(async () => [exact]),
      listOwnedKeys: vi.fn(async () => [{ ...exact, key: 'existing-secret' }]),
      listBindings: vi.fn(async () => [{
        principal_id: 'rbac-1',
        role_name: 'org_admin',
        scope_type: 'org',
        org_id: 'org-a',
      }]),
    })

    await expect(prepareCliLoginKey([org()], io, now)).resolves.toMatchObject({
      status: 'ready',
      secret: 'existing-secret',
      reused: true,
    })
    expect(io.createKey).not.toHaveBeenCalled()

    io.listMetadata.mockResolvedValue([{ ...exact, global_permissions: ['org.create'] }])
    await expect(prepareCliLoginKey([org()], io, now)).resolves.toMatchObject({
      status: 'ready',
      secret: 'new-secret',
      reused: false,
    })
  })

  it('reuses a key that expires exactly at the organization maximum', async () => {
    const exact = {
      id: 1,
      name: 'Capgo CLI',
      rbac_id: 'rbac-1',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-14T12:00:00Z',
      is_hashed_key: false,
      global_permissions: [],
    }
    const io = deps({
      listMetadata: vi.fn(async () => [exact]),
      listOwnedKeys: vi.fn(async () => [{ ...exact, key: 'existing-secret' }]),
      listBindings: vi.fn(async () => [{
        principal_id: 'rbac-1',
        role_name: 'org_admin',
        scope_type: 'org',
        org_id: 'org-a',
      }]),
    })

    await expect(prepareCliLoginKey([
      org({ require_apikey_expiration: true, max_apikey_expiration_days: 30 }),
    ], io, now)).resolves.toMatchObject({ reused: true, secret: 'existing-secret' })
  })

  it('reserves exact managed names even when a hashed key cannot be reused', async () => {
    const io = deps({
      listOwnedKeys: vi.fn(async () => [
        { id: 1, name: 'Capgo CLI', key: null, rbac_id: 'one', created_at: '', expires_at: null },
        { id: 2, name: 'Capgo CLI (2)', key: null, rbac_id: 'two', created_at: '', expires_at: null },
        { id: 3, name: 'Capgo CLI old', key: 'x', rbac_id: 'three', created_at: '', expires_at: null },
      ]),
    })
    await prepareCliLoginKey([org()], io, now)
    expect(io.createKey).toHaveBeenCalledWith(expect.objectContaining({ name: 'Capgo CLI (3)' }))
  })

  it('does not call key APIs when every organization is skipped', async () => {
    const io = deps()
    await expect(prepareCliLoginKey([
      org({ role: 'org_member' }),
    ], io, now)).resolves.toEqual({
      status: 'empty',
      skippedOrganizationNames: ['Alpha'],
    })
    expect(io.listMetadata).not.toHaveBeenCalled()
    expect(io.createKey).not.toHaveBeenCalled()
  })
})
```

Run:

```bash
bunx vitest run tests/cli-login-key.unit.test.ts
```

Expected: FAIL because `prepareCliLoginKey` is not implemented.

- [ ] **Step 6: Implement exact reuse/create orchestration and the existing-client adapter**

Add the following behavior in `src/services/cliLogin.ts`:

```ts
function orgPassesStaticChecks(org: CliLoginOrganization): boolean {
  if (org.is_invite || !roleForCliKey(org.role))
    return false
  if (org.enforcing_2fa && !org['2fa_has_access'])
    return false
  return !(org.password_policy_config?.enabled && !org.password_has_access)
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function candidatePolicyAllows(key: CliOwnedKey, metadata: CliApiKeyMetadata, policy: CliKeyPolicy, now: Date): boolean {
  if (!key.key || metadata.is_hashed_key || policy.hashed)
    return false
  const expiresAt = key.expires_at ? new Date(key.expires_at).getTime() : null
  if (expiresAt !== null && expiresAt <= now.getTime())
    return false
  if (!policy.expiresAt)
    return true
  return expiresAt !== null && expiresAt <= new Date(policy.expiresAt).getTime() + CLOCK_MARGIN_MS
}

export async function prepareCliLoginKey(
  organizations: CliLoginOrganization[],
  dependencies: CliLoginKeyDependencies,
  now = new Date(),
): Promise<CliLoginKeyPreparation> {
  const checks = await Promise.all(organizations.map(async (organization) => {
    if (!orgPassesStaticChecks(organization))
      return { organization, eligible: false }
    const eligible = await dependencies.hasRequiredPermissions(organization.gid).catch(() => false)
    return { organization, eligible }
  }))
  const eligible = checks.filter(check => check.eligible).map(check => check.organization)
  const skippedOrganizationNames = checks.filter(check => !check.eligible).map(check => check.organization.name)
  if (!eligible.length)
    return { status: 'empty', skippedOrganizationNames }

  const expectedBindings: CliKeyBinding[] = eligible.map(organization => ({
    role_name: roleForCliKey(organization.role)!,
    scope_type: 'org',
    org_id: organization.gid,
  }))
  const expectedCanonical = canonicalizeCliBindings(expectedBindings)
  const policy = aggregateCliKeyPolicy(eligible, now)
  const [metadata, ownedKeys] = await Promise.all([
    dependencies.listMetadata(),
    dependencies.listOwnedKeys(),
  ])
  const managedOwnedKeys = ownedKeys.filter(key => managedNameNumber(key.name) !== null)
  const metadataById = new Map(metadata.map(key => [key.id, key]))
  const principalIds = managedOwnedKeys.map(key => key.rbac_id).filter((id): id is string => !!id)
  const allBindings = await dependencies.listBindings(principalIds)

  const candidates = [...managedOwnedKeys].sort((left, right) => {
    const byName = managedNameNumber(left.name)! - managedNameNumber(right.name)!
    return byName || new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
  })
  for (const key of candidates) {
    const keyMetadata = metadataById.get(key.id)
    if (!keyMetadata || !Array.isArray(keyMetadata.global_permissions) || keyMetadata.global_permissions.length !== 0)
      continue
    const bindings = allBindings.filter(binding => binding.principal_id === key.rbac_id
      && (!binding.expires_at || new Date(binding.expires_at).getTime() > now.getTime()))
    if (!sameStringArray(canonicalizeCliBindings(bindings), expectedCanonical))
      continue
    if (!candidatePolicyAllows(key, keyMetadata, policy, now))
      continue
    return {
      status: 'ready',
      keyName: key.name,
      secret: key.key!,
      eligibleOrgIds: eligible.map(org => org.gid),
      skippedOrganizationNames,
      policy,
      reused: true,
    }
  }

  const keyName = nextManagedCliKeyName(ownedKeys.map(key => key.name))
  const created = await dependencies.createKey({
    name: keyName,
    hashed: policy.hashed,
    expires_at: policy.expiresAt,
    bindings: expectedBindings,
    global_permissions: [],
  })
  if (!created.key)
    throw new Error('CLI API key creation did not return a secret')
  return {
    status: 'ready',
    keyName,
    secret: created.key,
    eligibleOrgIds: eligible.map(org => org.gid),
    skippedOrganizationNames,
    policy,
    reused: false,
  }
}
```

Implement `createCliLoginKeyDependencies(supabase, userId)` in the same file. It must:

```ts
export function createCliLoginKeyDependencies(
  supabase: SupabaseClient<Database>,
  userId: string,
): CliLoginKeyDependencies {
  return {
    hasRequiredPermissions: orgId => checkPermissions([
      'org.manage_apikeys',
      'org.update_user_roles',
    ], { orgId }),
    listMetadata: async () => {
      const { data, error } = await invokeCapgoApi<CliApiKeyMetadata[]>('apikey', {
        client: supabase,
        method: 'GET',
      })
      if (error)
        throw error
      return data ?? []
    },
    listOwnedKeys: async () => {
      const { data, error } = await supabase
        .from('apikeys')
        .select('id, name, key, rbac_id, created_at, expires_at')
        .eq('user_id', userId)
      if (error)
        throw error
      return data ?? []
    },
    listBindings: async (principalIds) => {
      if (!principalIds.length)
        return []
      const { data, error } = await supabase
        .from('role_bindings')
        .select('principal_id, scope_type, org_id, app_id, channel_id, expires_at, roles(name)')
        .eq('principal_type', 'apikey')
        .in('principal_id', principalIds)
      if (error)
        throw error
      return (data ?? []).map((row) => {
        const role = Array.isArray(row.roles) ? row.roles[0] : row.roles
        return {
          principal_id: row.principal_id,
          role_name: role?.name ?? '',
          scope_type: row.scope_type,
          org_id: row.org_id,
          app_id: row.app_id,
          channel_id: row.channel_id,
          expires_at: row.expires_at,
        }
      })
    },
    createKey: async (input) => {
      const { data, error } = await invokeCapgoApi<{ key?: string | null }>('apikey', {
        client: supabase,
        method: 'POST',
        body: input,
      })
      if (error)
        throw error
      return { key: data?.key ?? null }
    },
  }
}
```

- [ ] **Step 7: Run the focused test and frontend typecheck**

Run:

```bash
bunx vitest run tests/cli-login-key.unit.test.ts
bun typecheck
```

Expected: both PASS. If generated relation typing represents `roles` differently, make the adapter normalize both object and array shapes; do not weaken the exact comparison.

- [ ] **Step 8: Commit the frontend domain service**

```bash
git add src/services/cliLogin.ts src/services/permissions.ts tests/cli-login-key.unit.test.ts
git commit -m "feat(frontend): prepare CLI login keys"
```

## Task 2: Add the zero-choice `/login-cli` page and preserve its route through auth

**Files:**

- Create: `src/pages/login-cli.vue`
- Create: `tests/cli-login-page.unit.test.ts`
- Modify: `src/modules/auth.ts:200-275`
- Modify: `messages/en.json`

- [ ] **Step 1: Write failing page contract tests**

Create `tests/cli-login-page.unit.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const page = readFileSync(new URL('../src/pages/login-cli.vue', import.meta.url), 'utf8')
const auth = readFileSync(new URL('../src/modules/auth.ts', import.meta.url), 'utf8')
const messages = JSON.parse(readFileSync(new URL('../messages/en.json', import.meta.url), 'utf8'))

describe('/login-cli page contract', () => {
  it.concurrent('uses the naked layout and does not reuse connect controls', () => {
    expect(page).toContain('layout: naked')
    expect(page).not.toContain('ConnectAppPicker')
    expect(page).not.toContain('tokenName')
    expect(page).not.toContain('selectedOrgIds')
  })

  it.concurrent('keeps a fake key in the DOM until explicit reveal', () => {
    expect(page).toContain("const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'")
    expect(page).toContain('revealed.value && secret.value ? secret.value : hiddenKey')
    expect(page).toContain('await navigator.clipboard.writeText(secret.value)')
    expect(page).toContain('secret.value = null')
  })

  it.concurrent('does not prepare a key without a valid session', () => {
    expect(page).toContain('if (!isValidCliLoginSession(route.query.session))')
    expect(page.indexOf('if (!isValidCliLoginSession(route.query.session))'))
      .toBeLessThan(page.indexOf('prepareCliLoginKey('))
  })

  it.concurrent('keeps the route out of normal onboarding redirects', () => {
    expect(auth).toContain("const isCliLoginRoute = to.path === '/login-cli'")
    expect(auth).toContain('if (isCliLoginRoute)')
  })

  it.concurrent('contains only focused key, paste, warning, waiting, and success copy', () => {
    expect(messages['cli-login-paste-instruction']).toContain('terminal')
    expect(messages['cli-login-security-warning']).toContain('trust')
    expect(messages['cli-login-copy-note']).toContain('hidden')
    expect(messages['cli-login-waiting']).toContain('Waiting')
    expect(messages['cli-login-success-title']).toContain('successful')
  })
})
```

- [ ] **Step 2: Run the page test and verify that the page is missing**

Run:

```bash
bunx vitest run tests/cli-login-page.unit.test.ts
```

Expected: FAIL because `src/pages/login-cli.vue` does not exist.

- [ ] **Step 3: Exempt only `/login-cli` from onboarding redirects**

Inside `guard()` in `src/modules/auth.ts`, define:

```ts
const isCliLoginRoute = to.path === '/login-cli'
```

Then return `false` or `null` early from these three nested onboarding helpers when `isCliLoginRoute` is true:

```ts
function shouldRedirectToOrgOnboarding() {
  if (isCliLoginRoute)
    return false
}

function shouldRedirectToPendingInviteOnboarding(organizationsLoaded: boolean) {
  if (isCliLoginRoute)
    return false
}

async function getPendingOnboardingRedirect(organizationsLoaded: boolean) {
  if (isCliLoginRoute)
    return null
}
```

Insert each guard before the first current condition in that function and leave all following conditions byte-for-byte unchanged.

Do not exempt the route from authentication. The existing unauthenticated redirect uses `to.fullPath`, so `/login-cli?session=...` remains in the `to` query and returns intact after login.

- [ ] **Step 4: Add the focused English copy**

Add these keys to `messages/en.json`, preserving alphabetical order:

```json
"cli-login-copy-note": "Copying keeps the key hidden on this page.",
"cli-login-copied": "API key copied.",
"cli-login-continue-setup": "Continue the setup",
"cli-login-direct-description": "Run npx @capgo/cli@latest init in your terminal to start a CLI login session.",
"cli-login-direct-title": "Start from the Capgo CLI",
"cli-login-error": "We could not prepare your CLI key. Try again or open the dashboard.",
"cli-login-expiration-warning": "Your organization policy requires this key to expire on {date}.",
"cli-login-hashed-warning": "Your organization policy requires this key to be stored as a hashed key.",
"cli-login-hide-key": "Hide API key",
"cli-login-no-eligible": "No organization can be added safely. Unsupported or restricted organizations were skipped.",
"cli-login-paste-instruction": "Paste this API key into the masked prompt in your terminal.",
"cli-login-preparing": "Preparing your CLI key…",
"cli-login-realtime-unavailable": "Automatic confirmation is unavailable. You can still paste the key into your terminal.",
"cli-login-reused": "An existing Capgo CLI key was reused.",
"cli-login-reveal-key": "Reveal API key",
"cli-login-security-warning": "Only paste this key into terminals and tools you trust.",
"cli-login-skipped-organizations": "Skipped organizations: {organizations}",
"cli-login-success-title": "CLI login successful",
"cli-login-title": "Connect the Capgo CLI",
"cli-login-waiting": "Waiting for the CLI to confirm login…"
```

Use existing translation keys for `copy`, `copy-fail`, `dashboard`, and `retry`. Buttons use literal route actions only through translated labels.

- [ ] **Step 5: Implement the page script and state machine**

Create `src/pages/login-cli.vue`. Keep the script around 140 lines and use this state model:

```vue
<script setup lang="ts">
import type { RealtimeChannel } from '@supabase/supabase-js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import IconCheckCircle from '~icons/heroicons/check-circle'
import IconClipboard from '~icons/heroicons/clipboard-document'
import IconKey from '~icons/heroicons/key'
import { formatLocalDate } from '~/services/date'
import {
  createCliLoginKeyDependencies,
  getCliLoginDestination,
  isMatchingCliLoginEvent,
  isValidCliLoginSession,
  prepareCliLoginKey,
} from '~/services/cliLogin'
import { useSupabase } from '~/services/supabase'
import { useMainStore } from '~/stores/main'
import { isPendingOrganizationInvite, useOrganizationStore } from '~/stores/organization'

type PageState = 'direct' | 'preparing' | 'empty' | 'ready' | 'success' | 'error'

const hiddenKey = 'capgo_xxxxxxxxxxxxxxxxxxxx'
const { t } = useI18n()
const route = useRoute('/login-cli')
const router = useRouter()
const supabase = useSupabase()
const main = useMainStore()
const organizationStore = useOrganizationStore()
const state = ref<PageState>('preparing')
const secret = ref<string | null>(null)
const revealed = ref(false)
const reused = ref(false)
const hashed = ref(false)
const expiresAt = ref<string | null>(null)
const skippedNames = ref<string[]>([])
const realtimeUnavailable = ref(false)
const destination = ref('/dashboard')
const channels: RealtimeChannel[] = []
const displayedKey = computed(() => revealed.value && secret.value ? secret.value : hiddenKey)

function clearSecret(): void {
  revealed.value = false
  secret.value = null
}

function clearChannels(): void {
  for (const channel of channels.splice(0))
    void supabase.removeChannel(channel)
}

async function resolveDestination(): Promise<string> {
  const accepted = organizationStore.organizations.filter(org => !isPendingOrganizationInvite(org))
  if (accepted.length !== 1 || accepted[0].app_count !== 1)
    return '/dashboard'
  const { data, error } = await supabase
    .from('apps')
    .select('app_id, need_onboarding')
    .eq('owner_org', accepted[0].gid)
    .limit(2)
  return error ? '/dashboard' : getCliLoginDestination(accepted.length, data ?? [])
}

async function complete(): Promise<void> {
  if (state.value === 'success')
    return
  destination.value = await resolveDestination()
  state.value = 'success'
  clearSecret()
}

function subscribe(orgIds: string[], session: string): Promise<boolean[]> {
  return Promise.all(orgIds.map(orgId => new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (connected: boolean) => {
      if (!settled) {
        settled = true
        resolve(connected)
      }
    }
    const channel = supabase.channel(`cli-events:org:${orgId}`)
      .on('broadcast', { event: 'cli-activity' }, (message) => {
        if (isMatchingCliLoginEvent(message.payload, session))
          void complete()
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED')
          finish(true)
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')
          finish(false)
      })
    channels.push(channel)
  })))
}

async function prepare(): Promise<void> {
  clearChannels()
  clearSecret()
  state.value = 'preparing'
  realtimeUnavailable.value = false
  const session = route.query.session
  if (!isValidCliLoginSession(session)) {
    state.value = 'direct'
    return
  }
  try {
    await organizationStore.awaitInitialLoad()
    const userId = main.user?.id ?? main.auth?.id
    if (!userId)
      throw new Error('Missing authenticated user')
    const result = await prepareCliLoginKey(
      organizationStore.organizations,
      createCliLoginKeyDependencies(supabase, userId),
    )
    skippedNames.value = result.skippedOrganizationNames
    if (result.status === 'empty') {
      state.value = 'empty'
      return
    }
    secret.value = result.secret
    reused.value = result.reused
    hashed.value = result.policy.hashed
    expiresAt.value = result.policy.expiresAt
    const connections = await subscribe(result.eligibleOrgIds, session)
    realtimeUnavailable.value = !connections.some(Boolean)
    if (state.value !== 'success')
      state.value = 'ready'
  }
  catch (error) {
    console.error('Cannot prepare CLI login key', error)
    state.value = 'error'
  }
}

async function copyKey(): Promise<void> {
  if (!secret.value)
    return
  try {
    await navigator.clipboard.writeText(secret.value)
    toast.success(t('cli-login-copied'))
  }
  catch {
    toast.error(t('copy-fail'))
  }
}

function goToDestination(): void {
  void router.push(destination.value)
}

onMounted(prepare)
onBeforeUnmount(() => {
  clearSecret()
  clearChannels()
})
</script>
```

- [ ] **Step 6: Implement the focused template without additional controls**

Use one centered card on the naked layout. The ready state must render exactly one key row, paste instructions, warnings, and waiting state:

```vue
<template>
  <main class="flex min-h-full items-center justify-center bg-slate-100 px-4 py-10 dark:bg-slate-900">
    <section class="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 sm:p-8">
      <div class="mb-6 flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-100 text-primary dark:bg-orange-950/40">
          <IconKey class="h-5 w-5" />
        </span>
        <h1 class="text-2xl font-semibold text-slate-950 dark:text-white">
          {{ t('cli-login-title') }}
        </h1>
      </div>

      <div v-if="state === 'preparing'" role="status" class="text-slate-600 dark:text-slate-300">
        {{ t('cli-login-preparing') }}
      </div>

      <div v-else-if="state === 'direct'" class="space-y-4">
        <h2 class="text-lg font-semibold">{{ t('cli-login-direct-title') }}</h2>
        <p>{{ t('cli-login-direct-description') }}</p>
        <button class="d-btn" type="button" @click="router.push('/dashboard')">{{ t('dashboard') }}</button>
      </div>

      <div v-else-if="state === 'empty'" class="space-y-4">
        <p class="d-alert d-alert-warning">{{ t('cli-login-no-eligible') }}</p>
        <p v-if="skippedNames.length" class="text-sm">{{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}</p>
        <button class="d-btn" type="button" @click="router.push('/dashboard')">{{ t('dashboard') }}</button>
      </div>

      <div v-else-if="state === 'ready'" class="space-y-5">
        <p class="text-slate-600 dark:text-slate-300">{{ t('cli-login-paste-instruction') }}</p>
        <div class="flex items-center gap-2 rounded-2xl border border-slate-200 p-3 dark:border-slate-700">
          <code :class="revealed ? '' : 'select-none blur-[5px]'" class="min-w-0 flex-1 truncate">{{ displayedKey }}</code>
          <button class="d-btn d-btn-ghost d-btn-sm" type="button" @click="revealed = !revealed">
            {{ t(revealed ? 'cli-login-hide-key' : 'cli-login-reveal-key') }}
          </button>
          <button class="d-btn d-btn-primary d-btn-sm" type="button" @click="copyKey">
            <IconClipboard class="h-4 w-4" /> {{ t('copy') }}
          </button>
        </div>
        <p class="text-xs text-slate-500">{{ t('cli-login-copy-note') }}</p>
        <p class="d-alert d-alert-warning text-sm">{{ t('cli-login-security-warning') }}</p>
        <p v-if="reused" class="text-sm">{{ t('cli-login-reused') }}</p>
        <p v-if="hashed" class="text-sm text-amber-700 dark:text-amber-300">{{ t('cli-login-hashed-warning') }}</p>
        <p v-if="expiresAt" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-expiration-warning', { date: formatLocalDate(expiresAt) }) }}
        </p>
        <p v-if="skippedNames.length" class="text-sm text-amber-700 dark:text-amber-300">
          {{ t('cli-login-skipped-organizations', { organizations: skippedNames.join(', ') }) }}
        </p>
        <p :class="realtimeUnavailable ? 'text-amber-700' : 'text-slate-500'" role="status" class="text-sm">
          {{ t(realtimeUnavailable ? 'cli-login-realtime-unavailable' : 'cli-login-waiting') }}
        </p>
      </div>

      <div v-else-if="state === 'success'" class="space-y-5 text-center">
        <IconCheckCircle class="mx-auto h-12 w-12 text-emerald-500" />
        <h2 class="text-xl font-semibold">{{ t('cli-login-success-title') }}</h2>
        <button class="d-btn d-btn-primary" type="button" @click="goToDestination">
          {{ t(destination.startsWith('/app/new') ? 'cli-login-continue-setup' : 'dashboard') }}
        </button>
      </div>

      <div v-else class="space-y-4">
        <p class="d-alert d-alert-error">{{ t('cli-login-error') }}</p>
        <div class="flex gap-2">
          <button class="d-btn d-btn-primary" type="button" @click="prepare">{{ t('retry') }}</button>
          <button class="d-btn" type="button" @click="router.push('/dashboard')">{{ t('dashboard') }}</button>
        </div>
      </div>
    </section>
  </main>
</template>

<route lang="yaml">
meta:
  layout: naked
</route>
```

The blurred text is always `hiddenKey`; the real secret is selected only when `revealed` is true. Do not render a second hidden element containing `secret`.

- [ ] **Step 7: Run page tests, lint, and typecheck**

Run:

```bash
bunx vitest run tests/cli-login-page.unit.test.ts tests/cli-login-key.unit.test.ts
bun lint
bun typecheck
```

Expected: all PASS. Lint must not introduce inline translation fallbacks.

- [ ] **Step 8: Commit the page**

```bash
git add src/pages/login-cli.vue src/modules/auth.ts messages/en.json tests/cli-login-page.unit.test.ts
git commit -m "feat(frontend): add CLI login page"
```

## Task 3: Build the CLI browser-login helper with masked input and correlated notifications

**Files:**

- Create: `cli/src/init/browser-login.ts`
- Create: `cli/test/init/browser-login.test.ts`

- [ ] **Step 1: Write failing CLI helper tests using injected dependencies**

Create `cli/test/init/browser-login.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it, mock } from 'bun:test'
import { loginInitInBrowser, shouldStartInitBrowserLogin } from '../../src/init/browser-login'

const helperSource = readFileSync(new URL('../../src/init/browser-login.ts', import.meta.url), 'utf8')

describe('init browser login', () => {
  it('starts only for an interactive init with no resolved key', () => {
    expect(shouldStartInitBrowserLogin('', true)).toBe(true)
    expect(shouldStartInitBrowserLogin('argument-or-saved-key', true)).toBe(false)
    expect(shouldStartInitBrowserLogin('', false)).toBe(false)
  })

  it('uses a password prompt with star masking', () => {
    expect(helperSource).toContain("mask: '*'")
    expect(helperSource).not.toContain('text({')
  })

  it('opens the correlated URL, saves the masked input, and notifies every org', async () => {
    const output: string[] = []
    const openUrl = mock(async () => undefined)
    const validateKey = mock(async () => ({ userId: 'user-1' }))
    const sendEvent = mock(async () => undefined)
    const key = await loginInitInBrowser({ local: false }, {
      createSession: () => 'AbCdEfGhIjKlMnOpQrStUv',
      openUrl,
      promptForKey: async () => 'super-secret-key',
      validateKey,
      listOrganizationIds: async () => ['org-a', 'org-b'],
      sendEvent,
      writeUrl: message => output.push(message),
    })

    expect(key).toBe('super-secret-key')
    expect(openUrl).toHaveBeenCalledWith('https://console.capgo.app/login-cli?session=AbCdEfGhIjKlMnOpQrStUv')
    expect(validateKey).toHaveBeenCalledWith('super-secret-key', {
      local: false,
      supaAnon: undefined,
      supaHost: undefined,
    })
    expect(sendEvent).toHaveBeenCalledTimes(2)
    expect(sendEvent).toHaveBeenCalledWith('super-secret-key', {
      channel: 'user-login',
      event: 'User CLI login',
      tracking_version: 2,
      org_id: 'org-a',
      description: 'cli-login:AbCdEfGhIjKlMnOpQrStUv',
      notifyConsole: true,
      notify: false,
    })
    expect(output.join('\n')).toContain('/login-cli?session=AbCdEfGhIjKlMnOpQrStUv')
    expect(output.join('\n')).not.toContain('super-secret-key')
  })

  it('keeps notification lookup and delivery best effort after a valid save', async () => {
    await expect(loginInitInBrowser({ local: false }, {
      createSession: () => 'AbCdEfGhIjKlMnOpQrStUv',
      openUrl: async () => { throw new Error('no browser') },
      promptForKey: async () => 'valid-key',
      validateKey: async () => ({ userId: 'user-1' }),
      listOrganizationIds: async () => { throw new Error('offline') },
      sendEvent: async () => { throw new Error('offline') },
      writeUrl: () => undefined,
    })).resolves.toBe('valid-key')
  })
})
```

- [ ] **Step 2: Run the CLI test and verify that the helper is missing**

Run:

```bash
bun test cli/test/init/browser-login.test.ts
```

Expected: FAIL because `cli/src/init/browser-login.ts` does not exist.

- [ ] **Step 3: Implement the CLI helper and default dependencies**

Create `cli/src/init/browser-login.ts`:

```ts
import type { validateAndSaveKey } from '../auth/session'
import type { sendEvent } from '../utils'
import { randomBytes } from 'node:crypto'
import { isCancel, log, password } from '@clack/prompts'
import open from 'open'
import { validateAndSaveKey as saveKey } from '../auth/session'
import { CliUserError } from '../shared/cli-user-error'
import {
  consoleWebUrl,
  createSupabaseClient,
  sendEvent as publishEvent,
} from '../utils'

interface BrowserLoginOptions {
  local: boolean
  supaHost?: string
  supaAnon?: string
}

interface BrowserLoginDependencies {
  createSession: () => string
  openUrl: (url: string) => Promise<unknown>
  promptForKey: () => Promise<string | undefined>
  validateKey: typeof validateAndSaveKey
  listOrganizationIds: (key: string, options: BrowserLoginOptions) => Promise<string[]>
  sendEvent: typeof sendEvent
  writeUrl: (message: string) => void
}

async function promptForKey(): Promise<string | undefined> {
  const value = await password({
    message: 'Paste the API key from the Capgo dashboard:',
    mask: '*',
  })
  return isCancel(value) ? undefined : String(value)
}

async function listOrganizationIds(key: string, options: BrowserLoginOptions): Promise<string[]> {
  const supabase = await createSupabaseClient(key, options.supaHost, options.supaAnon, true)
  await resolveUserIdFromApiKey(supabase, key, true)
  const { data, error } = await supabase.rpc('get_orgs_v7')
  if (error)
    throw error
  return (data ?? []).map(org => org.gid)
}

const defaults: BrowserLoginDependencies = {
  createSession: () => randomBytes(16).toString('base64url'),
  openUrl: url => open(url),
  promptForKey,
  validateKey: saveKey,
  listOrganizationIds,
  sendEvent: publishEvent,
  writeUrl: message => log.info(message),
}

export function shouldStartInitBrowserLogin(resolvedKey: string | undefined, interactive: boolean): boolean {
  return !resolvedKey && interactive
}

export async function loginInitInBrowser(
  options: BrowserLoginOptions,
  overrides: Partial<BrowserLoginDependencies> = {},
): Promise<string> {
  const dependencies = { ...defaults, ...overrides }
  const session = dependencies.createSession()
  const url = consoleWebUrl(`/login-cli?session=${encodeURIComponent(session)}`)
  dependencies.writeUrl(`Open this URL to create your CLI key: ${url}`)
  await dependencies.openUrl(url).catch(() => undefined)

  const key = await dependencies.promptForKey()
  if (!key)
    throw new CliUserError('CLI login cancelled')
  await dependencies.validateKey(key, {
    local: options.local,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })

  try {
    const orgIds = await dependencies.listOrganizationIds(key, options)
    await Promise.allSettled(orgIds.map(orgId => dependencies.sendEvent(key, {
      channel: 'user-login',
      event: 'User CLI login',
      tracking_version: 2,
      org_id: orgId,
      description: `cli-login:${session}`,
      notifyConsole: true,
      notify: false,
    })))
  }
  catch {
    // Saving a valid key is the success condition; browser confirmation is best effort.
  }
  return key
}
```

This helper never writes the key to logs. The only terminal rendering of the secret is owned by `password({ mask: '*' })`.

- [ ] **Step 4: Run the focused CLI test and CLI typecheck**

Run:

```bash
bun test cli/test/init/browser-login.test.ts
bun run --cwd cli typecheck
```

Expected: both PASS.

- [ ] **Step 5: Commit the CLI helper**

```bash
git add cli/src/init/browser-login.ts cli/test/init/browser-login.test.ts
git commit -m "feat(cli): add init browser login helper"
```

## Task 4: Wire `init`, deliver console events under opt-out, and suppress handshake toasts

**Files:**

- Modify: `cli/src/init/command.ts:29-43,5264-5288`
- Modify: `cli/src/utils.ts:1889-1893`
- Modify: `cli/test/test-analytics.mjs`
- Modify: `src/composables/useRealtimeCLIFeed.ts:12-105`
- Create: `tests/realtime-cli-feed.unit.test.ts`

- [ ] **Step 1: Add failing tests for console-event opt-out and feed suppression**

In `cli/test/test-analytics.mjs`, import `sendEvent` from `../src/utils.ts` and add this case immediately after the existing opt-out assertion:

```js
process.env.CAPGO_DISABLE_TELEMETRY = '1'
requests = stubFetch()
await sendEvent('capgo-key', {
  channel: 'user-login',
  event: 'User CLI login',
  org_id: 'org-1',
  description: 'cli-login:test-session',
  tracking_version: 2,
  notifyConsole: true,
  notify: false,
})
assert.ok(findEvent(requests), 'console workflow events must bypass analytics opt-out')
delete process.env.CAPGO_DISABLE_TELEMETRY
```

Create `tests/realtime-cli-feed.unit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { shouldShowCLIActivity } from '../src/composables/useRealtimeCLIFeed'

describe('Realtime CLI feed', () => {
  it.concurrent('suppresses browser-login handshakes only', () => {
    expect(shouldShowCLIActivity({ channel: 'user-login' })).toBe(false)
    expect(shouldShowCLIActivity({ channel: 'bundle-upload' })).toBe(true)
  })
})
```

Run:

```bash
bun cli/test/test-analytics.mjs
bunx vitest run tests/realtime-cli-feed.unit.test.ts
```

Expected: the analytics test fails because opt-out returns before the request, and the frontend test fails because `shouldShowCLIActivity` is missing.

- [ ] **Step 2: Let console workflow events bypass telemetry opt-out**

Change only the early guard in `cli/src/utils.ts`:

```ts
const telemetryDisabled = isTruthyEnvValue(env.CAPGO_DISABLE_TELEMETRY)
  || isTruthyEnvValue(env.CAPGO_DISABLE_POSTHOG)
if (telemetryDisabled && !payload.notifyConsole)
  return
```

Leave payload enrichment, remote config, request headers, timeout, and error behavior unchanged. The existing backend already avoids tracking `notifyConsole` events.

- [ ] **Step 3: Suppress login handshakes in the global Realtime feed**

Export a narrow pure predicate in `src/composables/useRealtimeCLIFeed.ts`:

```ts
export function shouldShowCLIActivity(payload: Pick<CLIActivityPayload, 'channel'>): boolean {
  return payload.channel !== 'user-login'
}
```

Use it at the beginning of `showToast`:

```ts
function showToast(payload: CLIActivityPayload) {
  if (!shouldShowCLIActivity(payload))
    return
}
```

Insert the guard before the current `getRouteForEvent(payload)` call; keep the current routing and toast body after it unchanged.

- [ ] **Step 4: Wire browser login into the exact missing-key branch in `init`**

Add imports in `cli/src/init/command.ts`:

```ts
import { loginInitInBrowser, shouldStartInitBrowserLogin } from './browser-login'
```

Add `canPromptInteractively` to the existing import from `../utils`.

After the existing `findSavedKey(true)` attempt and before the current login spinner, insert:

```ts
const supportsBrowserLogin = !options.local && !options.supaHost && !options.supaAnon
if (shouldStartInitBrowserLogin(options.apikey, supportsBrowserLogin && canPromptInteractively())) {
  options.apikey = await loginInitInBrowser({
    local: options.local,
    supaHost: options.supaHost,
    supaAnon: options.supaAnon,
  })
}
```

Keep the current validation/save block after that; its complete body remains:

```ts
if (!doLoginExists() || apikeyCommand) {
  log.start(`Running: ${pm.runner} @capgo/cli@latest login ***`)
  try {
    await loginInternal(options.apikey, options, true)
    log.stop('Login Done ✅')
  }
  catch (error) {
    log.stop('Login failed ❌')
    throw error
  }
}
```

This ordering produces the required behavior:

- positional key: resolved before the gate, browser bypassed;
- `CAPGO_TOKEN`, global key, or local key: resolved by `findSavedKey(true)`, browser bypassed;
- invalid saved key: reaches existing later validation and does not recover through the browser;
- CI/non-TTY: `canPromptInteractively()` is false and existing missing-key failure remains;
- interactive with no key: browser helper validates/saves and returns the key used by the rest of `init`.

- [ ] **Step 5: Run the focused frontend and CLI tests**

Run:

```bash
bun cli/test/test-analytics.mjs
bun test cli/test/init/browser-login.test.ts
bunx vitest run tests/realtime-cli-feed.unit.test.ts tests/cli-login-key.unit.test.ts tests/cli-login-page.unit.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Run CLI guardrail and replay regression tests**

Run:

```bash
bun cli/test/test-init-guardrails.mjs
bun cli/test/test-init-replay.mjs
bun cli/test/test-auth-session.mjs
```

Expected: all PASS. The pasted secret must not appear in replay output or test diagnostics.

- [ ] **Step 7: Commit integration wiring**

```bash
git add cli/src/init/command.ts cli/src/utils.ts cli/test/test-analytics.mjs src/composables/useRealtimeCLIFeed.ts tests/realtime-cli-feed.unit.test.ts
git commit -m "feat: connect CLI init browser login"
```

## Task 5: Verify the complete flow, backend prohibition, and line budget

**Files:**

- Verify only; no planned code changes.

- [ ] **Step 1: Run formatting/lint before broader validation**

Run:

```bash
bun lint
```

Expected: PASS.

- [ ] **Step 2: Run frontend typecheck and production build**

Run:

```bash
bun typecheck
bun build
```

Expected: PASS.

- [ ] **Step 3: Run the full CLI quality gate**

Run:

```bash
bun run cli:check
```

Expected: CLI lint, typecheck, build, and test suites PASS.

- [ ] **Step 4: Prove no backend files changed**

Run:

```bash
git diff --name-only origin/main...HEAD -- supabase
```

Expected: no output. If any path appears, remove that backend change from this feature rather than expanding scope.

- [ ] **Step 5: Enforce the product-code line budget**

Run:

```bash
git diff --numstat origin/main...HEAD -- src cli/src messages/en.json | awk '{ added += $1; removed += $2 } END { print "product changed lines:", added + removed }'
```

Expected: `product changed lines` is at most `800`. If it exceeds 800, first remove decorative template markup, detailed error parsing, or duplicate page state; do not remove exact scope checks, secret separation, policy enforcement, masked input, or nonce correlation.

- [ ] **Step 6: Perform one local manual smoke test**

With the local frontend and backend already running, use an account with one supported admin organization:

```bash
bun serve:dev
```

In a second terminal, from a temporary project without `CAPGO_TOKEN`, `~/.capgo`, or `./.capgo`, run the locally built CLI `init`. Verify:

1. `/login-cli?session=<nonce>` opens and the same URL is printed.
2. No name, organization, permission, or expiration questions appear.
3. The page shows a fake blurred value before reveal.
4. Copy does not reveal the value; Reveal does; Hide removes the real value from the rendered text.
5. Terminal paste renders `*`, validates, and saves with the existing credential path.
6. The matching page changes once to success without a global toast.
7. The success button resumes the only pending app, or goes to `/dashboard` otherwise.
8. Re-running the page flow reuses the exact compatible `Capgo CLI` key; changing its scopes causes creation of the next exact managed name.

- [ ] **Step 7: Review the final diff for accidental scope growth**

Run:

```bash
git diff --stat origin/main...HEAD
git status --short
```

Expected: only the files in this plan plus the approved design/plan documents are present. Leave unrelated `codedb.snapshot` changes untouched and uncommitted.

## Deliberately deferred edge cases

The implementation is complete without solving these:

- automatic recovery for revoked, expired, invalid, or under-scoped saved keys;
- automatic key transfer or CLI polling;
- member/app/channel/custom role reproduction;
- key deletion when the browser closes or the flow is abandoned;
- retrying a multi-org create with progressively fewer organizations;
- cross-device browser login conveniences;
- detailed reason text per skipped organization;
- reconnect loops beyond Supabase Realtime's existing channel behavior.

These are intentional YAGNI decisions, not follow-up requirements for this PR.
