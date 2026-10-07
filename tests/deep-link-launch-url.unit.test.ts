import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchUrl = { url: 'capgo://preview/channel?appId=com.example.app&channel=pr-1&channelId=7&nativeConfirmedPreview=1' }

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    getLaunchUrl: vi.fn(async () => launchUrl),
  },
}))
vi.mock('@capgo/capacitor-install-referrer', () => ({ InstallReferrer: { getReferrerDetails: vi.fn() } }))

function createStorage() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  }
}

describe('installDeepLinkHandler launch URL', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', createStorage())
    vi.stubGlobal('localStorage', createStorage())
  })

  it('routes the launch URL once even when the handler is installed again after a bundle reload', async () => {
    const { installDeepLinkHandler } = await import('../src/services/deepLinks.ts')
    const push = vi.fn(async () => {})
    const router = { push } as any

    await installDeepLinkHandler(router)
    await installDeepLinkHandler(router)

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(push.mock.calls[0]?.[0]).toMatchObject({ path: '/scan', query: { nativeConfirmedPreview: '1' } })
  })

  it('routes the launch URL again after a cold start clears session storage', async () => {
    const { installDeepLinkHandler } = await import('../src/services/deepLinks.ts')
    const push = vi.fn(async () => {})
    const router = { push } as any

    await installDeepLinkHandler(router)
    vi.stubGlobal('sessionStorage', createStorage())
    await installDeepLinkHandler(router)

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2))
  })
})
