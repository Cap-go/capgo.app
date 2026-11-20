import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}))

function hangUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal
    if (!signal) {
      reject(new Error('expected AbortSignal'))
      return
    }
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

function hangJsonUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json() {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('expected AbortSignal'))
          return
        }
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    },
  } as Response)
}

const validConfigJson = { stripeEnabled: true }

describe('getRemoteConfig config fetch timeouts', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubEnv('VITE_APP_URL', 'https://console.capgo.app')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('aborts the main /private/config fetch and never probes China off the global console web host', async () => {
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' },
    })
    const fetchMock = vi.fn(hangUntilAbort)
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig, suggestChinaConsole } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({ apiHost: 'https://api.capgo.app' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api.capgo.app/private/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(suggestChinaConsole.value).toBe(false)
  }, 10_000)

  it('does not fetch remote config when the console API host is loopback', async () => {
    vi.stubEnv('VITE_API_HOST', 'http://127.0.0.1:57671/functions/v1')
    vi.stubGlobal('window', {
      location: { hostname: '127.0.0.1', origin: 'http://127.0.0.1:5173' },
    })
    const fetchMock = vi.fn(hangUntilAbort)
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({
      apiHost: 'http://127.0.0.1:57671/functions/v1',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches /private/config on preprod API hosts', async () => {
    vi.stubEnv('VITE_API_HOST', 'https://api.preprod.capgo.app')
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(validConfigJson), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({
      apiHost: 'https://api.preprod.capgo.app',
      stripeEnabled: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api.preprod.capgo.app/private/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('fetches /private/config on the China console hostname (not treated as loopback)', async () => {
    vi.stubEnv('VITE_API_HOST', 'https://api.capgo.app')
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.com.cn', origin: 'https://console.capgo.com.cn' },
    })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(validConfigJson), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({
      apiHost: 'https://api.capgo.com.cn',
      stripeEnabled: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('https://api.capgo.com.cn/private/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('treats a 200 HTML block page on the China probe as unreachable', async () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    locale: 'zh-CN',
    calendar: 'gregory',
    numberingSystem: 'latn',
    timeZone: 'Asia/Shanghai',
    hour12: false,
  })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.capgo.com.cn/'))
        return new Response('<html><body>blocked</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      return new Response(null, { status: 502 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig, suggestChinaConsole } = await import('../src/services/console')
    await getRemoteConfig()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(suggestChinaConsole.value).toBe(false)
  })

  it('does not treat a 200 empty JSON object on the China probe as reachable', async () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'zh-CN',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Asia/Shanghai',
      hour12: false,
    })
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith('https://api.capgo.com.cn/'))
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(null, { status: 502 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig, suggestChinaConsole } = await import('../src/services/console')
    await getRemoteConfig()
    expect(suggestChinaConsole.value).toBe(false)
  })

  it('aborts a slow /private/config JSON body read within the config probe budget', async () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    const fetchMock = vi.fn(hangJsonUntilAbort)
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig, suggestChinaConsole } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({ apiHost: 'https://api.capgo.app' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(suggestChinaConsole.value).toBe(false)
  }, 10_000)

  it('aborts the main fetch and bounds the China probe on console.capgo.app', async () => {
    vi.stubGlobal('window', {
      location: { hostname: 'console.capgo.app', origin: 'https://console.capgo.app' },
    })
    const fetchMock = vi.fn(hangUntilAbort)
    vi.stubGlobal('fetch', fetchMock)

    const { getRemoteConfig } = await import('../src/services/console')
    await expect(getRemoteConfig()).resolves.toMatchObject({ apiHost: 'https://api.capgo.app' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://api.capgo.app/private/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://api.capgo.com.cn/private/config', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  }, 15_000)
})

describe('isLoopbackConsoleApiHost', () => {
  it.concurrent('matches loopback hosts only', async () => {
    const { isLoopbackConsoleApiHost } = await import('../src/services/console')
    expect(isLoopbackConsoleApiHost('http://127.0.0.1:57671/functions/v1')).toBe(true)
    expect(isLoopbackConsoleApiHost('http://127.0.0.2:1/')).toBe(true)
    expect(isLoopbackConsoleApiHost('https://api.preprod.capgo.app')).toBe(false)
    expect(isLoopbackConsoleApiHost('https://api.capgo.com.cn')).toBe(false)
    expect(isLoopbackConsoleApiHost('https://api.capgo.app')).toBe(false)
  })
})