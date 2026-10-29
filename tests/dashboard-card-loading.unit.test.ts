// @vitest-environment happy-dom

import type { App, Component } from 'vue'
import { createPinia, defineStore, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, h, nextTick, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { createI18n } from 'vue-i18n'
import BundleUploadsCard from '../src/components/dashboard/BundleUploadsCard.vue'
import DeploymentStatsCard from '../src/components/dashboard/DeploymentStatsCard.vue'
import UpdateStatsCard from '../src/components/dashboard/UpdateStatsCard.vue'
import { useOrganizationStore } from '../src/stores/organization'

const mocks = vi.hoisted(() => ({ rows: vi.fn() }))

vi.mock('~/stores/organization', () => ({
  useOrganizationStore: defineStore('card-loading-org', {
    state: () => ({ currentOrganization: { gid: 'org-first', subscription_start: '2026-10-01T00:00:00Z' } }),
    actions: {
      dedupFetchOrganizations: async () => undefined,
      awaitInitialLoad: async () => undefined,
      getOrgByAppId: () => undefined,
    },
  }),
}))
vi.mock('~/stores/dashboardApps', () => ({
  useDashboardAppsStore: defineStore('card-loading-apps', {
    state: () => ({ apps: [{ app_id: 'com.example.app', name: 'Example' }], isLoaded: true }),
    getters: {
      appIds: state => state.apps.map(app => app.app_id),
      appNames: () => ({ 'com.example.app': 'Example' }),
    },
    actions: { fetchApps: async () => undefined },
  }),
}))
vi.mock('~/services/console', () => ({
  useConsole: () => ({
    rpc: (name: string) => ({ range: () => mocks.rows(name) }),
    from: () => {
      const query: Record<string, any> = {}
      for (const method of ['select', 'in', 'gte', 'lte', 'order'])
        query[method] = () => query
      query.range = () => mocks.rows('daily_version')
      return query
    },
  }),
}))

async function mockChart() {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({
    props: ['data'],
    setup: props => () => h('button', { 'data-test': 'interactive-chart' }, JSON.stringify(props.data)),
  }) }
}
vi.mock('../src/components/dashboard/BundleUploadsChart.vue', () => mockChart())
vi.mock('../src/components/dashboard/DeploymentStatsChart.vue', () => mockChart())
vi.mock('../src/components/dashboard/UpdateStatsChart.vue', () => mockChart())

let mounted: App | undefined
let container: HTMLDivElement

function result(name: string, count = 5) {
  if (name === 'get_bundle_upload_daily_counts')
    return { data: [{ app_id: 'com.example.app', day_index: 29, uploads: count }], error: null }
  if (name === 'get_deploy_daily_counts')
    return { data: [{ app_id: 'com.example.app', channel_id: 'example-channel', channel_name: 'Production', day_index: 29, deploys: count }], error: null }
  return { data: [{ app_id: 'com.example.app', date: '2026-10-29', install: count, fail: 0, get: 0 }], error: null }
}

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
  for (const [name, value] of Object.entries({ computed, ref, shallowRef, watch, onMounted }))
    vi.stubGlobal(name, value)
  setActivePinia(createPinia())
  mocks.rows.mockImplementation(async (name: string) => result(name))
  container = document.createElement('div')
})

afterEach(() => {
  mounted?.unmount()
  mounted = undefined
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mountCard(component: Component) {
  const props = reactive({ useBillingPeriod: false, accumulated: false, reloadTrigger: 0 })
  mounted = createApp({ render: () => h(component, props) })
  mounted.use(createPinia())
  mounted.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false, messages: { en: { 'loading': 'Loading', 'error-loading-data': 'Error loading data' } } }))
  mounted.mount(container)
  await flush()
  return props
}

