// @vitest-environment happy-dom

import type { App, Component } from 'vue'
import { createPinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createI18n } from 'vue-i18n'
import BundleUploadsChart from '../src/components/dashboard/BundleUploadsChart.vue'
import DeploymentStatsChart from '../src/components/dashboard/DeploymentStatsChart.vue'
import LineChartStats from '../src/components/dashboard/LineChartStats.vue'

interface RenderedDataset {
  label: string
  appId?: string
  breakdownId?: string
  data: Array<number | null | undefined>
}

const mocks = vi.hoisted(() => ({
  rendered: undefined as { datasets: RenderedDataset[] } | undefined,
}))

vi.mock('~/components/dashboard/lazyCharts', async () => {
  const { defineComponent, h } = await import('vue')
  const chart = defineComponent({
    props: ['data', 'options', 'plugins', 'height'],
    setup: props => () => {
      mocks.rendered = props.data
      return h('div', { 'data-test': 'chart-canvas' })
    },
  })
  return { Bar: chart, Line: chart }
})
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { subscription_start: '2026-10-01T00:00:00Z' } }),
}))
vi.mock('~/services/console', () => ({ defaultApiHost: 'https://example.com' }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

let mountedApp: App | undefined
let container: HTMLDivElement

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-29T12:00:00Z'))
  mocks.rendered = undefined
  container = document.createElement('div')
})

afterEach(() => {
  mountedApp?.unmount()
  mountedApp = undefined
  vi.useRealTimers()
})

function mountChart(component: Component, accumulated: boolean, dataByApp: Record<string, number[]>, overrides: Record<string, unknown> = {}) {
  mountedApp = createApp(component, {
    accumulated,
    useBillingPeriod: false,
    title: 'Organization usage',
    data: Array.from({ length: 30 }, () => Object.values(dataByApp).reduce((sum, values) => sum + values[0], 0)),
    dataByApp,
    appNames: Object.fromEntries(Object.keys(dataByApp).map(appId => [appId, appId])),
    ...overrides,
  })
  mountedApp.use(createPinia())
  mountedApp.use(createI18n({ legacy: false, locale: 'en', messages: { en: { 'other-apps': 'Other apps', 'other-channels': 'Other channels', 'prediction': 'Prediction', 'today': 'Today' } } }))
  mountedApp.mount(container)
  return mocks.rendered!
}

describe.each([
  ['usage', LineChartStats],
  ['bundle uploads', BundleUploadsChart],
  ['deployments', DeploymentStatsChart],
] as const)('global dashboard %s chart', (_name, component) => {
  it.each([false, true])('keeps small active app breakdowns individually visible (cumulative: %s)', (accumulated) => {
    const dataByApp = {
      'com.example.first': Array.from({ length: 30 }).fill(1) as number[],
      'com.example.second': Array.from({ length: 30 }).fill(2) as number[],
      'com.example.inactive': Array.from({ length: 30 }).fill(0) as number[],
    }
    const rendered = mountChart(component, accumulated, dataByApp)

    expect(rendered.datasets.map(dataset => dataset.label)).toEqual(['com.example.first', 'com.example.second'])
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it.each([false, true])('bounds many-app rendering without losing totals (cumulative: %s)', (accumulated) => {
    const dataByApp = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `com.example.app${index}`,
      Array.from({ length: 30 }, () => index + 1),
    ]))
    const rendered = mountChart(component, accumulated, dataByApp)

    expect(rendered.datasets).toHaveLength(10)
    expect(container.querySelectorAll('li')).toHaveLength(10)
    expect(rendered.datasets.some(dataset => dataset.appId === 'com.example.app999' || dataset.breakdownId === 'com.example.app999')).toBe(true)
    const other = rendered.datasets.find(dataset => dataset.label === 'Other apps')
    expect(other?.appId).toBeUndefined()
    expect(other?.breakdownId).toBeUndefined()
    for (let dayIndex = 0; dayIndex < 30; dayIndex++) {
      const expected = 500_500 * (accumulated ? dayIndex + 1 : 1)
      const actual = rendered.datasets.reduce((sum, dataset) => sum + (dataset.data[dayIndex] ?? 0), 0)
      expect(actual).toBe(expected)
    }
  })
})

describe('deployment channel breakdown', () => {
  it.each([false, true])('bounds channel rendering without dropping deployments (cumulative: %s)', (accumulated) => {
    const dataByChannel = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [
      `channel-${index}`,
      Array.from({ length: 30 }, () => index + 1),
    ]))
    const rendered = mountChart(DeploymentStatsChart, accumulated, {}, {
      dataByChannel,
      channelNames: Object.fromEntries(Object.keys(dataByChannel).map(channelId => [channelId, channelId])),
    })

    expect(rendered.datasets).toHaveLength(10)
    expect(container.querySelectorAll('li')).toHaveLength(10)
    expect(rendered.datasets[0].breakdownId).toBe('channel-999')
    const other = rendered.datasets.find(dataset => dataset.label === 'Other channels')
    expect(other).toBeDefined()
    expect(other?.breakdownId).toBeUndefined()
    for (let dayIndex = 0; dayIndex < 30; dayIndex++) {
      const expected = 500_500 * (accumulated ? dayIndex + 1 : 1)
      const actual = rendered.datasets.reduce((sum, dataset) => sum + (dataset.data[dayIndex] ?? 0), 0)
      expect(actual).toBe(expected)
    }
  })
})
