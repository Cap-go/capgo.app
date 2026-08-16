import type { Json } from '../src/types/supabase.types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockEq = vi.fn()
const mockUpdate = vi.fn((_payload: unknown) => ({ eq: mockEq }))
const mockFrom = vi.fn((_table: string) => ({ update: mockUpdate }))

const mainStore = {
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
    mockEq.mockResolvedValue({ error: null })
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
        [key]: true,
      },
    })

    await persisted

    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('users')
    expect(mockUpdate).toHaveBeenCalledWith({ onboarding: mainStore.user?.onboarding })
    expect(mockEq).toHaveBeenCalledWith('id', 'admin-user-123')
  })

  it('serializes rapid writes so the final click reaches the database last', async () => {
    const { useAdminDashboardStore } = await import('../src/stores/adminDashboard.ts')
    const store = useAdminDashboardStore()
    const key = 'users.daily-attempts.12345678'
    let resolveFirstWrite: ((value: { error: null }) => void) | undefined

    mockEq
      .mockImplementationOnce(() => new Promise<{ error: null }>((resolve) => {
        resolveFirstWrite = resolve
      }))
      .mockResolvedValueOnce({ error: null })

    const firstWrite = store.setChartMinimized(key, false)
    const secondWrite = store.setChartMinimized(key, true)

    await Promise.resolve()
    expect(mockUpdate).toHaveBeenCalledTimes(1)

    resolveFirstWrite?.({ error: null })
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
