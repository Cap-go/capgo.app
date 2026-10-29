import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useDashboardAppsStore } from '../src/stores/dashboardApps'

const mocks = vi.hoisted(() => ({
  organization: {
    currentOrganization: { gid: 'org-many-apps' },
    dedupFetchOrganizations: vi.fn(async () => undefined),
    awaitInitialLoad: vi.fn(async (): Promise<void> => undefined),
  },
  eq: vi.fn(),
  setAppNameResolver: vi.fn(),
}))

vi.mock('~/services/console', () => ({
  useConsole: () => ({
    from: () => ({ select: () => ({
      eq: (...filters: unknown[]) => ({
        order: () => ({
          range: async (from: number, to: number) => {
            const response = await mocks.eq(...filters)
            return { ...response, data: response.data?.slice(from, to + 1) ?? null }
          },
        }),
      }),
    }) }),
  }),
}))
vi.mock('../src/stores/organization', () => ({ useOrganizationStore: () => mocks.organization }))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({ setAppNameResolver: mocks.setAppNameResolver }) }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.organization.currentOrganization = { gid: 'org-many-apps' }
  mocks.eq.mockResolvedValue({
    data: Array.from({ length: 999 }, (_, index) => ({ app_id: `com.example.app${index}`, name: `App ${index}` })),
    error: null,
  })
  setActivePinia(createPinia())
})

describe('global dashboard shared app loading', () => {
  it('loads the selected organization without waiting for the all-organization app index', async () => {
    let releaseIndex!: () => void
    mocks.organization.awaitInitialLoad.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseIndex = resolve }))
    const store = useDashboardAppsStore()
    const request = store.fetchApps()
    try {
      await vi.waitFor(() => expect(mocks.eq).toHaveBeenCalledTimes(1))
      expect(store.apps).toHaveLength(999)
    }
    finally {
      releaseIndex?.()
      await request
    }
  })

  it('shares one forced app load across cards mounting for the same organization', async () => {
    const store = useDashboardAppsStore()
    await Promise.all(Array.from({ length: 4 }, () => store.fetchApps(true)))

    expect(mocks.eq).toHaveBeenCalledTimes(1)
    expect(store.apps).toHaveLength(999)
    expect(store.isLoaded).toBe(true)
    expect(store.isLoading).toBe(false)

    await store.fetchApps()
    expect(mocks.eq).toHaveBeenCalledTimes(1)
    await store.fetchApps(true)
    expect(mocks.eq).toHaveBeenCalledTimes(2)
  })

  it('reuses the loaded catalog when cards mount at different times', async () => {
    const store = useDashboardAppsStore()
    for (let cardIndex = 0; cardIndex < 4; cardIndex++)
      await store.fetchApps()

    expect(mocks.eq).toHaveBeenCalledTimes(1)
    expect(store.appIds).toHaveLength(999)
  })

  it('does not wait for or publish a previous organization when switching during a load', async () => {
    let resolvePrevious!: (value: unknown) => void
    mocks.eq.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePrevious = resolve
    }))
    const store = useDashboardAppsStore()
    const previous = store.fetchApps(true)
    await vi.waitFor(() => expect(mocks.eq).toHaveBeenCalledTimes(1))

    mocks.organization.currentOrganization = { gid: 'org-next' }
    mocks.eq.mockResolvedValueOnce({ data: [{ app_id: 'com.example.next', name: 'Next' }], error: null })
    const next = store.fetchApps(true)
    await vi.waitFor(() => expect(mocks.eq).toHaveBeenCalledTimes(2))
    await next
    expect(store.appIds).toEqual(['com.example.next'])

    resolvePrevious({ data: [{ app_id: 'com.example.previous', name: 'Previous' }], error: null })
    await previous
    expect(store.currentOrgId).toBe('org-next')
    expect(store.appIds).toEqual(['com.example.next'])
  })

  it('loads the complete selected catalog beyond the PostgREST row limit', async () => {
    mocks.eq.mockResolvedValue({
      data: Array.from({ length: 1200 }, (_, index) => ({ app_id: `com.example.large${index}`, name: `App ${index}` })),
      error: null,
    })
    const store = useDashboardAppsStore()
    await store.fetchApps()

    expect(store.apps).toHaveLength(1200)
    expect(mocks.eq).toHaveBeenCalledTimes(2)
  })

  it('retains a successful catalog when a background refresh fails', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = useDashboardAppsStore()
      await store.fetchApps()
      const previous = store.apps
      mocks.eq.mockResolvedValueOnce({ data: null, error: { message: 'Temporary failure' } })
      await store.fetchApps(true)

      expect(store.apps).toBe(previous)
      expect(store.isLoaded).toBe(true)
      expect(store.isLoading).toBe(false)
    }
    finally {
      errorLog.mockRestore()
    }
  })

  it('invalidates pending responses on reset without clearing a newer load', async () => {
    let resolvePrevious!: (value: unknown) => void
    let resolveNext!: (value: unknown) => void
    mocks.eq
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePrevious = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve }))
    const store = useDashboardAppsStore()
    const previous = store.fetchApps(true)
    await vi.waitFor(() => expect(mocks.eq).toHaveBeenCalledTimes(1))

    store.reset()
    const next = store.fetchApps(true)
    await vi.waitFor(() => expect(mocks.eq).toHaveBeenCalledTimes(2))
    resolvePrevious({ data: [{ app_id: 'com.example.previous', name: 'Previous' }], error: null })
    await previous
    expect(store.apps).toEqual([])
    expect(store.isLoading).toBe(true)

    resolveNext({ data: [{ app_id: 'com.example.next', name: 'Next' }], error: null })
    await next
    expect(store.appIds).toEqual(['com.example.next'])
    expect(store.isLoading).toBe(false)
    expect(mocks.setAppNameResolver).toHaveBeenCalledTimes(1)
  })

  it('retries a returned query error instead of caching it as an empty organization', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.eq.mockResolvedValueOnce({ data: null, error: { message: 'Temporary failure' } })
      const store = useDashboardAppsStore()
      await store.fetchApps()

      expect(store.isLoaded).toBe(false)
      expect(store.isLoading).toBe(false)
      await store.fetchApps()
      expect(mocks.eq).toHaveBeenCalledTimes(2)
      expect(store.isLoaded).toBe(true)
      expect(store.apps).toHaveLength(999)
    }
    finally {
      errorLog.mockRestore()
    }
  })
})
