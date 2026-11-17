// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import BillingCurrencySection from '../src/components/billing/BillingCurrencySection.vue'
import { i18n } from '../src/modules/i18n'
import { FunctionsHttpError } from '../src/services/consoleClient'

const api = vi.hoisted(() => vi.fn())
vi.mock('@stripe/stripe-js', () => ({ loadStripe: vi.fn() }))
vi.mock('~/services/capgoApi', () => ({ invokeCapgoApi: api }))
vi.mock('~/services/permissions', () => ({ checkPermissions: async () => true }))
vi.mock('~/modules/i18n', async () => {
  const { createI18n } = await import('vue-i18n')
  const { default: messages } = await import('../messages/en.json')
  return { i18n: createI18n({ legacy: false, locale: 'en', messages: { en: messages } }) }
})
let app: App | undefined
async function settle() {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
beforeEach(() => {
  api.mockReset()
  api.mockImplementation(async (path: string) => path.endsWith('/currency')
    ? { data: { currency: 'eur', currencies: ['eur', 'usd'], subscriptionId: 'sub_example', endsAt: '2030-01-01', pendingCurrency: null }, error: null }
    : { data: null, error: new FunctionsHttpError(new Response(JSON.stringify({ error: 'billing_currency_payment_method_required' }), { status: 400 })) })
})
afterEach(() => {
  app?.unmount()
  document.body.innerHTML = ''
})
it('explains how to update a legacy saved card and blocks confirmation until a valid preview is available', async () => {
  document.body.innerHTML = '<div id="app"></div>'
  app = createApp(BillingCurrencySection, { orgId: 'org_example' })
  app.use(i18n)
  app.component('RouterLink', { template: '<a><slot /></a>' })
  app.mount('#app')
  await settle()
  document.querySelector<HTMLButtonElement>('[data-test="billing-change-currency"]')!.click()
  await settle()
  const select = document.querySelector<HTMLSelectElement>('select')!
  select.value = 'usd'
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await vi.waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Update your saved card in Payment method'))
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Your current subscription stays active')
  expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled).toBe(true)
  expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  expect(api.mock.calls.some(([path]) => path.endsWith('/update'))).toBe(false)
})