describe.each([
  ['uploads', BundleUploadsCard],
  ['deployments', DeploymentStatsCard],
  ['updates', UpdateStatsCard],
] as const)('nonblocking %s card', (_name, component) => {
  it('keeps the existing chart interactive during a same-scope refresh', async () => {
    const props = await mountCard(component)
    const chart = container.querySelector('[data-test="interactive-chart"]')
    expect(chart).not.toBeNull()
    let resolveRefresh!: (value: ReturnType<typeof result>) => void
    mocks.rows.mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve }))
    props.reloadTrigger++
    await flush()

    expect(container.querySelector('[data-test="interactive-chart"]')).toBe(chart)
    expect(container.querySelector('[data-test="chart-refreshing"]')).not.toBeNull()
    resolveRefresh(result(_name === 'uploads' ? 'get_bundle_upload_daily_counts' : _name === 'deployments' ? 'get_deploy_daily_counts' : 'daily_version', 9))
    await flush()
    expect(container.querySelector('[data-test="chart-refreshing"]')).toBeNull()
    expect(container.querySelector('[data-test="interactive-chart"]')?.textContent).toContain('9')
  })

  it('does not refetch or hide the chart when only the visual accumulation mode changes', async () => {
    const props = await mountCard(component)
    const chart = container.querySelector('[data-test="interactive-chart"]')
    const requests = mocks.rows.mock.calls.length
    props.accumulated = true
    await flush()

    expect(mocks.rows).toHaveBeenCalledTimes(requests)
    expect(container.querySelector('[data-test="interactive-chart"]')).toBe(chart)
  })

  it('preserves the current chart and reports a refresh failure locally', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const props = await mountCard(component)
      const chart = container.querySelector('[data-test="interactive-chart"]')
      mocks.rows.mockRejectedValueOnce(new Error('Temporary failure'))
      props.reloadTrigger++
      await flush()

      expect(container.querySelector('[data-test="interactive-chart"]')).toBe(chart)
      expect(container.textContent).toContain('Error loading data')
      expect(container.querySelector('[data-test="chart-card"]')?.getAttribute('aria-busy')).toBe('false')
      expect(container.querySelector('[data-test="chart-refreshing"]')).toBeNull()
    }
    finally {
      errorLog.mockRestore()
    }
  })

  it('settles an initial failure without blocking the rest of the dashboard', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      mocks.rows.mockRejectedValueOnce(new Error('Temporary failure'))
      await mountCard(component)

      expect(container.textContent).toContain('Error loading data')
      expect(container.querySelector('[data-test="chart-card"]')?.getAttribute('aria-busy')).toBe('false')
    }
    finally {
      errorLog.mockRestore()
    }
  })

  it('stops reading more pages after the card unmounts', async () => {
    const props = await mountCard(component)
    let resolvePage!: (value: ReturnType<typeof result>) => void
    mocks.rows.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve }))
    props.reloadTrigger++
    await flush()
    const requests = mocks.rows.mock.calls.length
    const row = result(_name === 'uploads' ? 'get_bundle_upload_daily_counts' : _name === 'deployments' ? 'get_deploy_daily_counts' : 'daily_version').data[0]
    mounted?.unmount()
    mounted = undefined
    resolvePage({ data: Array.from({ length: 1000 }, () => row), error: null } as ReturnType<typeof result>)
    await flush()

    expect(mocks.rows).toHaveBeenCalledTimes(requests)
  })

  it('does not let a delayed previous organization replace the current chart', async () => {
    const props = await mountCard(component)
    let resolveOld!: (value: ReturnType<typeof result>) => void
    mocks.rows.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    props.reloadTrigger++
    await flush()
    useOrganizationStore().currentOrganization = { gid: 'org-next', subscription_start: '2026-10-01T00:00:00Z' } as any
    await flush()
    const currentChart = container.querySelector('[data-test="interactive-chart"]')?.textContent
    expect(currentChart).toContain('5')

    resolveOld(result(_name === 'uploads' ? 'get_bundle_upload_daily_counts' : _name === 'deployments' ? 'get_deploy_daily_counts' : 'daily_version', 99))
    await flush()
    expect(container.querySelector('[data-test="interactive-chart"]')?.textContent).toBe(currentChart)
  })
})

describe('update evolution refresh', () => {
  it.each([0, 1])('clears the previous badge after refreshing to %i active days', async (activeDays) => {
    mocks.rows.mockResolvedValueOnce({
      data: [
        { app_id: 'com.example.app', date: '2026-10-28', install: 5, fail: 0, get: 0 },
        { app_id: 'com.example.app', date: '2026-10-29', install: 10, fail: 0, get: 0 },
      ],
      error: null,
    })
    const props = await mountCard(UpdateStatsCard)
    expect(container.querySelector('[data-test="chart-card-header-actions"]')?.textContent).toContain('100.00%')

    mocks.rows.mockResolvedValueOnce(result('daily_version', activeDays * 7))
    props.reloadTrigger++
    await flush()

    expect(container.querySelector('[data-test="chart-card-header-actions"]')?.textContent).toContain('+0.00%')
  })
})
