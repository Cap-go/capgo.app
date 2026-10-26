// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h } from 'vue'
import BillingModal from '../src/components/billing/BillingModal.vue'
import { billingModalOpen } from '../src/services/billingModalState'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

function mountModal() {
  const app = createApp({ render: () => h(BillingModal, { title: 'Billing' }) })
  app.mount(document.createElement('div'))
  return app
}

describe('billing modal open state', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('stays open and keeps the app inert until the last billing modal closes', () => {
    const root = document.createElement('div')
    root.id = 'app'
    document.body.appendChild(root)

    expect(billingModalOpen.value).toBe(false)
    const outer = mountModal()
    const inner = mountModal()
    expect(billingModalOpen.value).toBe(true)

    inner.unmount()
    expect(billingModalOpen.value).toBe(true)
    expect(root.inert).toBe(true)

    outer.unmount()
    expect(billingModalOpen.value).toBe(false)
    expect(root.inert).toBe(false)
  })
})
