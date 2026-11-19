// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import OrgCustomDomain from '../src/components/OrgCustomDomain.vue'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: invoke,
  isRetryableInvokeError: (error: unknown) => error instanceof TypeError,
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const pending = {
  hostname: 'updates.example.com',
  status: 'pending',
  hostname_status: 'pending',
  certificate_status: 'pending',
  dns_records: [{ type: 'CNAME', name: 'updates.example.com', value: 'plugin.example.com' }],
  errors: [],
  endpoints: null,
}
const active = { ...pending, status: 'active', hostname_status: 'active', certificate_status: 'active' }
let app: App | undefined
let container: HTMLDivElement

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

function mount() {
  const props = reactive({ orgId: '00000000-0000-4000-8000-000000000001' })
  app = createApp({ render: () => h(OrgCustomDomain, props) })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount(container)
  return props
}

function button(label: string) {
  const found = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label)
  if (!found)
    throw new Error(`Missing ${label} button`)
  return found
}

beforeEach(() => {
  vi.useFakeTimers()
  invoke.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  app?.unmount()
  app = undefined
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('automatic custom-domain verification', () => {
  it('becomes active without a manual refresh and stops checking', async () => {
    invoke.mockResolvedValueOnce({ data: { domain: pending }, error: null })
      .mockResolvedValue({ data: { domain: active }, error: null })
    mount()
    await settle()
    expect(container.textContent).toContain(messages['custom-domain-pending'])
    expect(container.textContent).not.toContain(messages['custom-domain-refresh'])
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(container.textContent).toContain(messages['custom-domain-active'])
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenLastCalledWith(expect.any(String), { method: 'GET', retries: 0 })
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('starts verification automatically after adding a domain', async () => {
    invoke.mockResolvedValueOnce({ data: { domain: null }, error: null })
      .mockResolvedValueOnce({ data: { domain: pending }, error: null })
      .mockResolvedValue({ data: { domain: active }, error: null })
    mount()
    await settle()
    const input = container.querySelector('input')
    if (!input)
      throw new Error('Missing hostname input')
    input.value = pending.hostname
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(invoke).toHaveBeenNthCalledWith(2, expect.any(String), { method: 'POST', body: { hostname: pending.hostname } })
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(container.textContent).toContain(messages['custom-domain-active'])
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('cancels verification after removing the domain', async () => {
    invoke.mockResolvedValueOnce({ data: { domain: pending }, error: null })
      .mockResolvedValue({ data: { domain: null }, error: null })
    mount()
    await settle()
    button(messages['custom-domain-remove']).click()
    await nextTick()
    button(messages['custom-domain-confirm-remove']).click()
    await settle()
    expect(invoke).toHaveBeenLastCalledWith(expect.any(String), { method: 'DELETE' })
    expect(container.querySelector('input')).not.toBeNull()
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps the removal confirmation open during an automatic status refresh', async () => {
    invoke.mockResolvedValue({ data: { domain: pending }, error: null })
    mount()
    await settle()
    button(messages['custom-domain-remove']).click()
    await nextTick()
    expect(button(messages['custom-domain-confirm-remove'])).toBeTruthy()
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(button(messages['custom-domain-confirm-remove'])).toBeTruthy()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('preserves pending settings across a transient status error and retries', async () => {
    invoke.mockResolvedValueOnce({ data: { domain: pending }, error: null })
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ data: { domain: active }, error: null })
    mount()
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(container.textContent).toContain(pending.hostname)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await vi.advanceTimersByTimeAsync(15000)
    await settle()
    expect(container.textContent).toContain(messages['custom-domain-active'])
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('does not repeatedly retry a permission error', async () => {
    invoke.mockResolvedValueOnce({ data: { domain: pending }, error: null })
      .mockResolvedValue({ data: null, error: new Error('Forbidden') })
    mount()
    await settle()
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds repeated pending checks and resumes when the page becomes visible again', async () => {
    invoke.mockResolvedValue({ data: { domain: pending }, error: null })
    mount()
    await settle()
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(6)
    expect(vi.getTimerCount()).toBe(0)
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(invoke).toHaveBeenCalledTimes(7)
  })

  it('ignores an old organization response', async () => {
    const old = Promise.withResolvers<{ data: { domain: typeof pending }, error: null }>()
    invoke.mockReturnValueOnce(old.promise).mockResolvedValue({ data: { domain: active }, error: null })
    const props = mount()
    props.orgId = '00000000-0000-4000-8000-000000000002'
    await settle()
    old.resolve({ data: { domain: pending }, error: null })
    await settle()
    expect(container.textContent).toContain(messages['custom-domain-active'])
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('cleans up pending timers and ignores requests completed after unmount', async () => {
    const later = Promise.withResolvers<{ data: { domain: typeof pending }, error: null }>()
    invoke.mockResolvedValueOnce({ data: { domain: pending }, error: null }).mockReturnValue(later.promise)
    mount()
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    app?.unmount()
    app = undefined
    later.resolve({ data: { domain: pending }, error: null })
    await settle()
    await vi.advanceTimersByTimeAsync(600000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
