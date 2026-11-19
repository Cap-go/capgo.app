// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingSubscriptionDiscounts from '../src/components/billing/BillingSubscriptionDiscounts.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('~/services/stripe', () => ({ getBillingDiscounts: mocks.load, formatStripeAmount: (amount: number) => `$${amount / 100}` }))
vi.mock('~/services/date', () => ({ formatLocalDate: (value: string) => value }))
const discount = { name: 'Example offer', code: 'EXAMPLE20', percentOff: 20, amountOff: null, currency: null, endsAt: null }
let app: App | undefined
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount() {
  document.body.innerHTML = '<div id="app"></div>'
  app = createApp(BillingSubscriptionDiscounts, { orgId: 'org_example' })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount('#app')
  await settle()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockResolvedValue({ discounts: [discount] })
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})
describe('applied subscription discounts', () => {
  it('displays the existing discount without a form, action or separate card', async () => {
    await mount()
    expect(mocks.load).toHaveBeenCalledWith('org_example')
    expect(document.body.textContent).toContain('20% off')
    expect(document.body.textContent).toContain('EXAMPLE20')
    expect(document.querySelector('form, input, button, section')).toBeNull()
  })
  it('renders nothing when no discount is applied', async () => {
    mocks.load.mockResolvedValue({ discounts: [] })
    await mount()
    expect(document.body.textContent).toBe('')
    expect(document.querySelector('[data-test="billing-discounts"]')).toBeNull()
  })
  it('displays an amount discount and its expiry', async () => {
    mocks.load.mockResolvedValue({ discounts: [{ ...discount, percentOff: null, amountOff: 500, currency: 'usd', endsAt: '2030-01-01' }] })
    await mount()
    expect(document.body.textContent).toContain('$5 off')
    expect(document.body.textContent).toContain('Ends 2030-01-01')
  })
  it('keeps the subscription usable when discounts cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.load.mockRejectedValue(new Error('unavailable'))
    await mount()
    expect(document.body.textContent).toBe('')
  })
})
