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