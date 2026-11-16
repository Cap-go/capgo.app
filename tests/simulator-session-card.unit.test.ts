// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import SimulatorSessionCard from '../src/components/dashboard/SimulatorSessionCard.vue'
import { clearSimulatorSessions, rememberSimulator, runningSimulators } from '../src/services/simulatorSessions'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('~icons/lucide/smartphone', () => ({ default: { name: 'IconSmartphone', setup: () => () => null } }))
vi.mock('~/services/date', () => ({ formatLocalDateTime: (value: string | null) => value ?? '' }))
vi.mock('~/services/console', () => ({
  defaultApiHost: 'https://api.example.test',
  useConsole: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'token' } } }),
    },
  }),
}))

const appId = 'ee.forgr.refresh'
const gone = '6a0d9c2e-1b4f-4e8a-9c33-0b7e5d2a11c4'
const missing = '7b1e0d3f-2c50-4f9b-8d44-1c8f6e3b22d5'
const stopped = '8c2f1e40-3d61-40ac-9e55-2d907f4c33e6'
const offline = '9d302f51-4e72-41bd-af66-3ea1805d44f7'

describe('simulator card refresh', () => {
  afterEach(() => {
    clearSimulatorSessions()
    vi.unstubAllGlobals()
  })

  it('removes a missing or stopped session and keeps one whose lookup fails', async () => {
    rememberSimulator(appId, { id: gone, url: 'https://ios-emulator.capgo.app/s/gone/' })
    rememberSimulator(appId, { id: missing, url: 'https://ios-emulator.capgo.app/s/missing/' })
    rememberSimulator(appId, { id: stopped, url: 'https://ios-emulator.capgo.app/s/stopped/' })
    rememberSimulator(appId, { id: offline, url: 'https://ios-emulator.capgo.app/s/offline/' })
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(gone))
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 400 })
      if (url.includes(missing))
        return new Response('{}', { status: 404 })
      if (url.includes(stopped))
        return new Response(JSON.stringify({ data: { status: 'stopped' } }), { status: 200 })
      throw new Error('offline')
    }))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => {
      expect(runningSimulators(appId).map(session => session.id)).toEqual([offline])
    })
    app.unmount()
  })

  it('lists recent simulators with the build time they counted and drops one that stopped by itself', async () => {
    const idle = 'ae413062-5f83-42ce-b077-4fb2916e5508'
    rememberSimulator(appId, { id: idle, url: 'https://ios-emulator.capgo.app/s/idle/' })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/private/simulator/?app_id='))
        return new Response(JSON.stringify({
          data: [{ id: idle, platform: 'ios', status: 'stopped', url: null, started_at: '2026-11-09T12:00:00.000Z', finished_at: '2026-11-09T12:07:00.000Z', build_time_seconds: 420, billable_seconds: 840 }],
          idle_minutes: 5,
          max_minutes: 40,
        }), { status: 200 })
      throw new Error(`unexpected ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('simulator-recent')
    })
    expect(runningSimulators(appId)).toHaveLength(0)
    expect(container.textContent).toContain('simulator-auto-stop')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    app.unmount()
  })
})
