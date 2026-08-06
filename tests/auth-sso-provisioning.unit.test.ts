import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'
import { allowOnboardingDashboardExploration } from '../src/utils/onboardingRedirect'

interface MockFetchResponse {
  ok: boolean
  json: () => Promise<Record<string, unknown>>
}

function createUsersQuery(userRecord: Record<string, unknown>) {
  const query = {
    limit: vi.fn(async () => ({
      data: [],
      error: null,
    })),
    maybeSingle: vi.fn(async () => ({
      data: userRecord,
      error: null,
    })),
  }

  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => query),
    })),
  }
}

function createTestContext() {
  const userRecord = {
    id: 'user-123',
    email: 'user@managed.test',
    first_name: 'Managed',
    last_name: 'User',
    image_url: null,
  }

  const mainStore = {
    auth: undefined as any,
    user: undefined as any,
    isAdmin: false,
    plans: [] as any[],
  }

  const organizationStore = {
    organizations: [] as Array<{ gid: string, role: string }>,
    hasOrganizations: false,
    fetchOrganizations: vi.fn(async () => {
      organizationStore.organizations = [{ gid: 'org-123', role: 'read' }]
      organizationStore.hasOrganizations = true
    }),
    dedupFetchOrganizations: vi.fn(async () => {}),
  }

  const mockGetClaims = vi.fn().mockResolvedValue({
    data: {
      claims: {
        sub: 'user-123',
      },
    },
  })

  const mockGetSession = vi.fn().mockResolvedValue({
    data: {
      session: {
        access_token: 'token-123',
        user: {
          id: 'user-123',
          email: 'user@managed.test',
          email_confirmed_at: '2026-04-15T10:00:00.000Z',
          app_metadata: {
            provider: 'sso:provider-123',
            providers: ['sso:provider-123'],
          },
        },
      },
    },
  })

  const mockGetAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
    data: {
      currentLevel: 'aal1',
      nextLevel: 'aal1',
    },
    error: null,
  })

  const mockRpc = vi.fn().mockResolvedValue({
    data: false,
    error: null,
  })

  const mockSignOut = vi.fn().mockResolvedValue({ error: null })
  const mockSetUser = vi.fn()
  const mockSendEvent = vi.fn().mockResolvedValue(undefined)
  const mockHideLoader = vi.fn()
  const mockCreateSignedImageUrl = vi.fn(async (value: string) => value)
  const mockGetPlans = vi.fn<() => Promise<any[]>>(async () => [])
  const mockIsPlatformAdmin = vi.fn(async () => false)
  const mockSetWebsitePaidUserCookie = vi.fn()
  const mockFetch = vi.fn<(...args: unknown[]) => Promise<MockFetchResponse>>(async () => ({
    ok: true,
    json: async () => ({ success: true }),
  }))
  const mockApps: Array<{ app_id: string, need_onboarding: boolean }> = []
  const mockFrom = vi.fn((table: string) => {
    if (table === 'apps') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            limit: vi.fn(async () => ({ data: mockApps, error: null })),
          })),
        })),
      }
    }

    return createUsersQuery(userRecord)
  })

  return {
    mainStore,
    mockCreateSignedImageUrl,
    mockApps,
    mockFetch,
    mockFrom,
    mockGetAuthenticatorAssuranceLevel,
    mockGetClaims,
    mockGetPlans,
    mockHideLoader,
    mockIsPlatformAdmin,
    mockRpc,
    mockSendEvent,
    mockSetUser,
    mockSetWebsitePaidUserCookie,
    mockGetSession,
    mockSignOut,
    organizationStore,
  }
}

type AuthGuardTestContext = ReturnType<typeof createTestContext>

const contextStorage = new AsyncLocalStorage<AuthGuardTestContext>()

function getContext() {
  const context = contextStorage.getStore()
  if (!context)
    throw new Error('Missing auth guard test context')

  return context
}

async function withTestContext(run: (context: AuthGuardTestContext) => Promise<void>) {
  const context = createTestContext()

  await contextStorage.run(context, async () => {
    await run(context)
  })
}

