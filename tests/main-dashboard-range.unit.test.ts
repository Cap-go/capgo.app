import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockFindBestPlan = vi.fn()
const mockGetAllDashboard = vi.fn()
const mockGetTotalStorage = vi.fn()
const mockIsPlatformAdmin = vi.fn()
const mockNormalizeDashboardDateRange = vi.fn()
const mockSetWebsitePaidUserCookie = vi.fn()

vi.mock('../src/services/posthog.ts', () => ({
  reset: vi.fn(),
}))

vi.mock('~/services/console', () => ({
  findBestPlan: mockFindBestPlan,
  getAllDashboard: mockGetAllDashboard,
  getLocalConfig: () => ({ apiHost: 'https://supabase.capgo.test' }),
  getTotalStorage: mockGetTotalStorage,
  isPlatformAdmin: mockIsPlatformAdmin,
  normalizeDashboardDateRange: mockNormalizeDashboardDateRange,
  clearSpoof: vi.fn(),
  useConsole: () => ({
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
      signOut: vi.fn(),
    },
  }),
}))

vi.mock('~/services/websiteAuthCookie', () => ({
  setWebsitePaidUserCookie: mockSetWebsitePaidUserCookie,
}))

function createGlobalDashboard() {
  return Array.from({ length: 30 }, (_, index) => ({
    bandwidth: index,
    build_time_unit: index,
    date: `2026-04-${String(index + 1).padStart(2, '0')}`,
    get: index,
    mau: index,
    storage: index,
  }))
}

