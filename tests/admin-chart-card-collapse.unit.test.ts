// @vitest-environment happy-dom

import type { App } from 'vue'
import type { Json } from '../src/types/supabase.types'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ChartCard from '../src/components/dashboard/ChartCard.vue'
import { createAdminDashboardChartPreferenceKey } from '../src/services/adminDashboardPreferences'
import { serializeUserOnboardingWrite } from '../src/services/userOnboardingWriteQueue'
import { useAdminDashboardStore } from '../src/stores/adminDashboard'

const route = vi.hoisted(() => ({ path: '/admin/dashboard/users' }))
const chartId = 'daily-onboarding-attempts'
const preferenceKey = createAdminDashboardChartPreferenceKey(route.path, chartId)
const supabaseMocks = vi.hoisted(() => {
  const maybeSingle = vi.fn()
  const updateSelect = vi.fn(() => ({ maybeSingle }))
  const filter = vi.fn(() => ({ select: updateSelect }))
  const is = vi.fn(() => ({ select: updateSelect }))
  const updateEq = vi.fn(() => ({ filter, is }))
  const update = vi.fn((_values: { onboarding: Json }) => ({ eq: updateEq }))
  const readEq = vi.fn(() => ({ maybeSingle }))
  const readSelect = vi.fn(() => ({ eq: readEq }))
  const from = vi.fn(() => ({ select: readSelect, update }))
  return { filter, from, is, maybeSingle, readEq, readSelect, update, updateEq, updateSelect }
})
const mainStore = vi.hoisted(() => ({
  authGeneration: 1,
  isAdmin: true,
  user: {
    id: 'admin-user-123',
    onboarding: {} as Json,
  } as { id: string, onboarding: Json } | undefined,
}))

vi.mock('vue-router', () => ({
  useRoute: () => route,
}))

vi.mock('~/services/supabase', () => ({
  defaultApiHost: 'https://api.capgo.test',
  useSupabase: () => ({ from: supabaseMocks.from }),
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => mainStore,
}))

const mountedApps: App[] = []

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function mountChartCard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = createApp(defineComponent({
    render: () => h(ChartCard, {
      chartId,
      title: 'Daily onboarding attempts',
    }, {
      default: () => h('div', { 'data-test': 'chart-content' }, 'Graph content'),
    }),
  }))
  app.use(pinia)
  app.use(createI18n({
    legacy: false,
    locale: 'en',
    messages: {
      en: {
        'collapse-chart': 'Minimize graph',
        'expand-chart': 'Expand graph',
      },
    },
  }))
  const container = document.createElement('div')
  app.mount(container)
  mountedApps.push(app)
  return container
}

