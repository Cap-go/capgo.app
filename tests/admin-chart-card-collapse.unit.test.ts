// @vitest-environment happy-dom

import type { App } from 'vue'
import type { Json } from '../src/types/supabase.types'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const eq = vi.fn()
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { eq, from, update }
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

afterEach(() => {
  mountedApps.splice(0).forEach(app => app.unmount())
  vi.clearAllMocks()
  route.path = '/admin/dashboard/users'
  mainStore.isAdmin = true
  mainStore.authGeneration = 1
  mainStore.user = {
    id: 'admin-user-123',
    onboarding: {},
  }
  supabaseMocks.eq.mockResolvedValue({ error: null })
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

  it('does not add the minimize control outside the admin dashboard', () => {
    route.path = '/app/com.example.app'
    const container = mountChartCard()

    expect(container.querySelector('[data-test="chart-collapse-toggle"]')).toBeNull()
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
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
    supabaseMocks.eq.mockResolvedValue({ error: null })

    const container = mountChartCard()
    const toggle = container.querySelector<HTMLButtonElement>('[data-test="chart-collapse-toggle"]')

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('[data-test="chart-content"]')).toBeNull()

    toggle?.click()
    await nextTick()

    expect(toggle?.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
    expect(mainStore.user.onboarding).toEqual({
      status: 'in_progress',
      admin_dashboard_minimize: {
        [preferenceKey]: false,
      },
    })
    await vi.waitFor(() => {
      expect(supabaseMocks.update).toHaveBeenCalledWith({
        onboarding: mainStore.user?.onboarding,
      })
    })
    expect(supabaseMocks.eq).toHaveBeenCalledWith('id', 'admin-user-123')
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
    const firstDatabaseWrite = deferred<{ error: null }>()
    supabaseMocks.eq.mockImplementationOnce(() => firstDatabaseWrite.promise)

    const first = adminDashboard.setChartMinimized(preferenceKey, true)
    await vi.waitFor(() => expect(supabaseMocks.eq).toHaveBeenCalledTimes(1))
    const second = adminDashboard.setChartMinimized(preferenceKey, false)

    mainStore.authGeneration += 1
    firstDatabaseWrite.resolve({ error: null })
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
      const chartTags = source.match(/<ChartCard\b[\s\S]*?>/g) ?? []
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