describe('main store dashboard range normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-21T12:00:00.000Z'))
    setActivePinia(createPinia())

    const global = createGlobalDashboard()
    global[28] = {
      ...global[28],
      get: 2220,
      mau: 111,
    }
    global[29] = {
      ...global[29],
      get: 9990,
      mau: 999,
    }

    mockNormalizeDashboardDateRange.mockReturnValue({
      end: '2026-04-22T00:00:00.000Z',
      start: '2026-03-23T00:00:00.000Z',
    })
    mockGetAllDashboard.mockResolvedValue({
      byApp: [],
      global,
    })
    mockGetTotalStorage.mockResolvedValue(321)
    mockFindBestPlan.mockResolvedValue('team')
    mockIsPlatformAdmin.mockResolvedValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the normalized range when selecting the current dashboard bucket', async () => {
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()

    await store.updateDashboard('org-123')

    expect(mockNormalizeDashboardDateRange).toHaveBeenCalledWith(undefined, undefined)
    expect(mockGetAllDashboard).toHaveBeenCalledWith(
      'org-123',
      '2026-03-23T00:00:00.000Z',
      '2026-04-22T00:00:00.000Z',
    )
    expect(store.totalDevices).toBe(111)
    expect(store.totalDownload).toBe(2220)
  })

  it('coalesces concurrent global dashboard statistics requests but still allows a later refresh', async () => {
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    await Promise.all(Array.from({ length: 3 }, () => store.updateDashboard('org-many-apps')))

    expect(mockGetAllDashboard).toHaveBeenCalledTimes(1)
    expect(mockFindBestPlan).toHaveBeenCalledTimes(1)
    await store.updateDashboard('org-many-apps')
    expect(mockGetAllDashboard).toHaveBeenCalledTimes(2)
  })

  it('ignores global dashboard statistics that arrive after an organization switch', async () => {
    let resolvePrevious!: (value: unknown) => void
    mockGetAllDashboard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrevious = resolve
    }))
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    const previous = store.updateDashboard('org-previous')
    const freshDashboard = { global: createGlobalDashboard(), byApp: [{ app_id: 'com.example.next' }] }
    mockGetAllDashboard.mockResolvedValueOnce(freshDashboard)
    await store.updateDashboard('org-next')

    resolvePrevious({ global: [], byApp: [{ app_id: 'com.example.previous' }] })
    await previous
    expect(store.dashboard).toEqual(freshDashboard.global)
    expect(store.dashboardByapp).toEqual(freshDashboard.byApp)
    expect(mockFindBestPlan).toHaveBeenCalledTimes(1)
  })

  it('does not coalesce different ranges or publish the older range', async () => {
    let resolvePrevious!: (value: unknown) => void
    mockGetAllDashboard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrevious = resolve
    }))
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    const previous = store.updateDashboard('org-many-apps')
    mockNormalizeDashboardDateRange.mockReturnValueOnce({ start: '2026-04-01T00:00:00.000Z', end: '2026-04-22T00:00:00.000Z' })
    const freshDashboard = { global: createGlobalDashboard(), byApp: [{ app_id: 'com.example.next' }] }
    mockGetAllDashboard.mockResolvedValueOnce(freshDashboard)
    await store.updateDashboard('org-many-apps', '2026-04-01', '2026-04-22')

    expect(mockGetAllDashboard).toHaveBeenCalledTimes(2)
    resolvePrevious({ global: [], byApp: [] })
    await previous
    expect(store.dashboardByapp).toEqual(freshDashboard.byApp)
  })

  it('does not reuse or publish requests from a previous authentication session', async () => {
    let resolvePrevious!: (value: unknown) => void
    mockGetAllDashboard.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrevious = resolve
    }))
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    const previous = store.updateDashboard('org-many-apps')
    store.auth = { id: 'next-session' } as any
    await store.updateDashboard('org-many-apps')

    expect(mockGetAllDashboard).toHaveBeenCalledTimes(2)
    resolvePrevious({ global: [], byApp: [] })
    await previous
    expect(store.dashboard).not.toEqual([])
    expect(mockFindBestPlan).toHaveBeenCalledTimes(1)
  })

  it('does not overwrite a new organization with a delayed plan lookup', async () => {
    let resolvePreviousPlan!: (value: string) => void
    mockFindBestPlan.mockImplementationOnce(() => new Promise<string>((resolve) => {
      resolvePreviousPlan = resolve
    }))
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    const previous = store.updateDashboard('org-previous')
    await vi.waitFor(() => expect(mockFindBestPlan).toHaveBeenCalledTimes(1))
    mockFindBestPlan.mockResolvedValueOnce('next-plan')
    await store.updateDashboard('org-next')

    resolvePreviousPlan('previous-plan')
    await previous
    expect(store.bestPlan).toBe('next-plan')
  })

  it('shares and caches the platform-admin lookup until an explicit refresh', async () => {
    mockIsPlatformAdmin.mockResolvedValue(true)
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    store.auth = { id: 'admin-123' } as any

    const [first, second] = await Promise.all([
      store.resolvePlatformAdminStatus(),
      store.resolvePlatformAdminStatus(),
    ])

    expect(first).toBe(true)
    expect(second).toBe(true)
    expect(mockIsPlatformAdmin).toHaveBeenCalledOnce()
    expect(store.isAdmin).toBe(true)
    expect(mockSetWebsitePaidUserCookie).toHaveBeenCalledWith(true)

    await store.resolvePlatformAdminStatus()
    expect(mockIsPlatformAdmin).toHaveBeenCalledOnce()

    mockIsPlatformAdmin.mockResolvedValue(false)
    await store.refreshPlatformAdminStatus()
    expect(mockIsPlatformAdmin).toHaveBeenCalledTimes(2)
    expect(store.isAdmin).toBe(false)
  })

  it('retries a failed platform-admin lookup on the next navigation', async () => {
    mockIsPlatformAdmin
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(true)
    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    store.auth = { id: 'admin-123' } as any

    await expect(store.resolvePlatformAdminStatus()).rejects.toThrow('temporary failure')
    await expect(store.resolvePlatformAdminStatus()).resolves.toBe(true)

    expect(mockIsPlatformAdmin).toHaveBeenCalledTimes(2)
    expect(store.isAdmin).toBe(true)
  })

  it('discards an in-flight platform-admin lookup after invalidation', async () => {
    let resolveStale!: (status: boolean) => void
    let resolveFresh!: (status: boolean) => void
    const staleResponse = new Promise<boolean>((resolve) => {
      resolveStale = resolve
    })
    const freshResponse = new Promise<boolean>((resolve) => {
      resolveFresh = resolve
    })
    mockIsPlatformAdmin
      .mockReturnValueOnce(staleResponse)
      .mockReturnValueOnce(freshResponse)

    const { useMainStore } = await import('../src/stores/main.ts')
    const store = useMainStore()
    store.auth = { id: 'admin-123' } as any

    const staleLookup = store.resolvePlatformAdminStatus()
    store.invalidatePlatformAdminStatus()
    const freshLookup = store.resolvePlatformAdminStatus()

    expect(mockIsPlatformAdmin).toHaveBeenCalledTimes(2)

    resolveFresh(true)
    await expect(freshLookup).resolves.toBe(true)
    expect(store.isAdmin).toBe(true)

    resolveStale(false)
    await expect(staleLookup).resolves.toBe(false)
    expect(store.isAdmin).toBe(true)

    await expect(store.resolvePlatformAdminStatus()).resolves.toBe(true)
    expect(mockIsPlatformAdmin).toHaveBeenCalledTimes(2)
  })
})
