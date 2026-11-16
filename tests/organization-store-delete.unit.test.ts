import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref, watch } from 'vue'

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
const mockResetDashboardApps = vi.fn()
const mainStore: any = {
  auth: { id: 'auth-user-123' } as { id: string } | undefined,
  user: { id: 'user-123' } as { id: string } | undefined,
  isAdmin: false,
  invalidatePlatformAdminStatus: vi.fn(() => {
    mainStore.isAdmin = false
  }),
  resolvePlatformAdminStatus: vi.fn(async () => {
    const isAdmin = await mockIsPlatformAdmin()
    mainStore.isAdmin = isAdmin
    return isAdmin
  }),
  updateDashboard: mockUpdateDashboard,
}

vi.mock('~/services/console', () => ({
  isPlatformAdmin: mockIsPlatformAdmin,
  stripeEnabled: ref(true),
  useConsole: () => ({
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
    reset: mockResetDashboardApps,
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
})

describe('organization store fetchOrganizations', () => {
  it('loads many app icons without invalidating the entire app catalog for every icon', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    })
    const orgId = 'org-many-app-icons'
    const organization = {
      'gid': orgId,
      'role': 'org_super_admin',
      'is_invite': false,
      'app_count': 1000,
      'created_by': 'owner-many-app-icons',
      'name': 'Many app icons',
      'logo': null,
      'password_policy_config': null,
      'enforcing_2fa': false,
      '2fa_has_access': true,
      'password_has_access': true,
      'paying': true,
    }
    mockRpc.mockResolvedValueOnce({ data: [organization], error: null })
    mockIn.mockResolvedValueOnce({
      data: Array.from({ length: 1000 }, (_, index) => ({
        app_id: `com.example.icons${index}`,
        name: `Icon app ${index}`,
        owner_org: orgId,
        need_onboarding: false,
        icon_url: `icon-${index}.png`,
      })),
      error: null,
    })
    let releaseIcons!: () => void
    const pendingIcons = new Promise<void>((resolve) => {
      releaseIcons = resolve
    })
    mockCreateSignedImageUrl.mockImplementation(async (path: string) => {
      await pendingIcons
      return `https://example.com/${path}`
    })

    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore(createPinia())
    await store.fetchOrganizations()
    await store.awaitInitialLoad()
    const catalog = store.getAppsByOrgId(orgId)
    const onCatalogChange = vi.fn()
    const stopWatching = watch(() => store.getAppsByOrgId(orgId), onCatalogChange)
    releaseIcons()
    await vi.waitFor(() => {
      expect(store.getAppByAppId('com.example.icons999')?.icon_url).toBe('https://example.com/icon-999.png')
    })
    await nextTick()
    stopWatching()
    mockCreateSignedImageUrl.mockReset()

    expect(store.getAppsByOrgId(orgId) === catalog).toBe(true)
    expect(onCatalogChange).not.toHaveBeenCalled()
    expect(catalog.every(app => app.icon_url_loading === false)).toBe(true)
    expect(catalog.find(app => app.app_id === 'com.example.icons999')?.icon_url).toBe('https://example.com/icon-999.png')

    mockResetDashboardApps.mockClear()
    store.currentOrganization = undefined
    await nextTick()
    expect(mockResetDashboardApps).toHaveBeenCalledOnce()
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

  it('falls back when the selected organization disappears during refresh', async () => {
    const organizationA = {
      'gid': 'org-a',
      'role': 'org_super_admin',
      'app_count': 1,
      'created_by': 'owner-123',
      'name': 'Organization A',
      'logo': null,
      'password_policy_config': null,
      'enforcing_2fa': false,
      '2fa_has_access': true,
      'password_has_access': true,
      'paying': true,
      'trial_left': 0,
      'can_use_more': true,
    }
    const organizationB = {
      ...organizationA,
      gid: 'org-b',
      name: 'Organization B',
    }
    mockRpc
      .mockResolvedValueOnce({ data: [organizationA], error: null })
      .mockResolvedValueOnce({ data: [organizationB], error: null })

    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore(createPinia())

    await store.fetchOrganizations()
    expect(store.currentOrganization?.gid).toBe('org-a')

    await store.fetchOrganizations()

    expect(store.organizations.map(org => org.gid)).toEqual(['org-b'])
    expect(store.currentOrganization?.gid).toBe('org-b')
  })
})

describe('organization store onboarding refresh', () => {
  const orgId = 'org-onboarding-refresh'
  const mockAppIn = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockIn.mockReset().mockResolvedValue({ data: [], error: null })
    mockRpc.mockReset()
    mockAppIn.mockReset()
    mainStore.auth = { id: 'auth-user-123' }
    mainStore.user = { id: 'user-123' }
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn(),
    })
  })

  async function loadStore(count = 4) {
    const rows = Array.from({ length: count }, (_, index) => ({
      app_id: `com.example.refresh-${index}`,
      owner_org: orgId,
      name: `Refresh app ${index}`,
      icon_url: null,
      need_onboarding: false,
      onboarding: { features: { ota: { succeeded_at: '2026-10-01T00:00:00.000Z' } } },
    }))
    mockRpc.mockResolvedValueOnce({ data: [{ gid: orgId, role: 'org_super_admin', is_invite: false, app_count: count, name: 'Refresh organization', logo: null }], error: null })
    mockIn.mockResolvedValueOnce({ data: rows, error: null })
    const { useOrganizationStore } = await import('../src/stores/organization.ts')
    const store = useOrganizationStore(createPinia())
    await store.fetchOrganizations({ loadImages: false })
    await store.awaitInitialLoad()
    mockIn.mockClear()
    return { store, rows }
  }

  it('narrows periodic reads and does not republish unchanged app data', async () => {
    const { store, rows } = await loadStore()
    const firstId = 'com.example.refresh-0'
    const other = store.getAppByAppId('com.example.refresh-1')
    const row = { ...rows[0], app_id: firstId, onboarding: { cicd: { marked_done_at: '2026-11-06T12:00:00.000Z' } } }
    mockIn.mockReturnValue({ in: mockAppIn })
    mockAppIn.mockResolvedValue({ data: [row], error: null })
    await store.refreshAppsOnboarding(orgId, { appIds: [firstId] })
    expect(mockAppIn).toHaveBeenCalledWith('app_id', [firstId])
    expect(store.getAppByAppId(firstId)?.onboarding).toEqual(row.onboarding)
    expect(store.getAppByAppId('com.example.refresh-1')).toBe(other)
    const catalog = store.getAppsByOrgId(orgId)
    const current = store.getAppByAppId(firstId)
    await store.refreshAppsOnboarding(orgId, { appIds: [firstId] })
    expect(store.getAppsByOrgId(orgId)).toBe(catalog)
    expect(store.getAppByAppId(firstId)).toBe(current)
  })

  it('keeps unscoped refreshes complete and publishes a large batch once', async () => {
    const { store, rows } = await loadStore(1000)
    mockIn.mockResolvedValueOnce({ data: rows.map(row => ({ ...row, need_onboarding: true })), error: null })
    const onCatalogChange = vi.fn()
    const stop = watch(() => store.getAppsByOrgId(orgId), onCatalogChange, { flush: 'sync' })
    await store.refreshAppsOnboarding(orgId)
    stop()
    expect(mockIn).toHaveBeenCalledWith('owner_org', [orgId])
    expect(mockAppIn).not.toHaveBeenCalled()
    expect(store.getAppsByOrgId(orgId).every(app => app.need_onboarding)).toBe(true)
    expect(onCatalogChange).toHaveBeenCalledOnce()
  })

  it('preserves newer narrow reads and local writes without discarding other app results', async () => {
    const { store, rows } = await loadStore()
    const { createDeferredPromise } = await import('../src/utils/promise.ts')
    const fullRows = rows.map(row => ({ ...row, onboarding: { cicd: { marked_done_at: 'older-response' } } }))
    const full = createDeferredPromise<{ data: typeof fullRows, error: null }>()
    mockIn.mockReturnValueOnce(full.promise)
    const pending = store.refreshAppsOnboarding(orgId)
    mockIn.mockReturnValueOnce({ in: mockAppIn })
    const firstId = 'com.example.refresh-0'
    mockAppIn.mockResolvedValueOnce({ data: [{ ...rows[0], app_id: firstId, onboarding: { cicd: { marked_done_at: 'newer-response' } } }], error: null })
    await store.refreshAppsOnboarding(orgId, { appIds: [firstId] })
    store.updateAppOnboarding('com.example.refresh-2', { cicd: { marked_done_at: 'local-write' } })
    full.resolve({ data: fullRows, error: null })
    await pending
    expect(store.getAppByAppId(firstId)?.onboarding).toEqual({ cicd: { marked_done_at: 'newer-response' } })
    expect(store.getAppByAppId('com.example.refresh-1')?.onboarding).toEqual({ cicd: { marked_done_at: 'older-response' } })
    expect(store.getAppByAppId('com.example.refresh-2')?.onboarding).toEqual({ cicd: { marked_done_at: 'local-write' } })
  })
})
