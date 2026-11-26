import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldSuggestChinaConsole } from '../src/services/consoleApiHost.ts'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}))

const CHINA_BANNER_SCENARIO = {
  mainApiReachable: false,
  chinaApiReachable: true,
  localeHint: true,
} as const

describe('chinaConsoleSuggestionGate (console.ts call site)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('passes on web console.capgo.app with global API host', async () => {
    const { chinaConsoleSuggestionGate } = await import('../src/services/console')
    expect(chinaConsoleSuggestionGate()).toBe(true)
    expect(shouldSuggestChinaConsole({ ...CHINA_BANNER_SCENARIO, onGlobalConsole: chinaConsoleSuggestionGate() })).toBe(true)
  })

  it('sets suggestChinaConsole when the main API is down and the China API answers', async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'zh-CN',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Asia/Shanghai',
      hour12: false,
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://api.capgo.com.cn/private/config')
        return new Response(JSON.stringify({ stripeEnabled: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(null, { status: 502 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig, suggestChinaConsole } = await import('../src/services/console')
    await getRemoteConfig()
    expect(suggestChinaConsole.value).toBe(true)
  })
})