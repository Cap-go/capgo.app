// China console probe and banner behavior.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GLOBAL_CONSOLE_WEB_HOST,
  isChinaCapgoConsoleHostname,
  isOnGlobalConsoleWebHost,
  looksLikeChinaReachLocaleHint,
  shouldSuggestChinaConsole,
} from '../src/services/consoleApiHost.ts'

const CHINA_BANNER_SCENARIO = {
  mainApiReachable: false,
  chinaApiReachable: true,
  localeHint: true,
} as const

describe('China console hostname', () => {
  it.concurrent('matches capgo.com.cn suffix with label boundary', () => {
    expect(isChinaCapgoConsoleHostname('console.capgo.com.cn')).toBe(true)
    expect(isChinaCapgoConsoleHostname('capgo.com.cn')).toBe(true)
    expect(isChinaCapgoConsoleHostname('notcapgo.com.cn')).toBe(false)
    expect(isChinaCapgoConsoleHostname('console.capgo.app')).toBe(false)
  })
})

describe('global console web host gate', () => {
  it.concurrent('allows the production global web console hostname', () => {
    expect(isOnGlobalConsoleWebHost({ hostname: GLOBAL_CONSOLE_WEB_HOST, isNativePlatform: false })).toBe(true)
  })

  it.concurrent('rejects the China console hostname', () => {
    expect(isOnGlobalConsoleWebHost({ hostname: 'console.capgo.com.cn', isNativePlatform: false })).toBe(false)
  })

  it.concurrent('rejects native clients on localhost even when the API host is global', () => {
    expect(isOnGlobalConsoleWebHost({ hostname: 'localhost', isNativePlatform: true, devMode: false })).toBe(false)
  })

  it.concurrent('allows web localhost only in development', () => {
    expect(isOnGlobalConsoleWebHost({ hostname: 'localhost', isNativePlatform: false, devMode: true })).toBe(true)
    expect(isOnGlobalConsoleWebHost({ hostname: 'localhost', isNativePlatform: false, devMode: false })).toBe(false)
  })

  it.concurrent('requires the web host gate so native clients never get the banner', () => {
    const nativeLocalhost = { hostname: 'localhost', isNativePlatform: true, devMode: false }
    const apiHostIsGlobalProd = true
    const revertedGate = apiHostIsGlobalProd
    const fixedGate = isOnGlobalConsoleWebHost(nativeLocalhost) && apiHostIsGlobalProd

    expect(revertedGate).toBe(true)
    expect(fixedGate).toBe(false)
    expect(shouldSuggestChinaConsole({ ...CHINA_BANNER_SCENARIO, onGlobalConsole: revertedGate })).toBe(true)
    expect(shouldSuggestChinaConsole({ ...CHINA_BANNER_SCENARIO, onGlobalConsole: fixedGate })).toBe(false)
  })
})

describe('China console suggestion', () => {
  it.concurrent('requires global console, main API failure, China probe success, and locale hint', () => {
    expect(shouldSuggestChinaConsole({
      onGlobalConsole: true,
      mainApiReachable: false,
      chinaApiReachable: true,
      localeHint: true,
    })).toBe(true)

    expect(shouldSuggestChinaConsole({
      onGlobalConsole: false,
      mainApiReachable: false,
      chinaApiReachable: true,
      localeHint: true,
    })).toBe(false)

    expect(shouldSuggestChinaConsole({
      onGlobalConsole: true,
      mainApiReachable: true,
      chinaApiReachable: true,
      localeHint: true,
    })).toBe(false)

    expect(shouldSuggestChinaConsole({
      onGlobalConsole: true,
      mainApiReachable: false,
      chinaApiReachable: false,
      localeHint: true,
    })).toBe(false)

    expect(shouldSuggestChinaConsole({
      onGlobalConsole: true,
      mainApiReachable: false,
      chinaApiReachable: true,
      localeHint: false,
    })).toBe(false)
  })
})

describe('China reach locale hint', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.concurrent('uses mainland China time zones', () => {
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en-US',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Asia/Shanghai',
      hour12: false,
    })
    expect(looksLikeChinaReachLocaleHint()).toBe(true)
  })

  it.concurrent('uses zh language hints when time zone is not China', () => {
    vi.stubGlobal('navigator', {
      language: 'zh-CN',
      languages: ['zh-CN', 'en'],
    })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'zh-CN',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'UTC',
      hour12: false,
    })
    expect(looksLikeChinaReachLocaleHint()).toBe(true)
  })
})