vi.mock('~/services/loader', () => ({
  hideLoader: () => getContext().mockHideLoader(),
}))

vi.mock('~/services/posthog', () => ({
  setUser: (...args: unknown[]) => getContext().mockSetUser(...args),
}))

vi.mock('~/services/storage', () => ({
  createSignedImageUrl: (value: string) => getContext().mockCreateSignedImageUrl(value),
  getImmediateImageUrl: (value?: string | null) => value ?? '',
}))

vi.mock('~/services/tracking', () => ({
  sendEvent: (...args: unknown[]) => getContext().mockSendEvent(...args),
}))

vi.mock('~/services/websiteAuthCookie', () => ({
  clearWebsitePaidUserCookie: vi.fn(),
  setWebsitePaidUserCookie: (isPaidUser: boolean) => getContext().mockSetWebsitePaidUserCookie(isPaidUser),
}))

vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://supabase.capgo.test' }),
  getPlans: () => getContext().mockGetPlans(),
  isPlatformAdmin: () => getContext().mockIsPlatformAdmin(),
  useSupabase: () => {
    const context = getContext()

    return {
      auth: {
        getClaims: context.mockGetClaims,
        getSession: context.mockGetSession,
        getAuthenticatorAssuranceLevel: context.mockGetAuthenticatorAssuranceLevel,
        mfa: {
          getAuthenticatorAssuranceLevel: context.mockGetAuthenticatorAssuranceLevel,
        },
        signOut: context.mockSignOut,
      },
      rpc: context.mockRpc,
      from: context.mockFrom,
    }
  },
  defaultApiHost: 'https://api.capgo.test',
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => getContext().mainStore,
}))

vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: (org: { is_invite?: boolean | null, role: string }) => org.is_invite ?? org.role.startsWith('invite'),
  useOrganizationStore: () => getContext().organizationStore,
}))

vi.stubGlobal('fetch', vi.fn((...args: unknown[]) => getContext().mockFetch(...args)))

async function getGuard() {
  const router = {
    beforeEach: vi.fn(),
  }

  const { install } = await import('../src/modules/auth.ts')
  install({ router } as any)

  const guard = router.beforeEach.mock.calls[0]?.[0]
  if (!guard)
    throw new Error('Auth guard was not registered')

  return guard
}

