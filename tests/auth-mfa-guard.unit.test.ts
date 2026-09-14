import { AsyncLocalStorage } from 'node:async_hooks'
import { describe, expect, it, vi } from 'vitest'

function createTestContext() {
  const mainStore = {
    auth: undefined,
    user: undefined,
    isAdmin: false,
    plans: [],
  }

  const organizationStore = {
    organizations: [{ gid: 'org-123', role: 'read' }],
    hasOrganizations: true,
    fetchOrganizations: vi.fn(async () => {}),
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
          email: 'user@example.com',
          email_confirmed_at: '2026-04-15T10:00:00.000Z',
          app_metadata: { provider: 'email', providers: ['email'] },
          factors: [{ factor_type: 'totp', status: 'verified' }],
        },
      },
    },
  })

  const mockGetAuthenticatorAssuranceLevel = vi.fn().mockResolvedValue({
    data: {
      currentLevel: 'aal1',
      nextLevel: 'aal2',
    },
    error: null,
  })

  const mockRpc = vi.fn(async (name: string) => {
    if (name === 'verify_mfa')
      return { data: false, error: null }
    if (name === 'is_account_disabled')
      return { data: false, error: null }
    return { data: null, error: null }
  })

  const mockHideLoader = vi.fn()

  return {
    mainStore,
    mockGetAuthenticatorAssuranceLevel,
    mockGetClaims,
    mockGetSession,
    mockHideLoader,
    mockRpc,
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
  setUser: vi.fn(),
}))

vi.mock('~/services/storage', () => ({
  createSignedImageUrl: vi.fn(async (value: string) => value),
  getImmediateImageUrl: (value?: string | null) => value ?? '',
}))

vi.mock('~/services/tracking', () => ({
  sendEvent: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('~/services/websiteAuthCookie', () => ({
  clearWebsitePaidUserCookie: vi.fn(),
  setWebsitePaidUserCookie: vi.fn(),
}))

vi.mock('~/services/supabase', () => ({
  getLocalConfig: () => ({ supaHost: 'https://supabase.capgo.test' }),
  getPlans: vi.fn(async () => []),
  isPlatformAdmin: vi.fn(async () => false),
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
        signOut: vi.fn(),
        onAuthStateChange: vi.fn(),
      },
      rpc: context.mockRpc,
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          })),
        })),
      })),
    }
  },
  defaultApiHost: 'https://api.capgo.test',
}))

vi.mock('~/stores/main', () => ({
  useMainStore: () => getContext().mainStore,
}))

vi.mock('~/stores/organization', () => ({
  isPendingOrganizationInvite: () => false,
  useOrganizationStore: () => getContext().organizationStore,
}))

async function getGuard() {
  const router = {
    beforeEach: vi.fn(),
  }

  const { install } = await import('../src/modules/auth.ts')
  install({ router } as never)

  const guard = router.beforeEach.mock.calls[0]?.[0]
  if (!guard)
    throw new Error('Auth guard was not registered')

  return guard
}

describe('auth guard MFA assurance', () => {
  it.concurrent('redirects enrolled TOTP users at aal1 to complete MFA', async () => {
    await withTestContext(async (context) => {
      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockRpc).toHaveBeenCalledWith('verify_mfa')
      expect(next).toHaveBeenCalledWith({
        path: '/login',
        query: {
          to: '/dashboard',
        },
      })
    })
  })

  it.concurrent('allows active platform-admin impersonation sessions at aal1', async () => {
    await withTestContext(async (context) => {
      context.mockRpc.mockImplementation(async (name: string) => {
        if (name === 'verify_mfa')
          return { data: true, error: null }
        if (name === 'is_account_disabled')
          return { data: false, error: null }
        return { data: null, error: null }
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockRpc).toHaveBeenCalledWith('verify_mfa')
      expect(next).toHaveBeenCalledWith()
    })
  })

  it.concurrent('allows users who already completed MFA at aal2', async () => {
    await withTestContext(async (context) => {
      context.mockGetAuthenticatorAssuranceLevel.mockResolvedValue({
        data: {
          currentLevel: 'aal2',
          nextLevel: 'aal2',
        },
        error: null,
      })

      const guard = await getGuard()
      const next = vi.fn()

      await guard(
        { path: '/dashboard', fullPath: '/dashboard', meta: { middleware: 'auth' }, query: {} },
        { path: '/login', fullPath: '/login', meta: {}, query: {} },
        next,
      )

      expect(context.mockRpc).not.toHaveBeenCalledWith('verify_mfa')
      expect(next).toHaveBeenCalledWith()
    })
  })
})
