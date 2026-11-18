// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingProfileSection from '../src/components/billing/BillingProfileSection.vue'

const mocks = vi.hoisted(() => ({ currency: vi.fn(), load: vi.fn(), save: vi.fn(), add: vi.fn(), remove: vi.fn(), permission: vi.fn() }))
vi.mock('~/services/stripe', () => ({ getBillingCurrencyState: mocks.currency, getBillingProfile: mocks.load, updateBillingDetails: mocks.save, addBillingTaxId: mocks.add, removeBillingTaxId: mocks.remove }))
vi.mock('~/services/permissions', () => ({ checkPermissions: mocks.permission }))
const profile = {
  name: 'Example Company', email: 'billing@example.com', phone: '',
  address: { line1: '123 Example Street', line2: '', city: 'Berlin', state: '', postal_code: '10115', country: 'DE' },
  taxIds: [{ id: 'txi_example', type: 'eu_vat', value: 'DE123456789', status: 'pending' }],
}
let app: App | undefined
async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}
async function mount(orgId = 'org_example') {
  document.body.innerHTML = '<div id="app"></div>'
  const denied = vi.fn()
  app = createApp(BillingProfileSection, { orgId, onDenied: denied })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount('#app')
  await settle()
  return denied
}
async function click(selector: string) {
  document.querySelector<HTMLButtonElement>(selector)!.click()
  await settle()
}
async function fill(name: string, value: string) {
  const input = document.querySelector<HTMLInputElement>(`[name="${name}"]`)!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
async function submit(selector: string) {
  document.querySelector(selector)!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockResolvedValue(structuredClone(profile))
  mocks.permission.mockResolvedValue(true)
})
afterEach(() => {
  app?.unmount()
  app = undefined
  document.body.innerHTML = ''
})
describe('billing details editor', () => {
  it('displays invoice identity, address, tax number and verification status', async () => {
    await mount()
    expect(document.body.textContent).toContain('billing@example.com')
    expect(document.body.textContent).toContain('123 Example Street')
    expect(document.body.textContent).toContain('DE123456789')
    expect(document.body.textContent).toContain('Verification pending')
  })
  it('saves invoice details in place using the mounted organization', async () => {
    await mount()
    await click('[data-test="billing-edit-details"]')
    await fill('name', 'Updated Example Company')
    const { taxIds: _, ...details } = profile
    mocks.save.mockResolvedValue({ ...details, name: 'Updated Example Company' })
    await submit('[data-test="billing-details-form"]')
    expect(mocks.save).toHaveBeenCalledWith('org_example', { ...details, name: 'Updated Example Company' })
    expect(document.querySelector('dialog')).toBeNull()
    expect(document.body.textContent).toContain('Updated Example Company')
  })
  it('keeps the form and original display on a failed save', async () => {
    await mount()
    await click('[data-test="billing-edit-details"]')
    await fill('name', 'Unsaved Company')
    mocks.save.mockRejectedValue(new Error('network failed'))
    await submit('[data-test="billing-details-form"]')
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not save')
    expect(document.querySelector('[data-test="billing-profile-details"]')?.textContent).toContain('Example Company')
    expect(document.querySelector<HTMLInputElement>('[name="name"]')?.value).toBe('Unsaved Company')
  })
  it('allows readers to see details but does not open an editor without billing-write permission', async () => {
    mocks.permission.mockResolvedValue(false)
    const denied = await mount()
    await click('[data-test="billing-edit-details"]')
    await click('[data-test="billing-manage-tax"]')
    expect(denied).toHaveBeenCalledTimes(2)
    expect(document.querySelector('dialog')).toBeNull()
    expect(mocks.save).not.toHaveBeenCalled()
  })
  it('shows a retry after a read failure', async () => {
    mocks.load.mockRejectedValueOnce(new Error('unavailable'))
    await mount()
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not load')
    await click('button')
    expect(document.body.textContent).toContain('billing@example.com')
  })
  it('adds a tax ID without closing the editor or removing the existing one', async () => {
    await mount()
    await click('[data-test="billing-manage-tax"]')
    await fill('taxValue', 'DE987654321')
    mocks.add.mockResolvedValue({ ...profile.taxIds[0], id: 'txi_new', value: 'DE987654321' })
    await submit('[data-test="billing-tax-form"]')
    expect(mocks.add).toHaveBeenCalledWith('org_example', { type: 'eu_vat', value: 'DE987654321' })
    expect(document.querySelector('dialog')?.textContent).toContain('DE987654321')
    expect(document.querySelector('dialog')?.textContent).toContain('DE123456789')
    expect(mocks.remove).not.toHaveBeenCalled()
  })
  it('requires confirmation before removing a tax ID', async () => {
    await mount()
    await click('[data-test="billing-manage-tax"]')
    const remove = () => Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(button => button.textContent?.trim() === 'Remove tax ID')!
    remove().click()
    await settle()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(document.querySelector('dialog')?.textContent).toContain('Remove this tax ID from your billing profile?')
    remove().click()
    await settle()
    expect(mocks.remove).toHaveBeenCalledWith('org_example', 'txi_example')
    expect(document.body.textContent).not.toContain('DE123456789')
  })
  it('does not reopen an old editor after the organization view is unmounted', async () => {
    let allow!: (allowed: boolean) => void
    mocks.permission.mockImplementation(() => new Promise(resolve => { allow = resolve }))
    await mount()
    await click('[data-test="billing-edit-details"]')
    app?.unmount()
    app = undefined
    allow(true)
    await settle()
    expect(document.querySelector('dialog')).toBeNull()
  })
})
