import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetSession = vi.fn()
const mockSignOut = vi.fn()
const mockGetSpoofedAdminJwt = vi.fn()

vi.mock('~/services/console', () => ({
  defaultApiHost: 'https://api.capgo.test',
  getSpoofedAdminJwt: mockGetSpoofedAdminJwt,
  useConsole: () => ({
    auth: {
      getSession: mockGetSession,
      signOut: mockSignOut,
    },
  }),
}))

function createSessionStorageMock() {
  const store = new Map<string, string>()

  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value)
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key)
    }),
    clear: vi.fn(() => {
      store.clear()
    }),
  }
}

async function getGuard() {
  const router = {
    beforeEach: vi.fn(),
  }

  const { install } = await import('../src/modules/sso-enforcement.ts')
  install({ router } as any)

  const guard = router.beforeEach.mock.calls[0]?.[0]
  if (!guard)
    throw new Error('SSO enforcement guard was not registered')

  return guard
}

describe('sso enforcement redirect handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()

    vi.stubGlobal('sessionStorage', createSessionStorageMock())
    vi.stubGlobal('fetch', vi.fn())

    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'token-123',
          user: {
            id: 'user-123',
            email: 'user@capgo.app',
            app_metadata: {
              provider: 'email',
            },
          },
        },
      },
    })
    mockGetSpoofedAdminJwt.mockReturnValue(null)
    mockSignOut.mockResolvedValue({ error: null })
  })

  it('redirects to a technical error when the enforcement endpoint returns a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response)

    const guard = await getGuard()
    const next = vi.fn()

    await guard({ path: '/dashboard' }, { path: '/login' }, next)

    expect(mockSignOut).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith('/login?sso_error=enforcement_check_failed')
  })

  it('keeps the explicit SSO-required redirect when enforcement denies password auth', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ allowed: false }),
    } as unknown as Response)

    const guard = await getGuard()
    const next = vi.fn()

    await guard({ path: '/dashboard' }, { path: '/login' }, next)

    expect(mockSignOut).toHaveBeenCalledOnce()
    expect(next).toHaveBeenCalledWith('/login?sso_required=true')
  })

  it('sends the stored admin token for backend-verified impersonation bypass', async () => {
    mockGetSpoofedAdminJwt.mockReturnValue('admin-token-456')
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as Response)

    const guard = await getGuard()
    const next = vi.fn()

    await guard({ path: '/dashboard' }, { path: '/login' }, next)

    expect(fetch).toHaveBeenCalledWith('https://api.capgo.test/private/sso/check-enforcement', expect.objectContaining({
      headers: expect.objectContaining({
        'Authorization': 'Bearer token-123',
        'X-Capgo-Spoof-Admin-Authorization': 'Bearer admin-token-456',
      }),
    }))
    expect(mockSignOut).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith()
  })

  it('does not cache allow decisions from impersonation proof for later password checks', async () => {
    mockGetSpoofedAdminJwt.mockReturnValueOnce('admin-token-456').mockReturnValueOnce(null)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as Response)

    const guard = await getGuard()

    await guard({ path: '/dashboard' }, { path: '/login' }, vi.fn())
    await guard({ path: '/dashboard' }, { path: '/login' }, vi.fn())

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.capgo.test/private/sso/check-enforcement', expect.objectContaining({
      headers: expect.objectContaining({
        'X-Capgo-Spoof-Admin-Authorization': 'Bearer admin-token-456',
      }),
    }))
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.capgo.test/private/sso/check-enforcement', expect.objectContaining({
      headers: expect.not.objectContaining({
        'X-Capgo-Spoof-Admin-Authorization': expect.any(String),
      }),
    }))
  })
})
