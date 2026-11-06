// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import ChartCard from '../src/components/dashboard/ChartCard.vue'

const mountedApps: App[] = []

afterEach(() => mountedApps.splice(0).forEach(app => app.unmount()))

describe('customer chart card', () => {
  it('renders the slot without collapse controls when dashboard preferences are absent', () => {
    const app = createApp(defineComponent({
      render: () => h(ChartCard, {
        title: 'Daily onboarding attempts',
      }, {
        default: () => h('div', { 'data-test': 'chart-content' }, 'Graph content'),
      }),
    }))
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en: { 'no-data': 'No data' } } }))
    const container = document.createElement('div')
    app.mount(container)
    mountedApps.push(app)

    const content = container.querySelector('[data-test="chart-card-content"]')

    expect(container.querySelector('[data-test="chart-card"]')).not.toBeNull()
    expect(container.querySelector('[data-test="chart-collapse-toggle"]')).toBeNull()
    expect(content).not.toBeNull()
    expect(content?.hasAttribute('id')).toBe(false)
    expect(content?.querySelector('[data-test="chart-content"]')?.textContent).toBe('Graph content')
  })
})
