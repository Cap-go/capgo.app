// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import ChannelCreateOnboarding from '../src/components/dashboard/ChannelCreateOnboarding.vue'

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  lookup: vi.fn(),
  permission: vi.fn(async () => true),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'test-user' } }) }))
vi.mock('~/stores/organization', () => ({
  useOrganizationStore: () => ({
    awaitInitialLoad: async () => undefined,
    currentOrganization: { gid: 'test-org' },
  }),
}))
vi.mock('~/services/permissions', () => ({ checkPermissions: mocks.permission }))
vi.mock('~/services/console', () => ({
  useConsole: () => {
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: mocks.lookup,
      insert: mocks.insert,
    }
    return { from: () => query }
  },
}))

const apps: ReturnType<typeof createApp>[] = []
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  document.body.innerHTML = ''
  vi.resetAllMocks()
})

function mount() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const continued = vi.fn()
  const app = createApp(ChannelCreateOnboarding, { appId: 'com.example.channel-state', onContinue: continued })
  app.mount(container)
  apps.push(app)
  return { container, continued }
}

function element<T extends Element>(container: Element, selector: string) {
  const result = container.querySelector<T>(selector)
  if (!result)
    throw new Error(`Missing element: ${selector}`)
  return result
}

async function submit(container: Element) {
  const input = element<HTMLInputElement>(container, '[data-test="channel-create-name"]')
  input.value = 'production'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  element(container, 'form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await nextTick()
}

describe('channel creation lifecycle', () => {
  it('preserves submitted settings during a pending insert and continues only once', async () => {
    mocks.lookup.mockResolvedValue({ data: null, error: null })
    let finishInsert = () => {}
    mocks.insert.mockImplementation(() => new Promise((resolve) => {
      finishInsert = () => resolve({ error: null })
    }))
    const { container, continued } = mount()
    await vi.waitFor(() => expect(element<HTMLButtonElement>(container, '[data-test="channel-create-submit"]').disabled).toBe(true))
    await submit(container)
    await vi.waitFor(() => expect(mocks.insert).toHaveBeenCalledOnce())
    const checkbox = element<HTMLInputElement>(container, 'input[type="checkbox"]')
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    await nextTick()
    await submit(container)
    expect(mocks.insert).toHaveBeenCalledOnce()
    finishInsert()
    await vi.waitFor(() => expect(container.querySelector('[data-test="channel-create-success"]')).not.toBeNull())
    expect(mocks.insert.mock.calls[0][0].allow_device_self_set).toBe(true)
    expect(container.textContent).not.toContain('disabled')
    const continueButton = element<HTMLButtonElement>(container, '[data-test="channel-create-continue"]')
    continueButton.click()
    continueButton.click()
    expect(continued).toHaveBeenCalledOnce()
  })

  it('returns to editing after a failed insert so the user can retry', async () => {
    mocks.lookup.mockResolvedValue({ data: null, error: null })
    mocks.insert.mockResolvedValueOnce({ error: new Error('test insert failure') }).mockResolvedValueOnce({ error: null })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = mount()
    await vi.waitFor(() => expect(container.querySelector('form')).not.toBeNull())
    await submit(container)
    await vi.waitFor(() => expect(container.textContent).toContain('channel-create-onboarding-submit-error'))
    expect(element<HTMLButtonElement>(container, '[data-test="channel-create-submit"]').disabled).toBe(false)
    await submit(container)
    await vi.waitFor(() => expect(container.querySelector('[data-test="channel-create-success"]')).not.toBeNull())
    expect(mocks.insert).toHaveBeenCalledTimes(2)
  })
})
