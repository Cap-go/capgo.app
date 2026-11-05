// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import Dashboard from '../src/pages/dashboard.vue'
import { useDashboardAppsStore } from '../src/stores/dashboardApps'
import { useOrganizationStore } from '../src/stores/organization'

const mocks = vi.hoisted(() => ({ fetchApps: vi.fn(), fullAppQuery: vi.fn() }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: defineStore('global-page-org', {
    state: () => ({
      currentOrganization: { gid: 'org-first', enforcing_2fa: false, '2fa_has_access': true },
      currentOrganizationFailed: false,
    }),
    actions: { awaitInitialLoad: async () => undefined },
  }),
}))
vi.mock('~/stores/dashboardApps', () => ({
  useDashboardAppsStore: defineStore('global-page-apps', {
    state: () => ({ currentOrgId: 'org-first', isLoaded: false, isLoading: true, apps: [] as any[] }),
    actions: { fetchApps: () => mocks.fetchApps() },
  }),
}))
vi.mock('~/stores/display', () => ({ useDisplayStore: () => ({}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/dashboard' }) }))
vi.mock('~/services/console', () => ({
  useConsole: () => ({ from: () => ({ select: () => ({ eq: mocks.fullAppQuery }) }) }),
}))
vi.mock('../src/components/Tabs.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: ['tabs', 'activeTab'],
    emits: ['update:active-tab'],
    setup: (props, { emit }) => () => h('nav', props.tabs.map((tab: any) => h('button', {
      onClick: () => emit('update:active-tab', tab.key),
    }, tab.key))),
  }) }
})
vi.mock('../src/components/dashboard/OrgNativeBuildStatsPanel.vue', () => ({ default: { template: '<div data-test="builds-panel" />' } }))
vi.mock('../src/components/dashboard/DeliveryLatencyPanel.vue', () => ({ default: { template: '<div data-test="delivery-panel" />' } }))
vi.mock('../src/components/dashboard/OrgNotificationStatsPanel.vue', () => ({ default: { template: '<div data-test="notifications-panel" />' } }))

let mounted: App | undefined
let container: HTMLDivElement

async function flush() {
  for (let turn = 0; turn < 10; turn++) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.fetchApps.mockImplementation(() => new Promise(() => {}))
  mocks.fullAppQuery.mockResolvedValue({ data: null, error: { message: 'Temporary failure' } })
  container = document.createElement('div')
})
afterEach(() => {
  mounted?.unmount()
  mounted = undefined
})

function mountDashboard() {
  mounted = createApp(Dashboard)
  const pinia = createPinia()
  mounted.use(pinia)
  mounted.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }))
  for (const name of ['Usage', 'TrialBanner', 'FailedCard', 'PaymentRequiredModal', 'RouterLink'])
    mounted.component(name, { template: `<div data-test="${name}" />` })
  mounted.mount(container)
  return pinia
}

describe('global dashboard loading does not block the page', () => {
  it('uses the shared lightweight app catalog instead of fetching every app column again', async () => {
    mountDashboard()
    await flush()

    expect(mocks.fetchApps).toHaveBeenCalledTimes(1)
    expect(mocks.fullAppQuery).not.toHaveBeenCalled()
  })

  it('keeps tabs and scrolling available while the catalog is pending or unavailable', async () => {
    mountDashboard()
    await flush()
    expect(container.querySelector('[data-native-scroll]')?.classList.contains('overflow-y-auto')).toBe(true)
    expect(container.querySelector('.pointer-events-none')).toBeNull()
    expect(container.textContent).not.toContain('add-your-first-app-to-see-dashboard')

    const builds = Array.from(container.querySelectorAll('nav button')).find(button => button.textContent === 'builds') as HTMLButtonElement
    builds.click()
    await nextTick()
    expect(container.querySelector('[data-test="builds-panel"]')).not.toBeNull()
    const notifications = Array.from(container.querySelectorAll('nav button')).find(button => button.textContent === 'notifications') as HTMLButtonElement
    notifications.click()
    await nextTick()
    expect(container.querySelector('[data-test="notifications-panel"]')).not.toBeNull()
  })

  it('shows the empty-state overlay only after a successful load for the selected organization', async () => {
    const pinia = mountDashboard()
    await flush()
    const catalog = useDashboardAppsStore(pinia)
    catalog.isLoaded = true
    catalog.isLoading = false
    catalog.currentOrgId = 'org-previous'
    await nextTick()
    expect(container.querySelector('.pointer-events-none')).toBeNull()

    catalog.currentOrgId = 'org-first'
    await nextTick()
    expect(container.textContent).toContain('add-your-first-app-to-see-dashboard')
  })

  it('keeps security restrictions intact rather than treating them as loading states', async () => {
    const pinia = mountDashboard()
    const organization = useOrganizationStore(pinia).currentOrganization
    assert(organization)
    organization.enforcing_2fa = true
    organization['2fa_has_access'] = false
    await flush()

    expect(container.querySelector('[data-test="FailedCard"]')).not.toBeNull()
    expect(container.querySelector('[data-test="Usage"]')).toBeNull()
    expect(container.querySelector('nav')).toBeNull()
  })
})
