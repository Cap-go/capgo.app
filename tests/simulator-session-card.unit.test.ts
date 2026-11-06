// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import SimulatorSessionCard from '../src/components/dashboard/SimulatorSessionCard.vue'
import { clearSimulatorSessions, rememberSimulator, runningSimulators } from '../src/services/simulatorSessions'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
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
})
