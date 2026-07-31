import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

const mockEq = vi.fn()
const mockDelete = vi.fn(() => ({ eq: mockEq }))
const mockIn = vi.fn()
const mockSelect = vi.fn(() => ({ in: mockIn }))
const mockFrom = vi.fn((table: string) => {
  if (table === 'apps') {
    return {
      select: mockSelect,
    }
  }

  return {
    delete: mockDelete,
  }
})
const mockRpc = vi.fn()
const mockIsPlatformAdmin = vi.fn(async () => false)
const mockCreateSignedImageUrl = vi.fn()
const mockResolveImagePath = vi.fn((raw?: string | null) => ({
  normalized: raw?.trim().replace(/^\/+/, '').replace(/^images\//, '') ?? '',
  shouldSign: Boolean(raw?.trim()),
}))
const mockUpdateDashboard = vi.fn()
const mainStore = {
  auth: { id: 'auth-user-123' } as { id: string } | undefined,
  user: { id: 'user-123' } as { id: string } | undefined,
  isAdmin: false,
  updateDashboard: mockUpdateDashboard,
}

vi.mock('~/services/supabase', () => ({
  isPlatformAdmin: mockIsPlatformAdmin,
  stripeEnabled: ref(true),
  useSupabase: () => ({
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
    },
    from: mockFrom,
    rpc: mockRpc,
  }),
}))

vi.mock('~/services/storage', () => ({
  createSignedImageUrl: mockCreateSignedImageUrl,
  getImmediateImageUrl: (value?: string | null) => {
    const { normalized, shouldSign } = mockResolveImagePath(value)
    return shouldSign ? '' : normalized
  },
  resolveImagePath: mockResolveImagePath,
}))

vi.mock('../src/stores/main.ts', () => ({
  useMainStore: () => mainStore,
}))

vi.mock('../src/stores/display.ts', () => ({
  useDisplayStore: () => ({
    clearCachesForOrg: vi.fn(),
  }),
}))

vi.mock('../src/stores/dashboardApps.ts', () => ({
  useDashboardAppsStore: () => ({
    reset: vi.fn(),
    fetchApps: vi.fn(),
  }),
}))

describe('organization store deleteOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mainStore.auth = { id: 'auth-user-123' }
    mainStore.user = { id: 'user-123' }
    mainStore.isAdmin = false
    mockEq.mockResolvedValue({ data: null, error: null })
    mockIn.mockResolvedValue({ data: [], error: null })
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
  })

  it('allows org deletion for org_super_admin roles', async () => {
    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore()
    const orgId = 'org-rbac-super-admin'

    store.getAllOrgs().set(orgId, {
      gid: orgId,
      role: 'org_super_admin',
    } as any)

    const result = await store.deleteOrganization(orgId)

    expect(result.error).toBeNull()
    expect(mockFrom).toHaveBeenCalledWith('orgs')
    expect(mockEq).toHaveBeenCalledWith('id', orgId)
  })

  it('rejects org deletion for lower org roles', async () => {
    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore()
    const orgId = 'org-admin-only'

    store.getAllOrgs().set(orgId, {
      gid: orgId,
      role: 'org_admin',
    } as any)

    const result = await store.deleteOrganization(orgId)

    expect(result.error).toBeInstanceOf(Error)
    expect(result.error?.message).toBe('Insufficient permissions')
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

describe('organization role helpers', () => {
  it('checks RBAC org role hierarchy', async () => {
    const { isAdminRole, isSuperAdminRole, roleHasOrgRank } = await import('../src/stores/organization.ts')

    expect(isAdminRole('org_admin')).toBe(true)
    expect(isAdminRole('org_super_admin')).toBe(true)
    expect(isAdminRole('org_member')).toBe(false)

    expect(isSuperAdminRole('org_super_admin')).toBe(true)
    expect(isSuperAdminRole('owner')).toBe(true)
    expect(isSuperAdminRole('org_admin')).toBe(false)

    expect(roleHasOrgRank('org_super_admin', 'org_admin')).toBe(true)
    expect(roleHasOrgRank('org_billing_admin', 'org_admin')).toBe(false)
  })

  it.concurrent('detects pending invites from is_invite before role text', async () => {
    const { isPendingOrganizationInvite } = await import('../src/stores/organization.ts')

    expect(isPendingOrganizationInvite({ role: 'org_member', is_invite: true } as any)).toBe(true)
    expect(isPendingOrganizationInvite({ role: 'invite_admin', is_invite: false } as any)).toBe(false)
    expect(isPendingOrganizationInvite({ role: 'invite_admin' } as any)).toBe(true)
    expect(isPendingOrganizationInvite({ role: 'org_admin' } as any)).toBe(false)
  })
})

describe('organization store refreshOrganizationLogos', () => {
  it('updates the current org logo without retriggering the dashboard refresh watcher', async () => {
    mockCreateSignedImageUrl.mockResolvedValueOnce('https://signed.example.com/org-logo.png')

    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore()
    const currentOrganization = {
      'gid': 'org-refresh',
      'created_by': 'owner-123',
      'role': 'org_super_admin',
      'logo': 'https://signed.example.com/old-org-logo.png',
      'logo_storage_path': 'org/org-refresh/logo/current.png',
      'name': 'Refresh Org',
      'password_policy_config': null,
      'enforcing_2fa': false,
      '2fa_has_access': true,
      'password_has_access': true,
      'paying': true,
      'trial_left': 0,
      'can_use_more': true,
    } as any

    store.getAllOrgs().set(currentOrganization.gid, { ...currentOrganization })
    store.currentOrganization = currentOrganization
    await Promise.resolve()
    await Promise.resolve()
    mockUpdateDashboard.mockClear()

    const currentOrganizationRef = store.currentOrganization
    await store.refreshOrganizationLogos()

    expect(store.currentOrganization).toBe(currentOrganizationRef)
    expect(store.currentOrganization?.logo).toBe('https://signed.example.com/org-logo.png')
    expect(store.currentOrganization?.logo_storage_path).toBe('org/org-refresh/logo/current.png')
    expect(mockUpdateDashboard).not.toHaveBeenCalled()
  })

  it.concurrent('fetches organizations with the auth session when the public profile is unavailable', async () => {
    mainStore.user = undefined
    mockCreateSignedImageUrl.mockResolvedValueOnce('')
    mockRpc.mockResolvedValueOnce({
      data: [{
        'gid': 'org-auth-fallback',
        'role': 'org_super_admin',
        'app_count': 0,
        'created_by': 'owner-123',
        'name': 'Auth Fallback Org',
        'logo': null,
        'password_policy_config': null,
        'enforcing_2fa': false,
        '2fa_has_access': true,
        'password_has_access': true,
        'paying': true,
        'trial_left': 0,
        'can_use_more': true,
      }],
      error: null,
    })

    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore(createPinia())

    await store.fetchOrganizations()

    expect(mockRpc).toHaveBeenCalledWith('get_orgs_v7')
    expect(store.organizations).toHaveLength(1)
    expect(store.currentOrganization?.gid).toBe('org-auth-fallback')
  })
})
