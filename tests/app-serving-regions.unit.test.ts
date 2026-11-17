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

beforeEach(() => {
  vi.stubEnv('VITE_SERVING_POLICY_URL', 'https://plugin.eu.capgo.app/serving_policy/')
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  app?.unmount()
  app = undefined
  container.remove()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function mount() {
  const props = reactive({ disabled: false, appId: 'com.example.policy-status', regions: ['NA'], mode: 'block' })
  app = createApp({ render: () => h(AppServingRegions, props) })
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: messages } }))
  app.mount(container)
  return props
}

function check() {
  const button = container.querySelector('button')
  if (!button)
    throw new Error('Missing policy check button')
  button.click()
}

function status() {
  return container.querySelector('output')?.textContent
}

async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

describe('serving policy activation checks', () => {
  it.each([
    'https://plugin.eu.capgo.app/serving_policy/',
    'https://plugin.preprod.capgo.app/serving_policy/',
    'https://plugin.dev.capgo.app/serving_policy/',
    'http://localhost:8788/serving_policy/',
  ])('checks the configured gateway %s with no-store and an encoded app ID', async (baseUrl) => {
    vi.stubEnv('VITE_SERVING_POLICY_URL', baseUrl)
    const props = mount()
    props.appId = 'com.example.app/with space'
    await nextTick()
    fetchMock.mockResolvedValue(Response.json({ app_id: props.appId, active: false }))
    check()
    await settle()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${baseUrl}com.example.app%2Fwith%20space`)
    expect(fetchMock.mock.calls[0]?.[1]).toEqual({ cache: 'no-store' })
    expect(status()).toContain(messages['serving-region-status-pending'])
  })

  it.each(['active', 'unavailable'] as const)('ignores an older %s result after a newer pending result', async (olderResult) => {
    const props = mount()
    const older = Promise.withResolvers<Response>()
    const newer = Promise.withResolvers<Response>()
    fetchMock.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    check()
    check()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    newer.resolve(Response.json({ app_id: props.appId, active: false }))
    await settle()
    expect(status()).toContain(messages['serving-region-status-pending'])
    if (olderResult === 'active')
      older.resolve(Response.json({ app_id: props.appId, active: true, policy: { regions: ['NA'], mode: 'block' } }))
    else
      older.reject(new Error('Older request failed'))
    await settle()
    expect(status()).toContain(messages['serving-region-status-pending'])
  })

  it.each(['regions', 'mode', 'appId'] as const)('invalidates an in-flight check when %s changes', async (changed) => {
    const props = mount()
    const response = Promise.withResolvers<Response>()
    fetchMock.mockReturnValue(response.promise)
    check()
    if (changed === 'regions')
      props.regions.push('EU')
    else if (changed === 'mode')
      props.mode = 'route'
    else
      props.appId = 'com.example.other-policy-status'
    await nextTick()
    response.resolve(Response.json({ app_id: props.appId, active: true, policy: { regions: [...props.regions], mode: props.mode } }))
    await settle()
    expect(status()).toContain(messages['serving-region-status-unknown'])
  })

  it('still applies the latest matching policy and reports a current fetch failure', async () => {
    const props = mount()
    fetchMock.mockResolvedValueOnce(Response.json({ app_id: props.appId, active: true, policy: { regions: ['NA'], mode: 'block' } }))
    check()
    await settle()
    expect(status()).toContain(messages['serving-region-status-active'])
    fetchMock.mockRejectedValueOnce(new Error('Current request failed'))
    check()
    await settle()
    expect(status()).toContain(messages['serving-region-status-unavailable'])
  })
})
