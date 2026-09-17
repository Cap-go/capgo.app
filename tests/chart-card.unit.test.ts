// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { createI18n } from 'vue-i18n'
import ChartCard from '../src/components/dashboard/ChartCard.vue'

const mountedApps: App[] = []

afterEach(() => mountedApps.splice(0).forEach(app => app.unmount()))

describe('customer chart card', () => {
  it('preserves the customer chart markup without dashboard preferences', () => {
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
})
