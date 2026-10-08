// @vitest-environment happy-dom
import { FunctionsHttpError } from '../src/services/consoleClient'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'

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

async function mountProgress() {
  const { useAppOnboardingCliProgress } = await import('../src/composables/useAppOnboardingCliProgress')
  const host = document.createElement('div')
  const app = createApp(defineComponent({
    setup() {
      useAppOnboardingCliProgress('com.example.app', PENDING_ONBOARDING)
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
})
