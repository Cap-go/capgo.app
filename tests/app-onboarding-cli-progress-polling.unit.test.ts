// @vitest-environment happy-dom
import { FunctionsHttpError } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { APP_ONBOARDING_OTA_V1_STEP_IDS } from '../src/services/appOnboarding'

const invokeCapgoApiMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/capgoApi', () => ({
  invokeCapgoApi: invokeCapgoApiMock,
}))

const PENDING_ONBOARDING = {
  version: 3,
  flow: 'ota',
  outcome: 'pending',
  steps: {},
}

async function mountProgress(initialOnboarding: unknown = PENDING_ONBOARDING, active = ref(true)) {
  const { useAppOnboardingCliProgress } = await import('../src/composables/useAppOnboardingCliProgress')
  const host = document.createElement('div')
  const app = createApp(defineComponent({
    setup() {
      useAppOnboardingCliProgress('com.example.app', initialOnboarding, active)
      return () => h('div')
    },
  }))
  app.mount(host)
  return app
}

async function flushRequests() {
  for (let i = 0; i < 5; i++)
    await Promise.resolve()
}

describe('useAppOnboardingCliProgress polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invokeCapgoApiMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([403, 404])('stops polling after a %i response', async (status) => {
    invokeCapgoApiMock.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('{}', { status })) })

    const app = await mountProgress()
    await flushRequests()
    expect(invokeCapgoApiMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(invokeCapgoApiMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })

  it('keeps polling after a transient server error', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response('{}', { status: 503 })) })

    const app = await mountProgress()
    await vi.advanceTimersByTimeAsync(6_000)

    expect(invokeCapgoApiMock.mock.calls.length).toBeGreaterThan(1)
    app.unmount()
  })

  it('pauses hidden panels and refreshes when they become active again', async () => {
    invokeCapgoApiMock.mockResolvedValue({ data: { onboarding: PENDING_ONBOARDING }, error: null })
    const active = ref(false)
    const app = await mountProgress(PENDING_ONBOARDING, active)
    await vi.advanceTimersByTimeAsync(6_000)
    expect(invokeCapgoApiMock).not.toHaveBeenCalled()
    active.value = true
    await nextTick()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(invokeCapgoApiMock.mock.calls.length).toBeGreaterThan(1)
    active.value = false
    await nextTick()
    const calls = invokeCapgoApiMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(invokeCapgoApiMock).toHaveBeenCalledTimes(calls)
    app.unmount()
  })

  it('uses OTA steps for terminal polling in dual setup instead of the shared completion summary', async () => {
    const onboarding = { setup: {
      todo_list_version: 4,
      ota_todo_list_version: '1',
      builder_todo_list_version: '1',
      paths: ['ota', 'builder'],
      outcome: 'completed',
      steps: { ota: Object.fromEntries(APP_ONBOARDING_OTA_V1_STEP_IDS.map(id => [id, { status: 'pending' }])) },
    } }
    invokeCapgoApiMock.mockImplementation(async () => ({ data: { onboarding: structuredClone(onboarding) }, error: null }))
    const app = await mountProgress(onboarding)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(invokeCapgoApiMock.mock.calls.length).toBeGreaterThan(1)
    for (const step of Object.values(onboarding.setup.steps.ota))
      step.status = 'done'
    await vi.advanceTimersByTimeAsync(2_000)
    const calls = invokeCapgoApiMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(6_000)
    expect(invokeCapgoApiMock).toHaveBeenCalledTimes(calls)
    app.unmount()
  })
})
