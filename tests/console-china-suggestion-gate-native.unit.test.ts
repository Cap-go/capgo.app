import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shouldSuggestChinaConsole } from '../src/services/consoleApiHost.ts'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}))

const CHINA_BANNER_SCENARIO = {
  mainApiReachable: false,
  chinaApiReachable: true,
  localeHint: true,
} as const

describe('chinaConsoleSuggestionGate on native clients', () => {
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

  it('blocks updateChinaConsoleSuggestion when Capacitor reports native', async () => {
    const { chinaConsoleSuggestionGate } = await import('../src/services/console')
    expect(chinaConsoleSuggestionGate()).toBe(false)
    expect(shouldSuggestChinaConsole({ ...CHINA_BANNER_SCENARIO, onGlobalConsole: chinaConsoleSuggestionGate() })).toBe(false)
  })
})