beforeEach(() => {
  vi.clearAllMocks()
  route.path = '/admin/dashboard/users'
  mainStore.isAdmin = true
  mainStore.authGeneration = 1
  mainStore.user = {
    id: 'admin-user-123',
    onboarding: {},
  }
  supabaseMocks.maybeSingle.mockImplementation(async () => {
    const updateCalls = supabaseMocks.update.mock.calls
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

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  vi.restoreAllMocks()
})

describe('admin chart card minimize control', () => {
  it('keeps the graph title visible while toggling its content', async () => {
    const container = mountChartCard()
    const toggle = container.querySelector<HTMLButtonElement>('[data-test="chart-collapse-toggle"]')

    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(toggle?.getAttribute('aria-controls')).toMatch(/^chart-content-/)
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
    const expandedTitleTypography = container.querySelector('h2')?.className
      .split(' ')
      .filter(className => /^(?:text-(?:base|lg|xl|2xl)|font-|leading-|sm:text-)/.test(className))

    toggle?.click()
    await nextTick()

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(toggle?.hasAttribute('aria-controls')).toBe(false)
    expect(toggle?.getAttribute('aria-label')).toBe('Expand graph')
    expect(container.textContent).toContain('Daily onboarding attempts')
    expect(container.querySelector('[data-test="chart-content"]')).toBeNull()
    const collapsedTitleTypography = container.querySelector('h2')?.className
      .split(' ')
      .filter(className => /^(?:text-(?:base|lg|xl|2xl)|font-|leading-|sm:text-)/.test(className))
    expect(collapsedTitleTypography).toEqual(expandedTitleTypography)
  })

  it('preserves the original chart markup outside the admin dashboard', () => {
    route.path = '/app/com.example.app'
    const container = mountChartCard()
    const card = container.firstElementChild
    const header = card?.children[1]
    const headerRow = header?.firstElementChild?.firstElementChild
    const headerActions = headerRow?.lastElementChild
    const content = container.querySelector('[data-test="chart-content"]')?.parentElement

    expect(container.querySelector('[data-test="chart-collapse-toggle"]')).toBeNull()
    expect(card?.classList).toContain('min-h-[460px]')
    expect(card?.classList).not.toContain('transition-[min-height,box-shadow]')
    expect(header?.className).toContain('pt-5')
    expect(headerRow?.className).toContain('flex-col')
    expect(headerRow?.className).toContain('sm:flex-row')
    expect(headerActions?.classList).not.toContain('shrink-0')
    expect(content).not.toBeNull()
    expect(content?.hasAttribute('id')).toBe(false)
  })

  it('does not enable chart collapsing for non-admin users', () => {
    mainStore.isAdmin = false
    const container = mountChartCard()

    expect(container.querySelector('[data-test="chart-collapse-toggle"]')).toBeNull()
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
    expect(supabaseMocks.update).not.toHaveBeenCalled()
  })

  it('starts from the cached database preference and writes the expanded state', async () => {
    mainStore.user = {
      id: 'admin-user-123',
      onboarding: {
        status: 'in_progress',
        admin_dashboard_minimize: {
          [preferenceKey]: true,
        },
      },
    }
    const container = mountChartCard()
    const toggle = container.querySelector<HTMLButtonElement>('[data-test="chart-collapse-toggle"]')

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-test="chart-content"]')).toBeNull()

    toggle?.click()
    await nextTick()

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
    await vi.waitFor(() => {
      expect(supabaseMocks.update).toHaveBeenCalledWith({
        onboarding: {
          status: 'in_progress',
          admin_dashboard_minimize: {
            [preferenceKey]: false,
          },
        },
      })
    })
    await vi.waitFor(() => {
      expect(mainStore.user?.onboarding).toEqual({
        status: 'in_progress',
        admin_dashboard_minimize: {
          [preferenceKey]: false,
        },
      })
    })
    expect(supabaseMocks.updateEq).toHaveBeenCalledWith('id', 'admin-user-123')
    expect(supabaseMocks.filter).toHaveBeenCalledWith(
      'onboarding',
      'eq',
      JSON.stringify({
        status: 'in_progress',
        admin_dashboard_minimize: {
          [preferenceKey]: true,
        },
      }),
    )
  })

  it('rehydrates the same administrator after the auth session changes', () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()

    expect(adminDashboard.isChartMinimized(preferenceKey)).toBe(false)

    mainStore.user = {
      id: 'admin-user-123',
      onboarding: {
        admin_dashboard_minimize: {
          [preferenceKey]: true,
        },
      },
    }
    mainStore.authGeneration += 1

    expect(adminDashboard.isChartMinimized(preferenceKey)).toBe(true)
  })

  it('drops a queued preference write from an earlier auth session', async () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()
    const firstDatabaseWrite = deferred<{
      data: { id: string, onboarding: Json }
      error: null
    }>()
    supabaseMocks.maybeSingle.mockImplementationOnce(() => firstDatabaseWrite.promise)

    const first = adminDashboard.setChartMinimized(preferenceKey, true)
    await vi.waitFor(() => expect(supabaseMocks.maybeSingle).toHaveBeenCalledTimes(1))
    const second = adminDashboard.setChartMinimized(preferenceKey, false)

    mainStore.authGeneration += 1
    firstDatabaseWrite.resolve({
      data: {
        id: 'admin-user-123',
        onboarding: {
          admin_dashboard_minimize: {
            [preferenceKey]: true,
          },
        },
      },
      error: null,
    })
    await Promise.all([first, second])

    expect(supabaseMocks.update).toHaveBeenCalledTimes(1)
  })

  it('reapplies the optimistic preference after an onboarding write finishes', async () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()
    const onboardingDatabaseWrite = deferred<void>()
    const onboardingWrite = serializeUserOnboardingWrite('admin-user-123', async () => {
      await onboardingDatabaseWrite.promise
      mainStore.user = {
        id: 'admin-user-123',
        onboarding: { status: 'in_progress' },
      }
    })

    const preferenceWrite = adminDashboard.setChartMinimized(preferenceKey, true)
    onboardingDatabaseWrite.resolve()
    await Promise.all([onboardingWrite, preferenceWrite])

    expect(mainStore.user?.onboarding).toEqual({
      status: 'in_progress',
      admin_dashboard_minimize: {
        [preferenceKey]: true,
      },
    })
    expect(supabaseMocks.update).toHaveBeenCalledWith({
      onboarding: mainStore.user?.onboarding,
    })
  })

  it('retries a cross-tab conflict against the latest onboarding snapshot', async () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()
    const remoteOnboarding = {
      status: 'completed',
      admin_dashboard_minimize: {
        remote_chart: true,
      },
    } as Json
    const persistedOnboarding = {
      status: 'completed',
      admin_dashboard_minimize: {
        [preferenceKey]: true,
        remote_chart: true,
      },
    } as Json
    supabaseMocks.maybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: 'admin-user-123', onboarding: remoteOnboarding },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { id: 'admin-user-123', onboarding: persistedOnboarding },
        error: null,
      })

    await adminDashboard.setChartMinimized(preferenceKey, true)

    expect(supabaseMocks.update).toHaveBeenCalledTimes(2)
    expect(supabaseMocks.update).toHaveBeenLastCalledWith({
      onboarding: persistedOnboarding,
    })
    expect(supabaseMocks.filter).toHaveBeenLastCalledWith(
      'onboarding',
      'eq',
      JSON.stringify(remoteOnboarding),
    )
    expect(mainStore.user?.onboarding).toEqual(persistedOnboarding)
  })

  it('keeps failed optimistic state out of the shared user profile', async () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()
    const databaseWrite = deferred<{
      data: null
      error: { message: string }
    }>()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    supabaseMocks.maybeSingle.mockImplementationOnce(() => databaseWrite.promise)

    const preferenceWrite = adminDashboard.setChartMinimized(preferenceKey, true)

    expect(adminDashboard.isChartMinimized(preferenceKey)).toBe(true)
    expect(mainStore.user?.onboarding).toEqual({})
    databaseWrite.resolve({ data: null, error: { message: 'offline' } })
    await preferenceWrite

    expect(mainStore.user?.onboarding).toEqual({})
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to persist admin dashboard graph preference',
      { message: 'offline' },
    )
    consoleError.mockRestore()
  })

  it('persists the clicked preference snapshot even if the store resets while queued', async () => {
    mountChartCard()
    const adminDashboard = useAdminDashboardStore()
    const earlierWrite = deferred<void>()
    const blocker = serializeUserOnboardingWrite('admin-user-123', async () => earlierWrite.promise)

    const preferenceWrite = adminDashboard.setChartMinimized(preferenceKey, true)
    adminDashboard.$reset()
    earlierWrite.resolve()
    await Promise.all([blocker, preferenceWrite])

    expect(supabaseMocks.update).toHaveBeenCalledWith({
      onboarding: {
        admin_dashboard_minimize: {
          [preferenceKey]: true,
        },
      },
    })
  })

  it('uses the collapsible card for every custom frontend onboarding graph', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/admin/dashboard/frontend-onboarding.vue'), 'utf8')

    expect(source).toContain(`:title="t('frontend-onboarding-funnel-v3')"`)
    expect(source).toContain(`:title="t('frontend-onboarding-graph-v3')"`)
    expect(source).toContain(`:title="t('frontend-onboarding-funnel-v1-legacy')"`)
    expect(source.match(/<ChartCard/g)).toHaveLength(9)
  })

  it('assigns a stable chart ID to every admin dashboard graph', () => {
    const dashboardDirectory = resolve(process.cwd(), 'src/pages/admin/dashboard')
    const dashboardPages = readdirSync(dashboardDirectory).filter(file => file.endsWith('.vue'))

    for (const page of dashboardPages) {
      const source = readFileSync(resolve(dashboardDirectory, page), 'utf8')
      const chartTags = source.match(/<ChartCard\b(?:"[^"]*"|'[^']*'|[^'">])*>/g) ?? []
      for (const chartTag of chartTags)
        expect(chartTag, `${page} has a ChartCard without chart-id`).toContain('chart-id=')
    }
  })

  it('uses the collapsible card for the custom users onboarding funnel', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/admin/dashboard/users.vue'), 'utf8')

    expect(source).toContain(`:title="t('onboarding-funnel')"`)
    expect(source.match(/<ChartCard/g)).toHaveLength(18)
  })
})
