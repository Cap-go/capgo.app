// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import BuildTable from '../src/components/tables/BuildTable.vue'
import { simulatorConfigured } from '../src/services/simulatorSessions'

const mocks = vi.hoisted(() => ({ builds: [] as any[], listed: undefined as any[] | undefined, buildQueries: 0, failBuilds: false, gate: undefined as Promise<void> | undefined, sendEvent: vi.fn(), push: vi.fn() }))
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
      let byId: string | undefined
      const query: any = {
        then: (resolve: (data: unknown) => void) => {
          const listing = table === 'build_requests' && !head && !byId
          if (listing)
            mocks.buildQueries++
          // A search or another page can leave builds out of the listing (mocks.listed).
          const data = table !== 'build_requests' ? [] : byId ? mocks.builds.find(build => build.id === byId) ?? null : mocks.listed ?? mocks.builds
          return (listing && mocks.gate ? mocks.gate : Promise.resolve()).then(() => listing && mocks.failBuilds ? { data: null, count: null, error: { message: 'down' } } : { data, count: mocks.builds.length, error: null }).then(resolve)
        },
        select: (_columns: string, options?: { head?: boolean }) => {
          head = options?.head === true
          return query
        },
      }
      for (const method of ['in', 'order', 'range', 'or', 'maybeSingle'])
        query[method] = () => query
      query.eq = (column: string, value: string) => {
        if (column === 'id')
          byId = value
        return query
      }
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
    emits: ['reload'],
    setup: (props, { emit }) => () => h('div', { 'data-test': 'table' }, [h('button', { 'data-test': 'table-reload', 'onClick': () => emit('reload') }), ...(props.elementList as any[]).map((elem) => {
      const columns = props.columns as any[]
      const artifact = columns.find(col => col.key === 'artifact')
      return h('div', [
        h('button', { 'data-test': `row-${elem.id}`, 'onClick': () => columns[0].onClick(elem) }),
        h('div', { 'data-test': `artifact-${elem.id}`, 'onClick': () => artifact.onClick?.(elem) }, [artifact.renderFunction(elem)]),
      ])
    })]),
  }))
  app.mount(host)
  cleanups.push(() => app.unmount())
  return host
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.buildQueries = 0
  mocks.listed = undefined
  mocks.gate = undefined
  mocks.failBuilds = false
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
    // The saved-build cell opens the build like the rest of the row.
    ;(host.querySelector('[data-test="saved-build-not-saved"]') as HTMLElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
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

  it('pauses the table refresh while a finished build view is open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running, succeeded]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b1"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b1"]') as HTMLButtonElement).click()
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

  it('follows the opened build when the refreshed listing leaves it out', async () => {
    mocks.builds = [{ ...running, platform: 'ios' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: mocks.builds[0].status === 'succeeded' ? { job_2: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } : {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    // A search for "running" no longer lists the build once it succeeded.
    mocks.builds = [{ ...running, platform: 'ios', status: 'succeeded' }]
    mocks.listed = []
    ;(host.querySelector('[data-test="live-finish"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-detail-simulator"]')).not.toBeNull())
  })

  it('asks for the opened build\'s saved output even when the listing fills the lookup', async () => {
    const page = Array.from({ length: 20 }, (_, index) => ({ ...succeeded, id: `p${index}`, builder_job_id: `job_p${index}`, created_at: `2026-11-1${index % 10}T10:00:00Z` }))
    mocks.builds = [{ ...running, platform: 'ios' }, ...page]
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ outputs: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    // The build succeeds and drops to the next page behind 20 succeeded builds.
    mocks.builds = [{ ...running, platform: 'ios', status: 'succeeded' }, ...page]
    mocks.listed = page
    ;(host.querySelector('[data-test="live-finish"]') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0] ?? '')
      const ids = decodeURIComponent(url.split('job_ids=')[1] ?? '').split(',')
      // The backend reads only the first 20 job ids.
      expect(ids.slice(0, 20)).toContain('job_2')
    })
  })

  it('keeps refreshing an opened build the listing leaves out until its row ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [{ ...running, platform: 'ios' }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: mocks.builds[0].status === 'succeeded' ? { job_2: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } : {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    // The stream reports success while the row still says running, and a search hides the build.
    mocks.listed = []
    ;(host.querySelector('[data-test="live-finish"]') as HTMLButtonElement).click()
    await new Promise(resolve => setTimeout(resolve, 0))
    mocks.builds = [{ ...running, platform: 'ios', status: 'succeeded' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-detail-simulator"]')).not.toBeNull())
  })

  it('offers the simulator when the row ends after the build view saw the success', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const queued = { ...running, platform: 'ios', status: 'pending', builder_job_id: null }
    mocks.builds = [queued]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: mocks.builds[0].status === 'succeeded' ? { job_2: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } : {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    ;(host.querySelector('[data-test="row-b2"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="live"]')).not.toBeNull())
    // The stream reports success while the row still says running.
    mocks.builds = [{ ...queued, status: 'running', builder_job_id: 'job_2' }]
    ;(host.querySelector('[data-test="live-finish"]') as HTMLButtonElement).click()
    await new Promise(resolve => setTimeout(resolve, 0))
    mocks.builds = [{ ...queued, status: 'succeeded', builder_job_id: 'job_2' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(host.querySelector('[data-test="build-detail-simulator"]')).not.toBeNull())
  })

  it('does not offer the simulator for an expired saved build', async () => {
    mocks.builds = [succeeded]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: { job_1: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2000-01-01T00:00:00Z' } } }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-expired"]')).not.toBeNull())
    expect(host.querySelector('[data-test="build-next-steps"]')).not.toBeNull()
    expect(host.querySelector('[data-test="build-next-steps-simulator"]')).toBeNull()
  })

  it('asks for saved builds again after a failed lookup', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running, succeeded]
    const saved = () => new Response(JSON.stringify({ outputs: { job_1: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } } }), { status: 200 })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(saved())
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => saved())
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
    ;(host.querySelector('[data-test="table-reload"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.querySelector('[data-test="saved-build-not-saved"]')).toBeNull()
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
  })

  it('waits for a slow refresh before polling again', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    let release: () => void = () => {}
    mocks.gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const before = mocks.buildQueries
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(mocks.buildQueries).toBe(before + 1))
    vi.advanceTimersByTime(30_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.buildQueries).toBe(before + 1)
    mocks.gate = undefined
    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(mocks.buildQueries).toBe(before + 2))
  })

  it('retries a failed saved-output lookup after the last build ended', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(async () => new Response(JSON.stringify({ outputs: { job_2: { url: 'https://dl.example.test/app.apk', kind: 'android_apk', expires_at: '2999-01-01T00:00:00Z' } } }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    mocks.builds = [{ ...running, status: 'succeeded' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
    const calls = fetchMock.mock.calls.length
    vi.advanceTimersByTime(30_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchMock.mock.calls.length).toBe(calls)
  })

  it('asks again for a build whose builder lookup failed instead of calling it not saved', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [succeeded]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ outputs: {}, failed: ['job_1'] }), { status: 200 }))
      .mockImplementation(async () => new Response(JSON.stringify({ outputs: { job_1: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } }, failed: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(host.querySelector('[data-test="saved-build-not-saved"]')).toBeNull()
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
  })

  it('starts the retries over when a reload fails again after they ran out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [succeeded]
    const partial = () => new Response(JSON.stringify({ outputs: {}, failed: ['job_1'] }), { status: 200 })
    let builderUp = false
    const fetchMock = vi.fn(async () => builderUp
      ? new Response(JSON.stringify({ outputs: { job_1: { url: 'https://dl.example.test/app.ipa', kind: 'ios_ipa', expires_at: '2999-01-01T00:00:00Z' } }, failed: [] }), { status: 200 })
      : partial())
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    for (let tick = 0; tick < 5; tick++) {
      vi.advanceTimersByTime(10_000)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    const exhausted = fetchMock.mock.calls.length
    vi.advanceTimersByTime(30_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(fetchMock.mock.calls.length).toBe(exhausted)
    ;(host.querySelector('[data-test="table-reload"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(exhausted + 1))
    await new Promise(resolve => setTimeout(resolve, 0))
    builderUp = true
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
  })

  it('offers build details instead of a download when no file is saved', async () => {
    mocks.builds = [succeeded]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ outputs: {} }), { status: 200 })))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-not-saved"]')).not.toBeNull())
    const action = host.querySelector('[data-test="build-next-steps-install"]') as HTMLButtonElement
    expect(action.textContent).toContain('build-next-steps-view')
    action.click()
    expect(mocks.sendEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'Build Next Step Clicked', nonPersonTags: expect.objectContaining({ action: 'details' }) }))
  })

  it('stops recovering saved outputs after a few ticks even when the builds query fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    mocks.builds = [running]
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    mocks.builds = [{ ...running, status: 'succeeded' }]
    vi.advanceTimersByTime(10_000)
    await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1))
    await new Promise(resolve => setTimeout(resolve, 0))
    mocks.failBuilds = true
    const beforeRecovery = mocks.buildQueries
    for (let tick = 0; tick < 6; tick++) {
      vi.advanceTimersByTime(10_000)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    expect(mocks.buildQueries).toBe(beforeRecovery + 3)
    vi.advanceTimersByTime(60_000)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.buildQueries).toBe(beforeRecovery + 3)
  })

  it('recovers saved outputs again for a later build after an earlier recovery gave up', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const tick = async () => {
      vi.advanceTimersByTime(10_000)
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    mocks.builds = [running]
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    mocks.builds = [{ ...running, status: 'succeeded' }]
    for (let i = 0; i < 6; i++)
      await tick()
    const next = { ...running, id: 'b3', builder_job_id: 'job_3' }
    mocks.builds = [next, { ...running, status: 'succeeded' }]
    ;(host.querySelector('[data-test="table-reload"]') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b3"]')).not.toBeNull())
    await tick()
    mocks.builds = [{ ...next, status: 'succeeded' }, { ...running, status: 'succeeded' }]
    await tick()
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ outputs: { job_3: { url: 'https://dl.example.test/app.apk', kind: 'android_apk', expires_at: '2999-01-01T00:00:00Z' } } }), { status: 200 }))
    await tick()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
  })

  it('re-arms recovery when a reload finds a running build, even if it ends before the next tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const tick = async () => {
      vi.advanceTimersByTime(10_000)
      await new Promise(resolve => setTimeout(resolve, 0))
      await new Promise(resolve => setTimeout(resolve, 0))
    }
    mocks.builds = [running]
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)
    const host = mount()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b2"]')).not.toBeNull())
    mocks.builds = [{ ...running, status: 'succeeded' }]
    for (let i = 0; i < 6; i++)
      await tick()
    const reload = () => (host.querySelector('[data-test="table-reload"]') as HTMLButtonElement).click()
    const next = { ...running, id: 'b3', builder_job_id: 'job_3' }
    mocks.builds = [next, { ...running, status: 'succeeded' }]
    reload()
    await vi.waitFor(() => expect(host.querySelector('[data-test="row-b3"]')).not.toBeNull())
    mocks.builds = [{ ...next, status: 'succeeded' }, { ...running, status: 'succeeded' }]
    const lookups = fetchMock.mock.calls.length
    reload()
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBe(lookups + 1))
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ outputs: { job_3: { url: 'https://dl.example.test/app.apk', kind: 'android_apk', expires_at: '2999-01-01T00:00:00Z' } } }), { status: 200 }))
    await new Promise(resolve => setTimeout(resolve, 0))
    await tick()
    await vi.waitFor(() => expect(host.querySelector('[data-test="saved-build-download"]')).not.toBeNull())
  })
})
