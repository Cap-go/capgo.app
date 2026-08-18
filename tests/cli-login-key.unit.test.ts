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

function org(overrides: Record<string, unknown> = {}) {
  return {
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
  }
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    hasRequiredPermissions: vi.fn(async () => true),
    listMetadata: vi.fn(async () => []),
    listOwnedKeys: vi.fn(async () => []),
    listBindings: vi.fn(async () => []),
    createKey: vi.fn(async () => ({ key: 'new-secret' })),
    ...overrides,
  }
}

describe('CLI login key model', () => {
  it.concurrent.each([
    ['owner', 'org_super_admin'],
    ['org_super_admin', 'org_super_admin'],
    ['org_admin', 'org_admin'],
    ['org_member', null],
    ['org_billing_admin', null],
    ['custom_role', null],
  ])('maps %s without guessing', (role, expected) => {
    expect(roleForCliKey(role)).toBe(expected)
  })

  it.concurrent('combines hashing with the strictest expiration and clock margin', () => {
    expect(aggregateCliKeyPolicy([
      org({ enforce_hashed_api_keys: true, max_apikey_expiration_days: 30 }),
      org({ gid: 'org-b', require_apikey_expiration: true, max_apikey_expiration_days: 90 }),
    ], now)).toEqual({
      hashed: true,
      expiresAt: '2026-09-14T11:59:00.000Z',
    })
  })

  it.concurrent('uses 365 days only when expiration is required and no positive max exists', () => {
    expect(aggregateCliKeyPolicy([
      org({ require_apikey_expiration: true, max_apikey_expiration_days: null }),
    ], now)).toEqual({
      hashed: false,
      expiresAt: '2027-08-15T11:59:00.000Z',
    })
  })

  it.concurrent('parses only exact managed names and fills the first gap', () => {
    expect(nextManagedCliKeyName([
      'Capgo CLI',
      'Capgo CLI (3)',
      'Capgo CLI copy',
      'Capgo CLI (01)',
    ])).toBe('Capgo CLI (2)')
  })

  it.concurrent('canonicalizes all scope fields so extra app or channel access is not equal', () => {
    const expected = canonicalizeCliBindings([
      { role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
    ])
    expect(canonicalizeCliBindings([
      { role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
      { role_name: 'app_admin', scope_type: 'app', org_id: 'org-a', app_id: 'app-a' },
    ])).not.toEqual(expected)
  })

  it.concurrent('validates high-entropy sessions and matches only the exact login event', () => {
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

  it.concurrent('offers onboarding only for one accepted org and one pending app', () => {
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

describe('prepareCliLoginKey', () => {
  it.concurrent('skips unsupported, invited, security-blocked, and permission-blocked orgs', async () => {
    const io = dependencies({
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

  it.concurrent('reuses the exact plaintext key and rejects global permissions', async () => {
    const exact = {
      id: 1,
      name: 'Capgo CLI',
      rbac_id: 'rbac-1',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: null,
      is_hashed_key: false,
      global_permissions: [],
    }
    const io = dependencies({
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

  it.concurrent('rejects extra or expired bindings, expired keys, and plaintext keys under a hashed policy', async () => {
    const metadata = {
      id: 1,
      name: 'Capgo CLI',
      rbac_id: 'rbac-1',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: null,
      is_hashed_key: false,
      global_permissions: [],
    }
    const io = dependencies({
      listMetadata: vi.fn(async () => [metadata]),
      listOwnedKeys: vi.fn(async () => [{ ...metadata, key: 'existing-secret' }]),
      listBindings: vi.fn(async () => [
        { principal_id: 'rbac-1', role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
        { principal_id: 'rbac-1', role_name: 'app_admin', scope_type: 'app', org_id: 'org-a', app_id: 'app-a' },
      ]),
    })

    await expect(prepareCliLoginKey([org()], io, now)).resolves.toMatchObject({ reused: false })

    io.listBindings.mockResolvedValue([
      {
        principal_id: 'rbac-1',
        role_name: 'org_admin',
        scope_type: 'org',
        org_id: 'org-a',
        expires_at: '2026-08-14T00:00:00Z',
      },
    ])
    await expect(prepareCliLoginKey([org()], io, now)).resolves.toMatchObject({ reused: false })

    io.listBindings.mockResolvedValue([
      { principal_id: 'rbac-1', role_name: 'org_admin', scope_type: 'org', org_id: 'org-a' },
    ])
    io.listOwnedKeys.mockResolvedValue([{
      ...metadata,
      key: 'existing-secret',
      expires_at: '2026-08-14T00:00:00Z',
    }])
    await expect(prepareCliLoginKey([org()], io, now)).resolves.toMatchObject({ reused: false })

    io.listOwnedKeys.mockResolvedValue([{ ...metadata, key: 'existing-secret' }])
    await expect(prepareCliLoginKey([
      org({ enforce_hashed_api_keys: true }),
    ], io, now)).resolves.toMatchObject({ reused: false })
  })

  it.concurrent('reuses a key that expires exactly at the organization maximum', async () => {
    const exact = {
      id: 1,
      name: 'Capgo CLI',
      rbac_id: 'rbac-1',
      created_at: '2026-08-01T00:00:00Z',
      expires_at: '2026-09-14T12:00:00Z',
      is_hashed_key: false,
      global_permissions: [],
    }
    const io = dependencies({
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

  it.concurrent('reserves exact managed names even when a hashed key cannot be reused', async () => {
    const io = dependencies({
      listOwnedKeys: vi.fn(async () => [
        { id: 1, name: 'Capgo CLI', key: null, rbac_id: 'one', created_at: '', expires_at: null },
        { id: 2, name: 'Capgo CLI (2)', key: null, rbac_id: 'two', created_at: '', expires_at: null },
        { id: 3, name: 'Capgo CLI old', key: 'x', rbac_id: 'three', created_at: '', expires_at: null },
      ]),
    })
    await prepareCliLoginKey([org()], io, now)
    expect(io.createKey).toHaveBeenCalledWith(expect.objectContaining({ name: 'Capgo CLI (3)' }))
  })

  it.concurrent('does not call key APIs when every organization is skipped', async () => {
    const io = dependencies()
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
