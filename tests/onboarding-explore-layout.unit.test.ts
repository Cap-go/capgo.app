// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import DashboardLayout from '../src/layouts/default.vue'

const state = vi.hoisted(() => ({
  organizations: [] as { gid: string, app_count: number }[],
  indexedApps: [] as { app_id: string }[],
  route: { path: '/app/com.example.pending', params: { app: 'com.example.pending' } },
  app: { app_id: 'com.example.pending', need_onboarding: true },
  from: vi.fn(),
  eq: vi.fn(),
}))

vi.mock('vue-router', () => ({ useRoute: () => state.route }))
vi.mock('~/services/console', () => ({
  useConsole: () => ({ from: state.from }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => ({ user: { id: 'example-user' } }) }))
vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: () => false,
  useOrganizationStore: () => ({
    get organizations() { return state.organizations },
    awaitInitialLoad: async () => undefined,
    getAppsByOrgId: () => state.indexedApps,
  }),
}))
vi.mock('~/composables/useNativeChrome', () => ({
  isNativeChromeEnabled: false,
  useNativeChrome: () => ({ goBack: vi.fn(), canGoBack: false }),
}))
vi.mock('~/composables/useEdgeSwipeBack', () => ({ useEdgeSwipeBack: vi.fn() }))
vi.mock('~/composables/useRealtimeCLIFeed', () => ({ useRealtimeCLIFeed: vi.fn() }))
vi.mock('~/components/dashboard/OnboardingExploreBanner.vue', () => ({
  default: { props: ['appId'], template: '<div data-test="explore-banner">{{ appId }}</div>' },
}))
vi.mock('~/components/dashboard/OnboardingExploreReminder.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/dashboard/PastDueBanner.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/dashboard/TrialCardPrompt.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/assistant/AssistantChat.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/LogAsDialogField.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/Navbar.vue', () => ({ default: { render: () => null } }))
vi.mock('~/components/Sidebar.vue', () => ({ default: { render: () => null } }))

let mountedApp: ReturnType<typeof createApp> | undefined

afterEach(() => {
  mountedApp?.unmount()
  mountedApp = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  vi.clearAllMocks()
})

describe('dashboard exploration banner eligibility', () => {
  it.each([
    { scenario: 'first app created in this session', orgCount: 1, cachedCount: 0, indexedCount: 1, liveCount: 1, show: true },
    { scenario: 'one pending app after reload', orgCount: 1, cachedCount: 1, indexedCount: 1, liveCount: 1, show: true },
    { scenario: 'sole org app differs from the route app', orgCount: 1, cachedCount: 1, indexedCount: 1, liveCount: 1, routeAppId: 'com.example.different', show: false },
    { scenario: 'one remaining app after deletion with a stale index', orgCount: 1, cachedCount: 1, indexedCount: 2, liveCount: 1, show: true },
    { scenario: 'second app created in this session', orgCount: 1, cachedCount: 1, indexedCount: 2, liveCount: 2, show: false },
    { scenario: 'second app before the index refreshes', orgCount: 1, cachedCount: 1, indexedCount: 1, liveCount: 2, show: false },
    { scenario: 'no apps after deletion', orgCount: 1, cachedCount: 0, indexedCount: 1, liveCount: 0, show: false },
    { scenario: 'multiple organizations with a route app', orgCount: 2, cachedCount: 1, indexedCount: 1, liveCount: 1, show: false },
    { scenario: 'multiple apps with a route app', orgCount: 1, cachedCount: 2, indexedCount: 2, liveCount: 2, show: false },
    { scenario: 'org count includes an app absent from the index', orgCount: 1, cachedCount: 2, indexedCount: 1, liveCount: 2, show: false },
  ])('$scenario', async ({ orgCount, cachedCount, indexedCount, liveCount, routeAppId = state.app.app_id, show }) => {
    state.route = { path: `/app/${routeAppId}`, params: { app: routeAppId } }
    state.organizations = Array.from({ length: orgCount }, (_, i) => ({ gid: `example-org-${i}`, app_count: cachedCount }))
    state.indexedApps = Array.from({ length: indexedCount }, (_, i) => ({ app_id: `com.example.app${i}` }))
    const limit = vi.fn(async () => ({
      data: Array.from({ length: liveCount }, (_, i) => ({ ...state.app, app_id: i === 0 ? state.app.app_id : `com.example.other${i}` })),
      error: null,
    }))
    const query = {
      select: () => query,
      eq: state.eq.mockImplementation(() => query),
      limit,
    }
    state.from.mockReturnValue(query)

    const container = document.createElement('div')
    document.body.appendChild(container)
    mountedApp = createApp(DashboardLayout)
    mountedApp.component('RouterView', { render: () => null })
    mountedApp.mount(container)
    await new Promise(resolve => setTimeout(resolve, 0))
    await nextTick()

    expect(container.querySelector('[data-test="explore-banner"]')?.textContent ?? null).toBe(show ? state.app.app_id : null)
    const lookupExpected = orgCount === 1 && cachedCount <= 1
    expect(state.from).toHaveBeenCalledTimes(lookupExpected ? 1 : 0)
    if (lookupExpected) {
      expect(state.eq).toHaveBeenCalledWith('owner_org', 'example-org-0')
      expect(limit).toHaveBeenCalledWith(2)
    }
  })
})
