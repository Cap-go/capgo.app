// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import BuildTable from '../src/components/tables/BuildTable.vue'
import { simulatorConfigured } from '../src/services/simulatorSessions'

const mocks = vi.hoisted(() => ({ builds: [] as any[], buildQueries: 0, sendEvent: vi.fn(), push: vi.fn() }))
vi.mock('../src/services/capgoApi', () => ({ invokeCapgoApi: vi.fn(async () => ({ data: { canEnable: true }, error: null })) }))
vi.mock('../src/services/tracking', () => ({ sendEvent: mocks.sendEvent }))
vi.mock('../src/services/date', () => ({ formatDate: () => '' }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: mocks.push }) }))
vi.mock('vue-sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('../src/stores/dialogv2', () => ({ useDialogV2Store: () => ({}) }))
vi.mock('../src/stores/organization', () => ({ useOrganizationStore: () => ({ currentOrganization: { gid: 'org' }, getOrgByAppId: () => ({ paying: true }), getAppByAppId: () => ({}), awaitInitialLoad: async () => {} }) }))
vi.mock('../src/components/dashboard/BuildLiveProgress.vue', () => ({ default: defineComponent({
  props: { buildId: String, platform: String },
  emits: ['finished'],
  setup: (props, { emit, slots }) => () => h('div', { 'data-test': 'live', 'data-build': props.buildId, 'data-platform': props.platform }, [
    h('button', { 'data-test': 'live-finish', 'onClick': () => emit('finished', 'success') }),
    slots['success-actions']?.(),
  ]),
}) }))
vi.mock('../src/services/console', () => ({
  defaultApiHost: 'https://api.example.test',
  useConsole: () => ({
    auth: { getSession: async () => ({ data: { session: { access_token: 'token' } } }) },
    from: (table: string) => {
      let head = false
      const query: any = {
        then: (resolve: (data: unknown) => void) => {
          if (table === 'build_requests' && !head)
            mocks.buildQueries++
          const data = table === 'build_requests' ? mocks.builds : []
          return Promise.resolve({ data, count: mocks.builds.length, error: null }).then(resolve)
        },
        select: (_columns: string, options?: { head?: boolean }) => {
          head = options?.head === true
          return query
        },
      }
      for (const method of ['eq', 'in', 'order', 'range', 'or'])
        query[method] = () => query
      return query
    },
  }),
}))

const succeeded = { id: 'b1', platform: 'ios', status: 'succeeded', builder_job_id: 'job_1', created_at: '2026-11-16T10:00:00Z', last_error: null }
const running = { id: 'b2', platform: 'android', status: 'running', builder_job_id: 'job_2', created_at: '2026-11-17T10:00:00Z', last_error: null }

const cleanups: Array<() => void> = []
function mount() {
  const host = document.createElement('div')
  const app = createApp(defineComponent({ setup: () => () => h(BuildTable, { appId: 'com.example.app' }) }))
  app.component('StepsBuild', { render: () => h('div') })
  // Renders each row as a button using the first column's click, and the saved-build cell.
  app.component('DataTable', defineComponent({
    props: { columns: { type: Array, default: () => [] }, elementList: { type: Array, default: () => [] } },
    setup: props => () => h('div', { 'data-test': 'table' }, (props.elementList as any[]).map((elem) => {
      const columns = props.columns as any[]
      const artifact = columns.find(col => col.key === 'artifact')
      return h('div', [
        h('button', { 'data-test': `row-${elem.id}`, 'onClick': () => columns[0].onClick(elem) }),
        artifact.renderFunction(elem),
      ])
    })),
  }))
  app.mount(host)
  cleanups.push(() => app.unmount())
  return host
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.buildQueries = 0
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: { job_1: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } }), { status: 200 })))
})
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  simulatorConfigured.value = null
})

describe('builds table after a successful build', () => {
  it('opens a build row in the live progress view and tracks it', async () => {
    mocks.builds = [succeeded]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b1"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b1"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')?.getAttribute('data-build')).toBe('b1'))
    expect(host.querySelector('[data-test="table"]')).toBeNull()
    expect(mocks.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'Build Row Opened', nonPersonTags: expect.objectContaining({ status: 'succeeded', platform: 'ios' }) }))
  })

  it('offers a download button for a saved build and next steps until dismissed', async () => {
    mocks.builds = [succeeded]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
    expect(host.querySelector('[data-test="build-next-steps-simulator"]')).not.toBeNull()
    ;(host.querySelector('[data-test="build-next-steps-live-updates"]') as HTMLButtonElement).click()
    expect(mocks.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'Build Next Step Clicked', nonPersonTags: expect.objectContaining({ action: 'live_updates' }) }))
    expect(mocks.push).toHaveBeenCalledWith({ path: '/app/com.example.app/getting-started', query: { showChecklist: '1' } })
    ;(host.querySelector('[data-test="build-next-steps-dismiss"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-next-steps"]')).toBeNull())
    cleanups.splice(0).forEach(cleanup => cleanup())
    const again = mount()
    await vi.waitFor(() => expect(again.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
    expect(again.querySelector('[data-test="build-next-steps"]')).toBeNull()
  })

  it('explains a succeeded build without a saved file', async () => {
    mocks.builds = [succeeded]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-not-saved"]')).not.toBeNull())
  })

  it('refreshes by itself while a build runs, and stops once none does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    const before = mocks.buildQueries
    mocks.builds = [{ ...running, status: 'succeeded' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(mocks.buildQueries).toBe(before + 1))
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-next-steps"]')).not.toBeNull())
    vi.advanceTimersByTime(30_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.buildQueries).toBe(before + 1)
  })

  it('pauses the table refresh while a build view is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    const before = mocks.buildQueries
    vi.advanceTimersByTime(30_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.buildQueries).toBe(before)
  })

  it('does not call a newly succeeded build unsaved before its lookup answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      answer = resolve
    })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    mocks.builds = [{ ...running, status: 'succeeded' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.querySelector('[data-test="saved-build-not-saved"]')).toBeNull()
    answer(new Response(JSON.stringify({ outputs: {} }), { status: 200 }))
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-not-saved"]')).not.toBeNull())
  })

  it('stops offering the simulator once the server says it has none', async () => {
    mocks.builds = [succeeded]
    vi.stubGlobal('open', vi.fn(() => ({ close: vi.fn(), location: { replace: vi.fn() } })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-next-steps-simulator"]')).not.toBeNull())
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: 'simulator_not_configured', message: 'Simulator is not configured.' }), { status: 503 }))
    ;(host.querySelector('[data-test="build-next-steps-simulator"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-next-steps-simulator"]')).toBeNull())
    expect(host.querySelector('[data-test="saved-build-simulator"]')).toBeNull()
    expect(host.textContent).toContain('simulator-not-configured-hint')
  })

  it('offers the simulator once a build watched in its view succeeds', async () => {
    mocks.builds = [{ ...running, platform: 'ios' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: mocks.builds[0].status === 'succeeded' ? { job_2: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } : {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    expect(host.querySelector('[data-test="build-detail-simulator"]')).toBeNull()
    mocks.builds = [{ ...running, platform: 'ios', status: 'succeeded' }]
    ;(host.querySelector('[data-test="live-finish"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-detail-simulator"]')).not.toBeNull())
  })
})
