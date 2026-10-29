// @vitest-environment happy-dom

import type { App } from 'vue'
import { createPinia, defineStore } from 'pinia'
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import Usage from '../src/components/dashboard/Usage.vue'
import { useMainStore } from '../src/stores/main'
import { useOrganizationStore } from '../src/stores/organization'

const mocks = vi.hoisted(() => ({ plans: vi.fn(), updateDashboard: vi.fn(), replace: vi.fn() }))
vi.mock('~/stores/main', () => ({
  useMainStore: defineStore('usage-loading-main', {
    state: () => ({
      dashboardFetched: true,
      dashboardOrgId: 'org-first' as string | null,
      dashboardPlanOrgId: 'org-first' as string | null,
      dashboard: [{ date: '2026-10-29', mau: 5, storage: 0, storage_byte_hours: 0, bandwidth: 0 }],
      dashboardByapp: [],
      plans: [],
    }),
    actions: { updateDashboard: () => mocks.updateDashboard(), filterDashboard: () => [] },
  }),
}))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: defineStore('usage-loading-org', {
    state: () => ({ currentOrganization: {
      gid: 'org-first',
      subscription_start: '2026-10-01T00:00:00Z',
      subscription_end: '2026-11-01T00:00:00Z',
      stats_updated_at: '2026-10-29T12:00:00Z',
    } }),
    actions: { getOrgByAppId: () => undefined },
  }),
}))
vi.mock('~/stores/dashboardApps', () => ({
  useDashboardAppsStore: defineStore('usage-loading-apps', {
    state: () => ({ currentOrgId: 'org-first', isLoaded: true, apps: [{ app_id: 'com.example.app' }], appIds: ['com.example.app'], appNames: {} }),
    actions: { fetchApps: async () => undefined },
  }),
}))
vi.mock('~/stores/dialogv2', () => ({ useDialogV2Store: () => ({}) }))
vi.mock('~/services/console', () => ({ getPlans: () => mocks.plans() }))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: vi.fn() }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ replace: mocks.replace }) }))
vi.mock('../src/components/dashboard/UsageCard.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: ['isLoading', 'isRefreshing', 'errorMessage', 'data'],
    setup: (props, { slots }) => () => h('section', {
      'data-test': 'usage-card',
      'data-loading': String(props.isLoading),
      'data-error': String(!!props.errorMessage),
    }, [h('span', JSON.stringify(props.data)), slots.header?.()]),
  }) }
})
vi.mock('../src/components/dashboard/UpdateStatsCard.vue', () => ({ default: { template: '<div data-test="independent-updates" />' } }))
vi.mock('../src/components/dashboard/DeploymentStatsCard.vue', () => ({ default: { template: '<div data-test="independent-deployments" />' } }))

let mounted: App | undefined
let container: HTMLDivElement

async function flush() {
  for (let turn = 0; turn < 12; turn++) {
    await Promise.resolve()
    await nextTick()
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  mocks.plans.mockImplementation(() => new Promise(() => {}))
  mocks.updateDashboard.mockResolvedValue(undefined)
  container = document.createElement('div')
  window.history.replaceState({}, '', '/')
})
afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.useRealTimers()
})

function mountUsage(ready = true, planReady = true) {
  const pinia = createPinia()
  const main = useMainStore(pinia)
  if (!planReady)
    main.dashboardPlanOrgId = null
  if (!ready) {
    main.dashboardFetched = false
    main.dashboardOrgId = null
    main.dashboard = []
  }
  mounted = createApp(Usage)
  mounted.use(pinia)
  mounted.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: {} } }))
  mounted.component('BundleUploadsCard', { template: '<div data-test="independent-uploads" />' })
  mounted.mount(container)
  return pinia
}

describe('independent global usage loading', () => {
  it('renders available usage without waiting for the plan request or an artificial delay', async () => {
    mountUsage()
    await flush()

    expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
    expect(container.querySelector('[data-test="usage-card"]')?.textContent).toContain('5')
    expect(container.querySelector('[data-test="independent-updates"]')).not.toBeNull()
    expect(container.querySelector('[data-test="independent-deployments"]')).not.toBeNull()
  })

  it('retries an incomplete recommendation without hiding available metrics', async () => {
    mocks.updateDashboard.mockImplementationOnce(() => new Promise(() => {}))
    mountUsage(true, false)
    await flush()

    expect(mocks.updateDashboard).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
    expect(container.querySelector('[data-test="usage-card"]')?.textContent).toContain('5')
  })

  it('does not turn a recommendation failure into a usage failure when metrics are ready', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.updateDashboard.mockRejectedValueOnce(new Error('Recommendation unavailable'))
      mountUsage(true, false)
      await flush()

      expect(mocks.updateDashboard).toHaveBeenCalledOnce()
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-error')).toBe('false')
      expect(container.querySelector('[data-test="usage-card"]')?.textContent).toContain('5')
    }
    finally {
      errorLog.mockRestore()
    }
  })

  it('hides the previous organization snapshot while the next organization loads', async () => {
    const pinia = mountUsage()
    await flush()
    expect(container.querySelector('[data-test="usage-card"]')?.textContent).toContain('5')
    mocks.updateDashboard.mockImplementationOnce(() => new Promise(() => {}))
    const organization = useOrganizationStore(pinia).currentOrganization
    assert(organization)
    organization.gid = 'org-next'
    await flush()

    expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('true')
    expect(container.querySelector('[data-test="usage-card"]')?.textContent).not.toContain('5')
    expect(container.querySelector('[data-test="independent-updates"]')).not.toBeNull()
  })

  it('clears the local spinner after a metrics failure without blocking other cards or controls', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.updateDashboard.mockRejectedValue(new Error('Metrics unavailable'))
      mountUsage(false)
      await flush()

      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-error')).toBe('true')
      expect(container.querySelector('[data-test="independent-updates"]')).not.toBeNull()
      const billing = container.querySelector<HTMLButtonElement>('[aria-label="billing-period"]')!
      expect(billing.disabled).toBe(false)
      billing.click()
      await flush()
      expect(new URLSearchParams(window.location.search).get('billingPeriod')).toBe('true')
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-error')).toBe('true')
    }
    finally {
      errorLog.mockRestore()
    }
  })

  it('handles a metrics failure even after the billing selector changes during the request', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let rejectRequest!: (error: Error) => void
      mocks.updateDashboard.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
      mountUsage(false)
      await flush()
      container.querySelector<HTMLButtonElement>('[aria-label="billing-period"]')!.click()
      await flush()
      rejectRequest(new Error('Metrics unavailable'))
      await flush()

      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-loading')).toBe('false')
      expect(container.querySelector('[data-test="usage-card"]')?.getAttribute('data-error')).toBe('true')
    }
    finally {
      errorLog.mockRestore()
    }
  })
})
