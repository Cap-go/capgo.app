// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingDiscountSection from '../src/components/billing/BillingDiscountSection.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), apply: vi.fn(), permission: vi.fn() }))
vi.mock('~/services/stripe', () => ({ getBillingDiscounts: mocks.load, applyBillingPromotionCode: mocks.apply, formatStripeAmount: (amount: number) => `$${amount / 100}` }))
vi.mock('~/services/permissions', () => ({ checkPermissions: mocks.permission }))
vi.mock('~/services/date', () => ({ formatLocalDate: (value: string) => value }))
vi.mock('~/services/capgoApi', () => ({ getCapgoApiErrorCode: async () => undefined }))
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
  const denied = vi.fn()
  app = createApp(BillingDiscountSection, { orgId: 'org_example', onDenied: denied })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.component('RouterLink', { template: '<a><slot /></a>' })
  app.mount('#app')
  await settle()
  return denied
}
async function fillCode(code = 'EXAMPLE20') {
  const input = document.querySelector<HTMLInputElement>('input[name="promotionCode"]')!
  input.value = code
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
async function submit() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockResolvedValue({ hasSubscription: true, canApply: true, discounts: [] })
  mocks.apply.mockResolvedValue({ discounts: [discount] })
  mocks.permission.mockResolvedValue(true)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
describe('discount code management', () => {
  it('applies a code and displays the returned discount', async () => {
    await mount()
    await fillCode()
    await submit()
    expect(mocks.apply).toHaveBeenCalledWith('org_example', 'EXAMPLE20', false, expect.any(String))
    expect(document.body.textContent).toContain('20% off')
    expect(document.body.textContent).toContain('Promo code applied to future subscription invoices.')
  })
  it('requires explicit replacement and clears confirmation when the entered code changes', async () => {
    mocks.load.mockResolvedValue({ hasSubscription: true, canApply: true, discounts: [discount] })
    await mount()
    await fillCode('OTHER')
    const button = document.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(button.disabled).toBe(true)
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await settle()
    expect(button.disabled).toBe(false)
    await fillCode('ANOTHER')
    expect(button.disabled).toBe(true)
  })
  it('reuses the redemption id on a retry and never shows false success', async () => {
    mocks.apply.mockRejectedValue(new Error('network unavailable'))
    await mount()
    await fillCode()
    await submit()
    expect(document.body.textContent).toContain('Could not apply this code')
    expect(document.body.textContent).not.toContain('Promo code applied to future subscription invoices.')
    await submit()
    expect(mocks.apply.mock.calls[1][3]).toBe(mocks.apply.mock.calls[0][3])
  })
  it('requires billing-write permission before sending the code', async () => {
    mocks.permission.mockResolvedValue(false)
    const denied = await mount()
    await fillCode()
    await submit()
    expect(denied).toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('shows a concurrent discount change and requires fresh confirmation before retrying', async () => {
    mocks.load.mockResolvedValue({ hasSubscription: true, canApply: true, discounts: [discount] })
    mocks.apply.mockResolvedValue({ discounts: [{ ...discount, code: 'OTHER', percentOff: 10 }] })
    await mount()
    await fillCode()
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await settle()
    await submit()
    expect(document.body.textContent).toContain('OTHER')
    expect(document.body.textContent).toContain('10% off')
    expect(document.body.textContent).not.toContain('Promo code applied to future subscription invoices.')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('The subscription discount changed')
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click()
    await settle()
    mocks.apply.mockResolvedValue({ discounts: [discount] })
    await submit()
    expect(mocks.apply.mock.calls[1][3]).not.toBe(mocks.apply.mock.calls[0][3])
    expect(document.body.textContent).toContain('Promo code applied to future subscription invoices.')
  })
  it('points new subscribers to checkout instead of an unusable form', async () => {
    mocks.load.mockResolvedValue({ hasSubscription: false, canApply: false, discounts: [] })
    await mount()
    expect(document.querySelector('form')).toBeNull()
    expect(document.body.textContent).toContain('You can enter a promo code during checkout')
  })
})
