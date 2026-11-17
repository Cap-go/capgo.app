// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingInvoices from '../src/components/billing/BillingInvoices.vue'
import BillingProfileSection from '../src/components/billing/BillingProfileSection.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), invoice: vi.fn(), download: vi.fn(), error: vi.fn() }))
vi.mock('~/services/stripe', () => ({
  getBillingProfile: mocks.load, updateBillingDetails: mocks.save, getInvoiceDocument: mocks.invoice,
  addBillingTaxId: vi.fn(), removeBillingTaxId: vi.fn(), formatStripeAmount: () => '€14.64',
}))
vi.mock('~/services/permissions', () => ({ checkPermissions: vi.fn().mockResolvedValue(true) }))
vi.mock('~/services/date', () => ({ formatLocalDate: (date: string) => date }))
vi.mock('~/services/invoicePdf', () => ({ downloadInvoicePdf: mocks.download }))
vi.mock('vue-sonner', () => ({ toast: { error: mocks.error } }))
const details = {
  name: 'Example Studio', email: 'billing@example.com', phone: '',
  address: { line1: '123 Example Street', line2: '', city: 'Rome', state: '', postal_code: '00100', country: 'IT' },
}
const invoice = { id: 'in_example', number: 'EXAMPLE1-00042', created: '2026-11-01', total: 1464, amountDue: 0, currency: 'eur', status: 'paid' as const }
let app: App | undefined
async function settle() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount() {
  document.body.innerHTML = '<div id="app"></div>'
  app = createApp({
    setup() {
      const current = ref(false)
      return () => h('div', [
        h(BillingProfileSection, { orgId: 'org_example', onDetailsSaved: () => { current.value = true } }),
        h(BillingInvoices, { orgId: 'org_example', invoices: [invoice], useCurrentDetails: current.value, 'onUpdate:useCurrentDetails': (value: boolean) => { current.value = value } }),
      ])
    },
  })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount('#app')
  await settle()
}
async function click(selector: string) {
  document.querySelector<HTMLElement>(selector)!.click()
  await settle()
}
async function saveAddress() {
  await click('[data-test="billing-edit-details"]')
  const input = document.querySelector<HTMLInputElement>('input[name="line1"]')!
  input.value = '456 Example Avenue'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
const checkbox = () => document.querySelector<HTMLInputElement>('[data-test="billing-invoice-use-current-details"]')!
beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue({ ...structuredClone(details), taxIds: [] })
  mocks.save.mockImplementation(async (_org, saved) => saved)
  mocks.invoice.mockImplementation(async (_org, _id, source) => ({ number: invoice.number, customer: [source === 'current' ? '456 Example Avenue' : details.address.line1] }))
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
describe('correcting an invoice address', () => {
  it('saves the address, regenerates the selected invoice and retains the issued-details option', async () => {
    await mount()
    expect(checkbox().checked).toBe(false)
    await saveAddress()
    expect(mocks.save).toHaveBeenCalledWith('org_example', { ...details, address: { ...details.address, line1: '456 Example Avenue' } })
    expect(checkbox().checked).toBe(true)
    expect(document.querySelector('[data-test="billing-download-invoice"]')?.textContent).toContain('Regenerate PDF')
    await click('[data-test="billing-download-invoice"]')
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ number: invoice.number, customer: ['456 Example Avenue'] }, 'org_example'))
    expect(mocks.invoice).toHaveBeenCalledWith('org_example', invoice.id, 'current')
    await settle()
    await click('[data-test="billing-invoice-use-current-details"]')
    await click('[data-test="billing-download-invoice"]')
    await vi.waitFor(() => expect(mocks.download).toHaveBeenLastCalledWith({ number: invoice.number, customer: [details.address.line1] }, 'org_example'))
    expect(mocks.invoice).toHaveBeenLastCalledWith('org_example', invoice.id, 'issued')
  })
  it('does not select new details when saving the address fails', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save failed'))
    await mount()
    await saveAddress()
    expect(checkbox().checked).toBe(false)
    expect(mocks.invoice).not.toHaveBeenCalled()
  })
  it('does not download or fall back to the old address when regeneration fails', async () => {
    mocks.invoice.mockRejectedValueOnce(new Error('customer unavailable'))
    await mount()
    await click('[data-test="billing-invoice-use-current-details"]')
    await click('[data-test="billing-download-invoice"]')
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalled())
    expect(mocks.download).not.toHaveBeenCalled()
    expect(mocks.invoice).toHaveBeenCalledTimes(1)
  })
  it('discards an in-flight document when leaving the organization view', async () => {
    let complete!: (document: unknown) => void
    mocks.invoice.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    await mount()
    await click('[data-test="billing-download-invoice"]')
    app?.unmount()
    app = undefined
    complete({ number: invoice.number, customer: ['456 Example Avenue'] })
    await settle()
    expect(mocks.download).not.toHaveBeenCalled()
  })
})
