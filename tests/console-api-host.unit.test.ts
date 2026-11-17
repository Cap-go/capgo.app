import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHINA_API_HOST, getConsoleApiHost, getConsoleWebOrigin, isChinaCapgoConsoleHostname } from '~/services/consoleApiHost'

describe('console API host resolver', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.app')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('uses the build API host on console.capgo.app', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    expect(getConsoleApiHost()).toBe('https://api.capgo.app')
    expect(getConsoleWebOrigin()).toBe('https://console.capgo.app')
  })

  it('uses the China API host on console.capgo.com.cn', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.com.cn', origin: 'https://console.capgo.com.cn' },
    })
    expect(getConsoleApiHost()).toBe(CHINA_API_HOST)
    expect(getConsoleWebOrigin()).toBe('https://console.capgo.com.cn')
  })

  it('uses the build API host on localhost preview', () => {
    vi.stubEnv('VITE_API_HOST', 'http://127.0.0.1:57671/functions/v1')
    vi.stubGlobal('window', {
      location: { hostname: 'localhost', origin: 'http://localhost:5173' },
    })
    expect(getConsoleApiHost()).toBe('http://127.0.0.1:57671/functions/v1')
    expect(getConsoleWebOrigin()).toBe('http://localhost:5173')
  })

  it('does not treat notcapgo.com.cn as China console', () => {
    vi.stubGlobal('window', {
      location: { hostname: 'notcapgo.com.cn', origin: 'https://notcapgo.com.cn' },
    })
    expect(isChinaCapgoConsoleHostname('notcapgo.com.cn')).toBe(false)
    expect(getConsoleApiHost()).toBe('https://api.capgo.app')
  })

  it('falls back to env when window is unavailable', () => {
    vi.stubGlobal('window', undefined)
    expect(getConsoleApiHost()).toBe('https://api.capgo.app')
    expect(getConsoleWebOrigin()).toBe('https://console.capgo.app')
  })
})