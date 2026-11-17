// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingInvoices from '../src/components/billing/BillingInvoices.vue'
import BillingProfileSection from '../src/components/billing/BillingProfileSection.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), addTax: vi.fn(), removeTax: vi.fn(), invoice: vi.fn(), download: vi.fn(), error: vi.fn() }))
vi.mock('~/services/stripe', () => ({
  getBillingProfile: mocks.load, updateBillingDetails: mocks.save, getInvoiceDocument: mocks.invoice,
  addBillingTaxId: mocks.addTax, removeBillingTaxId: mocks.removeTax, formatStripeAmount: () => '€14.64',
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
let savedDetails = structuredClone(details)
async function settle() {
  for (let i = 0; i < 15; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount() {
  document.body.innerHTML = '<div id="app"></div>'
  app = createApp({
    render: () => h('div', [
      h(BillingProfileSection, { orgId: 'org_example' }),
      h(BillingInvoices, { orgId: 'org_example', invoices: [invoice] }),
    ]),
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
beforeEach(() => {
  vi.clearAllMocks()
  savedDetails = structuredClone(details)
  mocks.load.mockResolvedValue({ ...structuredClone(details), taxIds: [] })
  mocks.save.mockImplementation(async (_org, saved) => { savedDetails = { ...saved, address: { ...saved.address } }; return saved })
  mocks.invoice.mockImplementation(async () => ({ number: invoice.number, customer: [savedDetails.address.line1] }))
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
describe('automatic invoice downloads', () => {
  it('uses the same invoice/PDF links before and after a billing correction with no extra controls', async () => {
    await mount()
    expect(document.querySelector('[data-test="billing-invoices"] input')).toBeNull()
    expect(document.querySelector('[data-test="billing-invoices"]')?.textContent).not.toMatch(/Regenerate|Use current/)
    await click('[data-test="billing-download-invoice"]')
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ number: invoice.number, customer: [details.address.line1] }, 'org_example'))
    await saveAddress()
    expect(mocks.save).toHaveBeenCalledWith('org_example', { ...details, address: { ...details.address, line1: '456 Example Avenue' } })
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.querySelector('[data-test="billing-download-invoice"]')?.textContent?.trim()).toBe('PDF')
    await click('[data-test="billing-invoice-link"]')
    await vi.waitFor(() => expect(mocks.download).toHaveBeenLastCalledWith({ number: invoice.number, customer: ['456 Example Avenue'] }, 'org_example'))
    expect(mocks.invoice.mock.calls).toEqual([['org_example', invoice.id], ['org_example', invoice.id]])
  })
  it('uses an ordinary invoice download after a VAT number replacement', async () => {
    const oldTaxId = { id: 'txi_old', type: 'eu_vat', value: 'IT00000000000', status: 'verified' }
    const newTaxId = { id: 'txi_new', type: 'eu_vat', value: 'IT00000000001', status: 'pending' }
    mocks.load.mockResolvedValue({ ...structuredClone(details), taxIds: [oldTaxId] })
    mocks.addTax.mockResolvedValue(newTaxId)
    mocks.removeTax.mockResolvedValue(undefined)
    mocks.invoice.mockResolvedValue({ number: invoice.number, customer: [newTaxId.value] })
    await mount()
    await click('[data-test="billing-manage-tax"]')
    const input = document.querySelector<HTMLInputElement>('input[name="taxValue"]')!
    input.value = newTaxId.value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-test="billing-tax-form"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(mocks.addTax).toHaveBeenCalledWith('org_example', { type: 'eu_vat', value: newTaxId.value })
    const removeOld = () => Array.from(document.querySelectorAll<HTMLButtonElement>('dialog li button')).find(button => button.textContent?.trim() === 'Remove tax ID')!
    removeOld().click()
    await settle()
    expect(mocks.removeTax).not.toHaveBeenCalled()
    removeOld().click()
    await settle()
    expect(mocks.removeTax).toHaveBeenCalledWith('org_example', oldTaxId.id)
    Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent?.trim() === 'Done')!.click()
    await settle()
    await click('[data-test="billing-invoice-link"]')
    await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledWith({ number: invoice.number, customer: [newTaxId.value] }, 'org_example'))
    expect(mocks.invoice).toHaveBeenCalledWith('org_example', invoice.id)
  })
  it('does not download unsaved details after a rejected save', async () => {
    mocks.save.mockRejectedValueOnce(new Error('save failed'))
    await mount()
    await saveAddress()
    expect(savedDetails.address.line1).toBe(details.address.line1)
    expect(mocks.invoice).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
  })
  it('does not download a stale fallback after a read failure', async () => {
    mocks.invoice.mockRejectedValueOnce(new Error('customer unavailable'))
    await mount()
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
