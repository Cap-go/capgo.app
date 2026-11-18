// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import SimulatorSessionCard from '../src/components/dashboard/SimulatorSessionCard.vue'
import { clearSimulatorSessions, rememberSimulator, runningSimulators } from '../src/services/simulatorSessions'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('~/services/date', () => ({ formatLocalDateTime: (value: string | null) => value ?? '' }))
vi.mock('~icons/lucide/smartphone', () => ({ default: { name: 'IconSmartphone', setup: () => () => null } }))
vi.mock('~/services/console', () => ({
  defaultApiHost: 'https://api.example.test',
  useConsole: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token' } } }),
    },
  }),
}))

const appId = 'ee.forgr.refresh'
const sessionId = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'

describe('simulator session card polling', () => {
  afterEach(() => {
    clearSimulatorSessions()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('polls session status on mount and on the interval without activity heartbeats', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/activity'))
        throw new Error('console must not heartbeat simulator activity')
      if (url.includes('/private/simulator/?'))
        return new Response(JSON.stringify({ data: [{ id: sessionId, platform: 'ios', status: 'in-progress', url: 'https://ios-emulator.capgo.app/s/x/', started_at: null, finished_at: null, build_time_seconds: null, billable_seconds: null }] }), { status: 200 })
      return new Response(JSON.stringify({ data: { status: 'in-progress' } }), { status: 200 })
    })
    const privateCalls = () => fetchMock.mock.calls.filter(call => String(call[0]).includes('/private/simulator/'))
    vi.stubGlobal('fetch', fetchMock)
    rememberSimulator(appId, { id: sessionId, url: 'https://ios-emulator.capgo.app/s/x/' })
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => expect(privateCalls().length).toBeGreaterThanOrEqual(1))
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(privateCalls().length).toBeGreaterThanOrEqual(2))
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes('/activity'))).toBe(false)
    app.unmount()
    expect(runningSimulators(appId)).toHaveLength(1)
  })
})