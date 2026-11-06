import { beforeEach, describe, expect, it, vi } from 'vitest'

const launchUrl = vi.hoisted(() => ({ url: '' }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => 'ios',
  },
}))
vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    getLaunchUrl: vi.fn(async () => ({ url: launchUrl.url })),
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

async function setup(url: string) {
  launchUrl.url = url
  const { installDeepLinkHandler } = await import('../src/services/deepLinks.ts')
  const push = vi.fn(async (_to: unknown) => {})
  return { installDeepLinkHandler, push, router: { push } as any }
}

const CHANNEL_PREVIEW_URL = 'capgo://preview/channel?appId=com.example.app&channel=pr-1&channelId=7&nativeConfirmedPreview=1'

describe('installDeepLinkHandler launch URL', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('sessionStorage', createStorage())
    vi.stubGlobal('localStorage', createStorage())
  })

  it('routes the launch URL once even when the handler is installed again after a bundle reload', async () => {
    const { installDeepLinkHandler, push, router } = await setup(CHANNEL_PREVIEW_URL)

    await installDeepLinkHandler(router)
    await installDeepLinkHandler(router)

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(push.mock.calls[0]?.[0]).toMatchObject({ path: '/scan', query: { nativeConfirmedPreview: '1' } })
  })

  it('routes the launch URL again after a cold start clears session storage', async () => {
    const { installDeepLinkHandler, push, router } = await setup(CHANNEL_PREVIEW_URL)

    await installDeepLinkHandler(router)
    vi.stubGlobal('sessionStorage', createStorage())
    await installDeepLinkHandler(router)

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(2))
  })

  it('strips nativeConfirmedPreview from console web deep links', async () => {
    const { installDeepLinkHandler, push, router } = await setup('https://console.capgo.app/scan?preview=capgo%3A%2F%2Fpreview%2Fbundle%3FappId%3Dcom.example.app%26versionId%3D1&nativeConfirmedPreview=1')

    await installDeepLinkHandler(router)

    await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1))
    expect(push.mock.calls[0]?.[0]).toBe('/scan?preview=capgo%3A%2F%2Fpreview%2Fbundle%3FappId%3Dcom.example.app%26versionId%3D1')
  })
})
