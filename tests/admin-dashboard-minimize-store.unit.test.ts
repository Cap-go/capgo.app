import type { Json } from '../src/types/supabase.types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUpdateMaybeSingle = vi.fn()
const mockReadMaybeSingle = vi.fn()
const mockUpdateSelect = vi.fn(() => ({ maybeSingle: mockUpdateMaybeSingle }))
const mockFilter = vi.fn(() => ({ select: mockUpdateSelect }))
const mockUpdateEq = vi.fn(() => ({ filter: mockFilter }))
const mockUpdate = vi.fn((_payload: { onboarding: Json }) => ({ eq: mockUpdateEq }))
const mockReadEq = vi.fn(() => ({ maybeSingle: mockReadMaybeSingle }))
const mockReadSelect = vi.fn(() => ({ eq: mockReadEq }))
const mockFrom = vi.fn((_table: string) => ({ select: mockReadSelect, update: mockUpdate }))

const mainStore = {
  authGeneration: 1,
  isAdmin: true,
  user: undefined as { id: string, onboarding: Json } | undefined,
}

vi.mock('~/services/supabase', () => ({
  defaultApiHost: 'https://api.capgo.test',
  useSupabase: () => ({ from: mockFrom }),
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => mainStore,
}))

describe('admin dashboard graph minimize store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
    mainStore.authGeneration = 1
    mainStore.isAdmin = true
    mainStore.user = {
      id: 'admin-user-123',
      onboarding: {
        status: 'in_progress',
        admin_dashboard_minimize: {
          'users.daily-attempts.12345678': true,
        },
      },
    }
    mockUpdateMaybeSingle.mockImplementation(async () => {
      const updateCalls = mockUpdate.mock.calls
      const lastUpdate = updateCalls[updateCalls.length - 1]?.[0]
      return {
        data: {
          id: 'admin-user-123',
          onboarding: lastUpdate?.onboarding ?? mainStore.user?.onboarding ?? {},
        },
        error: null,
      }
    })
    mockReadMaybeSingle.mockImplementation(async () => ({
      data: mainStore.user,
      error: null,
    }))
  })

  it('hydrates once from the user profile already cached by auth', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.daily-attempts.12345678'

    expect(store.isChartMinimized(key)).toBe(true)

    mainStore.user!.onboarding = {
      admin_dashboard_minimize: { [key]: false },
    }

    expect(store.isChartMinimized(key)).toBe(true)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('updates locally first and merge-writes the signed-in user without refetching', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.onboarding-funnel.87654321'

    const persisted = store.setChartMinimized(key, true)

    expect(store.isChartMinimized(key)).toBe(true)
    expect(mainStore.user?.onboarding).toEqual({
      status: 'in_progress',
      admin_dashboard_minimize: {
        'users.daily-attempts.12345678': true,
      },
    })

    await persisted

    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('users')
    expect(mainStore.user?.onboarding).toEqual({
      status: 'in_progress',
      admin_dashboard_minimize: {
        'users.daily-attempts.12345678': true,
        [key]: true,
      },
    })
    expect(mockUpdate).toHaveBeenCalledWith({ onboarding: mainStore.user?.onboarding })
    expect(mockUpdateEq).toHaveBeenCalledWith('id', 'admin-user-123')
    expect(mockFilter).toHaveBeenCalledWith(
      'onboarding',
      'eq',
      JSON.stringify({
        status: 'in_progress',
        admin_dashboard_minimize: {
          'users.daily-attempts.12345678': true,
        },
      }),
    )
  })

  it('serializes rapid writes so the final click reaches the database last', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.daily-attempts.12345678'
    let resolveFirstWrite: ((value: {
      data: { id: string, onboarding: Json }
      error: null
    }) => void) | undefined

    mockUpdateMaybeSingle
      .mockImplementationOnce(() => new Promise<{
        data: { id: string, onboarding: Json }
        error: null
      }>((resolve) => {
        resolveFirstWrite = resolve
      }))

    const firstWrite = store.setChartMinimized(key, false)
    const secondWrite = store.setChartMinimized(key, true)

    await Promise.resolve()
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    resolveFirstWrite?.({
      data: {
        id: 'admin-user-123',
        onboarding: {
          admin_dashboard_minimize: {
            [key]: false,
          },
        },
      },
      error: null,
    })
    await firstWrite
    await secondWrite

    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockUpdate.mock.calls[1]?.[0]).toMatchObject({
      onboarding: {
        admin_dashboard_minimize: {
          [key]: true,
        },
      },
    })
  })

  it('refetches and merges the latest onboarding after a compare-and-swap conflict', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.onboarding-funnel.87654321'
    const remoteOnboarding = {
      status: 'completed',
      admin_dashboard_minimize: {
        'users.remote-chart.abcdef12': true,
      },
    } as Json
    mockUpdateMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
    mockReadMaybeSingle.mockResolvedValueOnce({
      data: { id: 'admin-user-123', onboarding: remoteOnboarding },
      error: null,
    })

    await store.setChartMinimized(key, true)

    expect(mockReadSelect).toHaveBeenCalledWith()
    expect(mockReadEq).toHaveBeenCalledWith('id', 'admin-user-123')
    expect(mockReadMaybeSingle).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledTimes(2)
    expect(mockUpdate).toHaveBeenLastCalledWith({
      onboarding: {
        status: 'completed',
        admin_dashboard_minimize: {
          [key]: true,
          'users.remote-chart.abcdef12': true,
        },
      },
    })
  })

  it('includes an earlier failed optimistic preference in the next write', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const firstKey = 'users.failed-chart.12345678'
    const secondKey = 'users.next-chart.87654321'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUpdateMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'offline' },
    })

    await store.setChartMinimized(firstKey, true)
    await store.setChartMinimized(secondKey, true)

    expect(mockUpdate).toHaveBeenLastCalledWith({
      onboarding: {
        status: 'in_progress',
        admin_dashboard_minimize: {
          'users.daily-attempts.12345678': true,
          [firstKey]: true,
          [secondKey]: true,
        },
      },
    })
    expect(mainStore.user?.onboarding).toMatchObject({
      admin_dashboard_minimize: {
        [firstKey]: true,
        [secondKey]: true,
      },
    })
    consoleError.mockRestore()
  })

  it('clears a failed optimistic preference when the dashboard store resets', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.failed-chart.12345678'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    mockUpdateMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'offline' },
    })

    await store.setChartMinimized(key, true)
    expect(store.isChartMinimized(key)).toBe(true)

    store.$reset()

    expect(store.isChartMinimized(key)).toBe(false)
    consoleError.mockRestore()
  })

  it('refreshes shared onboarding after exhausting compare-and-swap retries', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.contended-chart.12345678'
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const remoteSnapshots = Array.from({ length: 3 }, (_, index) => ({
      status: 'in_progress',
      remote_revision: index + 1,
    } as Json))
    mockUpdateMaybeSingle.mockResolvedValue({ data: null, error: null })
    remoteSnapshots.forEach((onboarding) => {
      mockReadMaybeSingle.mockResolvedValueOnce({
        data: { id: 'admin-user-123', onboarding },
        error: null,
      })
    })

    await store.setChartMinimized(key, true)

    expect(mockUpdate).toHaveBeenCalledTimes(3)
    expect(mockReadMaybeSingle).toHaveBeenCalledTimes(3)
    expect(mainStore.user?.onboarding).toEqual(remoteSnapshots[2])
    expect(store.isChartMinimized(key)).toBe(true)
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to persist admin dashboard graph preference',
      expect.objectContaining({
        message: 'Admin dashboard graph preferences changed too often to persist',
      }),
    )
    consoleError.mockRestore()
  })

  it('does not create or write preferences for a normal user', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    mainStore.isAdmin = false
    mainStore.user = {
      id: 'normal-user-123',
      onboarding: { status: 'in_progress' },
    }

    await store.setChartMinimized('users.daily-attempts.12345678', true)

    expect(store.isChartMinimized('users.daily-attempts.12345678')).toBe(false)
    expect(mainStore.user.onboarding).toEqual({ status: 'in_progress' })
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
