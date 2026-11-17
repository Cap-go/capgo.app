// @vitest-environment happy-dom

import type { App } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '../messages/en.json'
import AppServingRegions from '../src/components/dashboard/AppServingRegions.vue'

const fetchMock = vi.fn<typeof fetch>()
let app: App | undefined
let container: HTMLDivElement
const appId = 'com.example.settings-status'

function active(id = appId, regions = ['NA'], mode = 'block') {
  return Response.json({ app_id: id, active: true, policy: { regions, mode } })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_SERVING_POLICY_URL', 'https://plugin.eu.capgo.app/serving_policy/')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset().mockImplementation(async () => active())
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(async () => {
  app?.unmount()
  app = undefined
  await settle()
  container.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function mount(overrides: Partial<{ disabled: boolean, appId: string, regions: string[], mode: string, savedRegions: string[], savedMode: string }> = {}) {
  const props = reactive({ disabled: false, appId, regions: ['NA'], mode: 'block', savedRegions: ['NA'], savedMode: 'block', ...overrides })
  app = createApp({ render: () => h(AppServingRegions, props) })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount(container)
  return props
}

function status() {
  return container.querySelector('output')?.textContent
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
  await nextTick()
}

describe('automatic serving-region settings status', () => {
  it.each([
    'https://plugin.eu.capgo.app/serving_policy/',
    'https://plugin.preprod.capgo.app/serving_policy/',
    'https://plugin.dev.capgo.app/serving_policy/',
    'http://localhost:8788/serving_policy/',
  ])('automatically checks the configured service %s without a customer action', async (baseUrl) => {
    vi.stubEnv('VITE_SERVING_POLICY_URL', baseUrl)
    const encodedApp = 'com.example.app/with space'
    fetchMock.mockResolvedValue(active(encodedApp))
    mount({ appId: encodedApp })
    await settle()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${baseUrl}com.example.app%2Fwith%20space`)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: 'no-store', signal: expect.any(AbortSignal) })
    expect(status()).toContain(messages['serving-region-status-active'])
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).not.toMatch(/publication|activation|database|replication|enforcement/i)
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('hides controls while the service cannot apply them, preserving saved choices', async () => {
    fetchMock.mockResolvedValue(Response.json({ app_id: appId, active: false }))
    const props = mount()
    await settle()
    expect(container.querySelector('[data-test="serving-regions"]')).toBeNull()
    expect(props.regions).toEqual(['NA'])
    expect(props.savedRegions).toEqual(['NA'])
    await vi.advanceTimersByTimeAsync(100000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { app_id: 'com.example.other', active: true, policy: { regions: ['NA'], mode: 'block' } },
    { app_id: appId, active: true },
    { app_id: appId, active: true, policy: { regions: ['UNKNOWN'], mode: 'block' } },
  ])('does not offer unavailable or invalid settings %#', async (body) => {
    fetchMock.mockResolvedValue(Response.json(body))
    mount()
    await settle()
    expect(container.querySelector('fieldset')).toBeNull()
    expect(status()).toBeUndefined()
  })

  it('automatically confirms pending saved choices when they take effect', async () => {
    fetchMock.mockResolvedValueOnce(active(appId, ['EU'], 'route')).mockResolvedValueOnce(active())
    mount()
    await settle()
    expect(status()).toContain(messages['serving-region-status-pending'])
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('checks saved settings rather than draft edits and automatically restarts after save', async () => {
    const props = mount()
    await settle()
    props.regions = ['EU']
    props.mode = 'route'
    await nextTick()
    expect(status()).toContain(messages['serving-region-status-unsaved'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    props.savedRegions = ['EU']
    props.savedMode = 'route'
    await settle()
    expect(status()).toContain(messages['serving-region-status-pending'])
    fetchMock.mockResolvedValueOnce(active(appId, ['EU'], 'route'))
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
  })

  it('does not label a matching draft as applied when the saved choices differ', async () => {
    fetchMock.mockResolvedValueOnce(active(appId, ['EU'], 'route'))
    mount({ regions: ['EU'], mode: 'route' })
    await settle()
    expect(status()).toContain(messages['serving-region-status-unsaved'])
    expect(status()).not.toContain(messages['serving-region-status-active'])
  })

  it('treats reordered region sets as unchanged', async () => {
    fetchMock.mockResolvedValueOnce(active(appId, ['EU', 'NA']))
    const props = mount({ regions: ['NA', 'EU'], savedRegions: ['EU', 'NA'] })
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
    props.savedRegions = ['NA', 'EU']
    await nextTick()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'])('ignores a stale app request after a newer result on %s', async (outcome) => {
    const older = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(older.promise)
    const props = mount()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    fetchMock.mockResolvedValueOnce(active('com.example.next', ['EU'], 'route'))
    props.appId = 'com.example.next'
    await settle()
    expect(signal?.aborted).toBe(true)
    expect(status()).toContain(messages['serving-region-status-pending'])
    if (outcome === 'success')
      older.resolve(active())
    else
      older.reject(new Error('Old request failed'))
    await settle()
    expect(status()).toContain(messages['serving-region-status-pending'])
  })

  it('recovers from a transient status error without asking the customer to retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Temporary network failure')).mockResolvedValueOnce(active())
    mount()
    await settle()
    expect(container.querySelector('fieldset')).toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
  })

  it('retains visible choices when a later status check fails', async () => {
    const props = mount()
    await settle()
    fetchMock.mockRejectedValueOnce(new Error('Temporary network failure'))
    props.savedMode = 'route'
    props.mode = 'route'
    await settle()
    expect(container.querySelector('fieldset')).not.toBeNull()
    expect(status()).toContain(messages['serving-region-status-unavailable'])
  })

  it('bounds retries for persistent pending settings', async () => {
    fetchMock.mockImplementation(async () => active(appId, ['EU'], 'route'))
    mount()
    await vi.advanceTimersByTimeAsync(120000)
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(status()).toContain(messages['serving-region-status-pending'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out a stalled response body and retries with no overlapping request', async () => {
    const body = Promise.withResolvers<unknown>()
    const response = new Response('{}')
    response.json = () => body.promise
    fetchMock.mockResolvedValueOnce(response).mockResolvedValueOnce(active())
    mount()
    await settle()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    await vi.advanceTimersByTimeAsync(10000)
    expect(signal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(status()).toContain(messages['serving-region-status-active'])
    body.resolve({ app_id: appId, active: false })
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
  })

  it('cancels requests and every timer on unmount', async () => {
    const stalled = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(stalled.promise)
    mount()
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    app?.unmount()
    app = undefined
    await settle()
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    stalled.resolve(active())
    await vi.advanceTimersByTimeAsync(120000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps controls disabled for callers without settings permission', async () => {
    mount({ disabled: true })
    await settle()
    expect(container.querySelector('fieldset')?.disabled).toBe(true)
  })
})
