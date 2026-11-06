import { beforeEach, describe, expect, it, vi } from 'vitest'

// The auth guard reuses a recent "account is active" answer between navigations so each page
// change does not wait on an is_account_disabled round trip. A disabled answer is never reused.

const user = {
  id: 'user-active-cache',
  email: 'account-status@example.com',
  email_confirmed_at: '2026-04-15T10:00:00.000Z',
  app_metadata: { provider: 'email', providers: ['email'] },
}

const state = {
  disabled: false,
  failing: false,
}

const rpc = vi.fn(async (name: string) => {
  if (name === 'is_account_disabled')
    return state.failing ? { data: null, error: { message: 'temporarily unavailable' } } : { data: state.disabled, error: null }
  return { data: null, error: null }
})

const mainStore = {
  auth: undefined as any,
  user: { id: user.id, email: user.email, first_name: 'Example', last_name: 'User', onboarding: { profile_completed_at: '2026-10-20T10:00:00.000Z' } } as any,
  isAdmin: false,
  plans: [{ name: 'Solo' }] as any[],
  resolvePlatformAdminStatus: vi.fn(async () => false),
}

const organizationStore = {
  organizations: [{ gid: 'org-active-cache', role: 'admin' }],
  hasOrganizations: true,
  fetchOrganizations: vi.fn(async () => {}),
  dedupFetchOrganizations: vi.fn(async () => {}),
}

vi.mock('~/services/loader', () => ({ hideLoader: vi.fn() }))
vi.mock('~/services/posthog', () => ({ setUser: vi.fn() }))
vi.mock('~/services/storage', () => ({ createSignedImageUrl: vi.fn(), getImmediateImageUrl: (value?: string | null) => value ?? '' }))
vi.mock('~/services/tracking', () => ({ sendEvent: vi.fn(async () => {}) }))
vi.mock('~/services/websiteAuthCookie', () => ({ clearWebsitePaidUserCookie: vi.fn(), setWebsitePaidUserCookie: vi.fn() }))
vi.mock('~/services/signupAttribution', () => ({ applySignupAttributionToPostHog: vi.fn() }))
vi.mock('~/services/console', () => ({
  getLocalConfig: () => ({ apiHost: 'https://api.example.com' }),
  getPlans: vi.fn(async () => []),
  defaultApiHost: 'https://api.example.com',
  useConsole: () => ({
    auth: {
      getClaims: vi.fn(async () => ({ data: { claims: { sub: user.id } } })),
      getSession: vi.fn(async () => ({ data: { session: { access_token: 'token', user } } })),
      mfa: { getAuthenticatorAssuranceLevel: vi.fn(async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null })) },
      onAuthStateChange: vi.fn(),
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc,
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: mainStore.user, error: null }) }) }) })),
  }),
}))
vi.mock('~/stores/main', () => ({ useMainStore: () => mainStore }))
vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: () => false,
  useOrganizationStore: () => organizationStore,
}))

const DASHBOARD_ROUTE = { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} }
const APPS_ROUTE = { path: '/apps', fullPath: '/apps', meta: { middleware: 'auth' }, query: {} }

async function getGuard() {
  const router = { beforeEach: vi.fn() }
  const { install } = await import('../src/modules/auth.ts')
  install({ router } as any)
  return router.beforeEach.mock.calls[0][0] as (to: any, from: any, next: (target?: unknown) => void) => Promise<void>
}

function disabledChecks() {
  return rpc.mock.calls.filter(([name]) => name === 'is_account_disabled').length
}

describe('auth guard account status cache', () => {
  beforeEach(() => {
    vi.resetModules()
    rpc.mockClear()
    state.disabled = false
    state.failing = false
    mainStore.auth = { ...user }
  })

  it('checks the account once, then reuses the active answer on the next navigations', async () => {
    const guard = await getGuard()

    await guard(DASHBOARD_ROUTE, APPS_ROUTE, vi.fn())
    await guard(APPS_ROUTE, DASHBOARD_ROUTE, vi.fn())
    await guard(DASHBOARD_ROUTE, APPS_ROUTE, vi.fn())

    expect(disabledChecks()).toBe(1)
  })

  it('never reuses a disabled answer, so a restored account is seen on the next navigation', async () => {
    const guard = await getGuard()
    state.disabled = true
    const firstNext = vi.fn()
    await guard(DASHBOARD_ROUTE, APPS_ROUTE, firstNext)
    expect(firstNext).toHaveBeenCalledWith(expect.objectContaining({ path: '/accountDisabled' }))

    state.disabled = false
    const secondNext = vi.fn()
    await guard(DASHBOARD_ROUTE, APPS_ROUTE, secondNext)

    expect(disabledChecks()).toBe(2)
    expect(secondNext).toHaveBeenCalledWith()
  })

  it('does not reuse a failed check as an active answer', async () => {
    const guard = await getGuard()
    state.failing = true
    const firstNext = vi.fn()
    await guard(DASHBOARD_ROUTE, APPS_ROUTE, firstNext)
    // Same as before this cache: a failed check lets the navigation through.
    expect(firstNext).toHaveBeenCalledWith()

    state.failing = false
    state.disabled = true
    const secondNext = vi.fn()
    await guard(APPS_ROUTE, DASHBOARD_ROUTE, secondNext)

    expect(disabledChecks()).toBe(2)
    expect(secondNext).toHaveBeenCalledWith(expect.objectContaining({ path: '/accountDisabled' }))
  })

  it('always asks the API when opening the account disabled page', async () => {
    const guard = await getGuard()
    await guard(DASHBOARD_ROUTE, APPS_ROUTE, vi.fn())
    await guard({ path: '/accountDisabled', fullPath: '/accountDisabled', meta: { middleware: 'auth' }, query: {} }, DASHBOARD_ROUTE, vi.fn())

    expect(disabledChecks()).toBe(2)
  })
})