describe('auth guard SSO provisioning', () => {
  it.concurrent('provisions an SSO session before redirecting to app onboarding and keeps the user on the target route', async () => {
    await withTestContext(async (context) => {
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockFetch).toHaveBeenCalledWith('https://api.capgo.test/private/sso/provision-user', expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
        }),
      }))
      expect(context.organizationStore.fetchOrganizations).toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
      expect(next).not.toHaveBeenCalledWith('/onboarding/app')
    })
  })

  it.concurrent('redirects an eligible user to resume their pending app onboarding', async () => {
    await withTestContext(async (context) => {
      context.mockApps.push({ app_id: 'com.test.pending-onboarding', need_onboarding: true })
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-789',
              email: 'user@managed.test',
              created_at: '2026-08-04T14:01:00.000Z',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: { provider: 'email', providers: ['email'] },
            },
          },
        },
      })
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith({
        path: '/app/new',
        query: { resume: 'com.test.pending-onboarding' },
      })
    })
  })

  it.concurrent('stops bouncing an eligible user back to /app/new once they leave the resume flow', async () => {
    await withTestContext(async (context) => {
      context.mockApps.push({ app_id: 'com.test.pending-onboarding', need_onboarding: true })
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-leaves-onboarding',
              email: 'user@managed.test',
              created_at: '2026-08-04T14:01:00.000Z',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: { provider: 'email', providers: ['email'] },
            },
          },
        },
      })
      const guard = await getGuard()

      // Leaving /app/new (Back, breadcrumb, sidebar tab) is respected instead
      // of being reverted straight back to the setup flow.
      const leave = vi.fn()
      await guard(
        { path: '/apps', fullPath: '/apps', meta: { middleware: 'auth' }, query: {} },
        { path: '/app/new', fullPath: '/app/new?resume=com.test.pending-onboarding', query: { resume: 'com.test.pending-onboarding' } },
        leave,
      )
      expect(leave).toHaveBeenCalledWith()
      expect(leave).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/app/new' }))

      // A subsequent navigation (even one that no longer starts from /app/new,
      // e.g. after a reload) also stays put thanks to the persisted grant.
      const later = vi.fn()
      await guard(
        { path: '/settings/account', fullPath: '/settings/account', meta: { middleware: 'auth' }, query: {} },
        { path: '/apps', fullPath: '/apps', query: {} },
        later,
      )
      expect(later).toHaveBeenCalledWith()
      expect(later).not.toHaveBeenCalledWith(expect.objectContaining({ path: '/app/new' }))
    })
  })

  it.concurrent('loads plans before redirecting a newly authenticated user into onboarding', async () => {
    await withTestContext(async (context) => {
      const loadedPlans = [{ name: 'Solo' }]
      context.mockApps.push({ app_id: 'com.test.pending-onboarding', need_onboarding: true })
      context.mockGetPlans.mockResolvedValue(loadedPlans)
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-plans-onboarding',
              email: 'user@managed.test',
              created_at: '2026-08-04T14:01:00.000Z',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: { provider: 'email', providers: ['email'] },
            },
          },
        },
      })
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith({
        path: '/app/new',
        query: { resume: 'com.test.pending-onboarding' },
      })
      expect(context.mockGetPlans).toHaveBeenCalledOnce()
      expect(context.mainStore.plans).toEqual(loadedPlans)
    })
  })

  it.concurrent('tracks a successful login before redirecting the user into onboarding', async () => {
    await withTestContext(async (context) => {
      context.mockApps.push({ app_id: 'com.test.pending-onboarding', need_onboarding: true })
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-login-tracking',
              email: 'user@managed.test',
              created_at: '2026-08-04T14:01:00.000Z',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: { provider: 'email', providers: ['email'] },
            },
          },
        },
      })
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith({
        path: '/app/new',
        query: { resume: 'com.test.pending-onboarding' },
      })
      expect(context.mockSendEvent).toHaveBeenCalledOnce()
      expect(context.mockSendEvent).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'user-login',
        event: 'User Login',
        user_id: 'user-login-tracking',
      }))
    })
  })

  it.concurrent('retries loading plans on a later authenticated navigation when the store is empty', async () => {
    await withTestContext(async (context) => {
      const loadedPlans = [{ name: 'Solo' }]
      context.mainStore.auth = {
        id: 'user-123',
        email: 'user@managed.test',
        email_confirmed_at: '2026-04-15T10:00:00.000Z',
      }
      context.mockGetPlans.mockResolvedValue(loadedPlans)
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/settings/organization/plans', fullPath: '/settings/organization/plans', meta: { middleware: 'auth' }, query: {} },
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith()
      expect(context.mockGetPlans).toHaveBeenCalledOnce()
      expect(context.mainStore.plans).toEqual(loadedPlans)
    })
  })

  it.concurrent('allows an eligible user to explore the dashboard until refresh', async () => {
    await withTestContext(async (context) => {
      context.mockApps.push({ app_id: 'com.test.pending-onboarding', need_onboarding: true })
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-456',
              email: 'user@managed.test',
              created_at: '2026-08-04T14:01:00.000Z',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: { provider: 'email', providers: ['email'] },
            },
          },
        },
      })
      allowOnboardingDashboardExploration('user-456')
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith()
    })
  })

  it.concurrent('keeps redirecting non-SSO users without organizations to app onboarding', async () => {
    await withTestContext(async (context) => {
      context.mockGetSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'token-123',
            user: {
              id: 'user-123',
              email: 'user@managed.test',
              email_confirmed_at: '2026-04-15T10:00:00.000Z',
              app_metadata: {
                provider: 'email',
                providers: ['email'],
              },
            },
          },
        },
      })

      context.organizationStore.fetchOrganizations = vi.fn(async () => {
        context.organizationStore.organizations = []
        context.organizationStore.hasOrganizations = false
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockFetch).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith({
        path: '/onboarding/app',
        query: {
          to: '/dashboard',
        },
      })
    })
  })

  it.concurrent('redirects accounts pending deletion to the recovery page instead of app onboarding', async () => {
    await withTestContext(async (context) => {
      context.mockRpc.mockResolvedValueOnce({
        data: true,
        error: null,
      })

      context.organizationStore.fetchOrganizations = vi.fn(async () => {
        context.organizationStore.organizations = []
        context.organizationStore.hasOrganizations = false
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.organizationStore.fetchOrganizations).not.toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith({
        path: '/accountDisabled',
        query: {
          to: '/dashboard',
        },
      })
    })
  })

  it.concurrent('keeps disabled users on the recovery page when it is reloaded with a saved destination', async () => {
    await withTestContext(async (context) => {
      context.mockRpc.mockResolvedValueOnce({
        data: true,
        error: null,
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        {
          path: '/accountDisabled',
          fullPath: '/accountDisabled?to=/apps/app-123',
          meta: { middleware: 'auth' },
          query: { to: '/apps/app-123' },
        },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith()
    })
  })

  it.concurrent('continues navigation when the disabled-account RPC errors', async () => {
    await withTestContext(async (context) => {
      context.mockRpc.mockResolvedValueOnce({
        data: null,
        error: new Error('rpc failed'),
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.organizationStore.fetchOrganizations).toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith()
      expect(next).not.toHaveBeenCalledWith(expect.objectContaining({
        path: '/accountDisabled',
      }))
    })
  })

  it.concurrent('sets the website paid user cookie for platform admins after login', async () => {
    await withTestContext(async (context) => {
      context.mockIsPlatformAdmin.mockResolvedValue(true)

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockSetWebsitePaidUserCookie).toHaveBeenCalledWith(true)
      expect(context.mainStore.isAdmin).toBe(true)
      expect(next).toHaveBeenCalledWith()
    })
  })

  it.concurrent('redirects active users away from the recovery page when the disabled-account check errors', async () => {
    await withTestContext(async (context) => {
      context.mainStore.auth = {
        id: 'user-123',
        email: 'user@managed.test',
        email_confirmed_at: '2026-04-15T10:00:00.000Z',
      }
      context.mockRpc.mockResolvedValueOnce({
        data: null,
        error: new Error('rpc failed'),
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        {
          path: '/accountDisabled',
          fullPath: '/accountDisabled?to=/apps/app-123',
          meta: { middleware: 'auth' },
          query: { to: '/apps/app-123' },
        },
        { path: '/apps/app-123', fullPath: '/apps/app-123', meta: { middleware: 'auth' }, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith('/apps/app-123')
    })
  })

  it.concurrent('aborts navigation for managed SSO users when provisioning fails instead of redirecting to app onboarding', async () => {
    await withTestContext(async (context) => {
      context.mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'provider_lookup_failed' }),
      })

      context.organizationStore.fetchOrganizations = vi.fn(async () => {
        context.organizationStore.organizations = []
        context.organizationStore.hasOrganizations = false
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockFetch).toHaveBeenCalled()
      expect(next).toHaveBeenCalledWith(false)
      expect(next).not.toHaveBeenCalledWith({
        path: '/onboarding/app',
        query: {
          to: '/dashboard',
        },
      })
    })
  })

  it.concurrent('aborts navigation when merged-session sign out fails instead of redirecting with a stale SSO session', async () => {
    await withTestContext(async (context) => {
      context.mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, merged: true }),
      })
      context.mockSignOut.mockResolvedValueOnce({
        error: new Error('sign out failed'),
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(next).toHaveBeenCalledWith(false)
      expect(next).not.toHaveBeenCalledWith('/login?message=sso_account_linked')
    })
  })
})
