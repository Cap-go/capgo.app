// @vitest-environment happy-dom

import type { App } from 'vue'
import type { Json } from '../src/types/supabase.types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import ChartCard from '../src/components/dashboard/ChartCard.vue'

const route = vi.hoisted(() => ({ path: '/admin/dashboard/users' }))
const preferenceKey = 'users.daily-onboarding-attempts.12345678'
const supabaseMocks = vi.hoisted(() => {
  const eq = vi.fn()
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { eq, from, update }
})
const mainStore = vi.hoisted(() => ({
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

function mountChartCard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const app = createApp(defineComponent({
    render: () => h(ChartCard, {
      preferenceKey,
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
    expect(container.querySelector('[data-test="chart-content"]')).not.toBeNull()
    const expandedTitleTypography = container.querySelector('h2')?.className
      .split(' ')
      .filter(className => /^(?:text-(?:base|lg|xl|2xl)|font-|leading-|sm:text-)/.test(className))

    toggle?.click()
    await nextTick()

    expect(toggle?.getAttribute('aria-expanded')).toBe('false')
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

  it('uses the collapsible card for every custom frontend onboarding graph', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/admin/dashboard/frontend-onboarding.vue'), 'utf8')

    expect(source).toContain(`:title="t('frontend-onboarding-funnel-v3')"`)
    expect(source).toContain(`:title="t('frontend-onboarding-graph-v3')"`)
    expect(source).toContain(`:title="t('frontend-onboarding-funnel-v1-legacy')"`)
    expect(source.match(/<ChartCard/g)).toHaveLength(9)
  })

  it('uses the collapsible card for the custom users onboarding funnel', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/pages/admin/dashboard/users.vue'), 'utf8')

    expect(source).toContain(`:title="t('onboarding-funnel')"`)
    expect(source.match(/<ChartCard/g)).toHaveLength(18)
  })
})
