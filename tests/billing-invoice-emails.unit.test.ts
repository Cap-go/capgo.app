// @vitest-environment happy-dom
import type { App } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import BillingInvoiceEmails from '../src/components/billing/BillingInvoiceEmails.vue'

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), permission: vi.fn() }))
vi.mock('~/services/stripe', () => ({ getInvoiceEmailPreferences: mocks.load, updateInvoiceEmailPreferences: mocks.save }))
vi.mock('~/services/permissions', () => ({ checkPermissions: mocks.permission }))
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
  app = createApp(BillingInvoiceEmails, { orgId: 'org_example', onDenied: denied })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount('#app')
  await settle()
  return denied
}
async function fill(value: string) {
  const input = document.querySelector('textarea')!
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}
async function save() {
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await settle()
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.load.mockResolvedValue({ enabled: true, recipients: [], defaultEmail: 'billing@example.com' })
  mocks.permission.mockResolvedValue(true)
})
afterEach(() => { app?.unmount(); document.body.innerHTML = '' })
it('defaults on, shows the fallback and saves five unverified recipients', async () => {
  await mount()
  expect(document.querySelector('input')!.checked).toBe(true)
  expect(document.body.textContent).toContain('billing@example.com')
  const recipients = Array.from({ length: 5 }, (_, i) => `account${i}@example.com`)
  await fill(recipients.join('\n'))
  await save()
  expect(mocks.save).toHaveBeenCalledWith('org_example', { enabled: true, recipients })
  expect(document.querySelector('[role=status]')!.textContent).toContain('saved')
})
it('saves an opt out', async () => {
  await mount()
  document.querySelector('input')!.click()
  await save()
  expect(mocks.save).toHaveBeenCalledWith('org_example', { enabled: false, recipients: [] })
})
it('rejects a sixth address or invalid mailbox without a request', async () => {
  await mount()
  await fill(Array.from({ length: 6 }, (_, i) => `account${i}@example.com`).join('\n'))
  await save()
  expect(mocks.save).not.toHaveBeenCalled()
  await fill('invalid')
  await save()
  expect(document.querySelector('[role=alert]')!.textContent).toContain('valid')
  expect(mocks.save).not.toHaveBeenCalled()
})
it('requires billing update permission', async () => {
  const denied = await mount()
  mocks.permission.mockResolvedValue(false)
  await save()
  expect(denied).toHaveBeenCalled()
  expect(mocks.save).not.toHaveBeenCalled()
})
it('keeps failures visible and permits retry', async () => {
  await mount()
  mocks.save.mockRejectedValueOnce(new Error('temporary'))
  await save()
  expect(document.querySelector('[role=alert]')!.textContent).toContain('Could not save')
  await save()
  expect(document.querySelector('[role=status]')!.textContent).toContain('saved')
})
