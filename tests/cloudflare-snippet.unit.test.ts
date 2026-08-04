import { afterEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/snippet/index.js'

function buildRequest(path: string, body: Record<string, unknown>, colo = 'SFO') {
  const request = new Request(`https://api.capgo.app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', {
    value: { colo },
  })
  return request
}

function buildCache() {
  const store = new Map<string, Response>()
  return {
    match: vi.fn(async (key: RequestInfo | URL) => {
      const url = key instanceof Request ? key.url : String(key)
      return store.get(url)?.clone()
    }),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      const url = key instanceof Request ? key.url : String(key)
      store.set(url, response.clone())
    }),
    delete: vi.fn(async (key: RequestInfo | URL) => {
      const url = key instanceof Request ? key.url : String(key)
      return store.delete(url)
    }),
  }
}

describe('cloudflare plugin snippet on-prem fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('tries a fallback worker before returning a regional on-prem response', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const body = {
      app_id: 'com.cloud.valid',
      device_id: '11111111-1111-4111-8111-111111111111',
      version_name: '0.0.0',
    }
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      if (target.origin === 'https://plugin.eu.capgo.app') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', body))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://plugin.na.capgo.app/updates')
    expect(String(fetchMock.mock.calls[1][0])).toContain('https://plugin.eu.capgo.app/updates')
    await expect(new Response(fetchMock.mock.calls[0][1]?.body).json()).resolves.toEqual(body)
    await expect(new Response(fetchMock.mock.calls[1][1]?.body).json()).resolves.toEqual(body)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('caches on-prem after primary + one confirming fallback agree', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
        status: 429,
        headers: { 'Cache-Control': 'public, max-age=60' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.external.app' }))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-Cached')).toBe('false')
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cache.put).toHaveBeenCalledTimes(1)
  })

  it('does not finalize on-prem when fallback workers do not confirm it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (url instanceof Request) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }

      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      if (target.origin === 'https://plugin.eu.capgo.app')
        throw new Error('fallback unavailable')
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.cloud.valid' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/onprem-cache-v2/'))).toBe(false)
  })

  it('does not cache on-prem when a confirming fallback fails before another on-prem hit', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (url instanceof Request) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }

      const target = new URL(String(url))
      // SA on-prem, NA 5xx, EU on-prem — must not cache after partial outage.
      if (target.origin === 'https://plugin.sa.capgo.app' || target.origin === 'https://plugin.eu.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      if (target.origin === 'https://plugin.na.capgo.app') {
        return new Response('upstream error', { status: 502 })
      }
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.external.app' }, 'GRU'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/onprem-cache-v2/'))).toBe(false)
  })

  it('caches on-prem after one confirming fallback worker (not full mesh)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (url instanceof Request) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 })
      }

      const target = new URL(String(url))
      // SA primary + NA confirm both on-prem — should finalize without needing EU.
      if (target.origin === 'https://plugin.sa.capgo.app' || target.origin === 'https://plugin.na.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      if (target.origin === 'https://plugin.eu.capgo.app')
        throw new Error('fallback unavailable')
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.external.app' }, 'GRU'))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/onprem-cache-v2/'))).toBe(true)
  })

  it('retains Retry-After on cached on-prem responses and skips the worker', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const resetAt = Date.now() + 86_400_000
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        error: 'on_premise_app',
        message: 'On-premise app detected',
        moreInfo: { rateLimitResetAt: resetAt, retryAfterSeconds: 86400 },
      }), {
        status: 429,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'Retry-After': '86400',
          'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const body = { app_id: 'com.external.app' }
    const first = await snippet.fetch(buildRequest('/updates', body))
    expect(first.status).toBe(429)
    expect(first.headers.get('Retry-After')).toBe('86400')
    expect(first.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(resetAt / 1000)))
    expect(cache.put).toHaveBeenCalledTimes(1)

    const second = await snippet.fetch(buildRequest('/updates', body))
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
    expect(Number.parseInt(second.headers.get('Retry-After') || '0', 10)).toBeGreaterThan(86000)
    expect(second.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(resetAt / 1000)))
    // Second request must be served from edge cache — no extra worker fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })


})
