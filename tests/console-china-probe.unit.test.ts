import { describe, expect, it, vi } from 'vitest'
import {
  isChinaCapgoConsoleHostname,
  looksLikeChinaReachLocaleHint,
  shouldSuggestChinaConsole,
} from '../src/services/consoleApiHost.ts'

describe('China console hostname', () => {
  it.concurrent('matches capgo.com.cn suffix with label boundary', () => {
    expect(isChinaCapgoConsoleHostname('console.capgo.com.cn')).toBe(true)
    expect(isChinaCapgoConsoleHostname('capgo.com.cn')).toBe(true)
    expect(isChinaCapgoConsoleHostname('notcapgo.com.cn')).toBe(false)
    expect(isChinaCapgoConsoleHostname('console.capgo.app')).toBe(false)
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
  it('reads navigator when present', () => {
    vi.stubGlobal('navigator', {
      language: 'zh-CN',
      languages: ['zh-CN', 'en'],
    })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'zh-CN',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Asia/Shanghai',
      hour12: false,
    })
    expect(looksLikeChinaReachLocaleHint()).toBe(true)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
})