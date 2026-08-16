import type { Json } from '../src/types/supabase.types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockMaybeSingle = vi.fn()
const mockUpdateSelect = vi.fn(() => ({ maybeSingle: mockMaybeSingle }))
const mockFilter = vi.fn(() => ({ select: mockUpdateSelect }))
const mockIs = vi.fn(() => ({ select: mockUpdateSelect }))
const mockUpdateEq = vi.fn(() => ({ filter: mockFilter, is: mockIs }))
const mockUpdate = vi.fn((_payload: { onboarding: Json }) => ({ eq: mockUpdateEq }))
const mockReadEq = vi.fn(() => ({ maybeSingle: mockMaybeSingle }))
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
    mockMaybeSingle.mockImplementation(async () => {
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

    mockMaybeSingle
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
