// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import SimulatorSessionCard from '../src/components/dashboard/SimulatorSessionCard.vue'
import { clearSimulatorSessions, rememberSimulator, runningSimulators, simulatorConfigured } from '../src/services/simulatorSessions'

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
    simulatorConfigured.value = null
    vi.unstubAllGlobals()
    vi.useRealTimers()
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

  it('explains instead of offering start buttons when the server has no simulator host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], idle_minutes: 5, max_minutes: 40, configured: false }), { status: 200 })))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => {
      expect(container.querySelector('[data-test="simulator-not-configured"]')).not.toBeNull()
    })
    expect(container.textContent).not.toContain('start-ios-simulator')
    app.unmount()
  })

  it('shows only the explanation when a start is refused for a missing simulator host', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response(JSON.stringify({ error: 'simulator_not_configured', message: 'Simulator host missing' }), { status: 503 })
      : new Response(JSON.stringify({ data: [], idle_minutes: 5, max_minutes: 40, configured: true }), { status: 200 })))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => {
      expect(container.textContent).toContain('start-ios-simulator')
    })
    ;(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('start-ios-simulator')) as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-test="simulator-not-configured"]')).not.toBeNull()
    })
    expect(container.textContent).not.toContain('Simulator host missing')
    app.unmount()
  })

  it('keeps the explanation when an older list answer arrives after the refusal', async () => {
    let answerFirstList: (() => void) | undefined
    let lists = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ error: 'simulator_not_configured', message: 'Simulator host missing' }), { status: 503 })
      const list = new Response(JSON.stringify({ data: [], idle_minutes: 5, max_minutes: 40, configured: true }), { status: 200 })
      if (++lists > 1)
        return list
      // The first list answers only after the start was refused.
      await new Promise<void>((resolve) => {
        answerFirstList = resolve
      })
      return list
    }))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => expect(answerFirstList).toBeDefined())
    ;(Array.from(container.querySelectorAll('button')).find(button => button.textContent?.includes('start-ios-simulator')) as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-test="simulator-not-configured"]')).not.toBeNull()
    })
    answerFirstList?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(container.querySelector('[data-test="simulator-not-configured"]')).not.toBeNull()
    app.unmount()
  })

  it('keeps checking after the last stop until the list shows its build time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const last = 'bf524173-6094-4d3f-8188-50a3027f6619'
    rememberSimulator(appId, { id: last, url: 'https://ios-emulator.capgo.app/s/last/' })
    const running = { id: last, platform: 'ios', status: 'in-progress', url: 'https://ios-emulator.capgo.app/s/last/', started_at: '2026-11-09T12:00:00.000Z', finished_at: null, build_time_seconds: null, billable_seconds: null }
    const settled = { ...running, status: 'stopped', url: null, finished_at: '2026-11-09T12:07:00.000Z', build_time_seconds: 420, billable_seconds: 840 }
    let lists = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith(`/private/simulator/${last}/stop`))
        return new Response(JSON.stringify({ data: { id: last, status: 'stopped' } }), { status: 200 })
      if (url.includes('/private/simulator/?app_id=')) {
        lists++
        // The first two answers come from the cache: the session still shows running.
        return new Response(JSON.stringify({ data: [lists <= 2 ? running : settled] }), { status: 200 })
      }
      throw new Error(`unexpected ${url}`)
    }))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => expect(lists).toBe(1))
    const stop = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('stop-simulator'))
    stop?.click()
    await vi.waitFor(() => expect(lists).toBe(2))
    expect(runningSimulators(appId)).toHaveLength(0)
    expect(container.textContent).not.toContain('simulator-ran-for')
    vi.advanceTimersByTime(30_000)
    await vi.waitFor(() => expect(container.textContent).toContain('simulator-ran-for'))
    expect(runningSimulators(appId)).toHaveLength(0)
    app.unmount()
  })

  it('ignores a list answer that a newer request superseded', async () => {
    const other = 'c0635284-7105-4e4e-9299-61b4138f772a'
    const running = { id: other, platform: 'ios', status: 'in-progress', url: 'https://ios-emulator.capgo.app/s/other/', started_at: '2026-11-09T12:00:00.000Z', finished_at: null, build_time_seconds: null, billable_seconds: null }
    const settled = { ...running, status: 'stopped', url: null, finished_at: '2026-11-09T12:07:00.000Z', build_time_seconds: 420, billable_seconds: 840 }
    const answers: Array<(response: Response) => void> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/private/simulator/?app_id='))
        return new Promise<Response>(resolve => answers.push(resolve))
      throw new Error(`unexpected ${url}`)
    }))
    const container = document.createElement('div')
    const app = createApp(SimulatorSessionCard, { appId })
    app.mount(container)
    await vi.waitFor(() => expect(answers).toHaveLength(1))
    document.dispatchEvent(new Event('visibilitychange'))
    rememberSimulator(appId, { id: other, url: running.url })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    // The newer request answers first: the session stopped. The older one still says running.
    answers[1]!(new Response(JSON.stringify({ data: [settled] }), { status: 200 }))
    await vi.waitFor(() => expect(container.textContent).toContain('simulator-ran-for'))
    answers[0]!(new Response(JSON.stringify({ data: [running] }), { status: 200 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(runningSimulators(appId)).toHaveLength(0)
    expect(container.textContent).toContain('simulator-ran-for')
    app.unmount()
  })
})
