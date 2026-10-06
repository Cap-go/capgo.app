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

  it('returns and caches on-prem from the first worker without a confirming fetch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const body = { app_id: 'com.external.app' }
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', body))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-Cached')).toBe('false')
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    // One worker fetch only: the snippet subrequest budget (5 on Enterprise) has no room for a confirm.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://plugin.na.capgo.app/updates')
    await expect(new Response(fetchMock.mock.calls[0][1]?.body).json()).resolves.toEqual(body)
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/edge-v3/'))).toBe(true)
  })

  it('returns on-prem from a fallback worker without caching when the primary fails', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app')
        return new Response('upstream error', { status: 502 })
      if (target.origin === 'https://plugin.eu.capgo.app') {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'public, max-age=60' },
        })
      }
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.external.app' }))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Partial outage: serve the on-prem answer but never cache it.
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/edge-v3/'))).toBe(false)
  })

  it('passes cloud responses through after a single worker fetch', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', { app_id: 'com.cloud.valid' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const putKeys = cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key))
    expect(putKeys.some(key => key.includes('/__internal__/edge-v3/'))).toBe(false)
  })

  it('retains Retry-After on cached on-prem responses and skips the worker', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })

    const resetAt = Date.now() + 3_600_000
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        error: 'on_premise_app',
        message: 'On-premise app detected',
        moreInfo: { rateLimitResetAt: resetAt, retryAfterSeconds: 3600 },
      }), {
        status: 429,
        headers: {
          'Cache-Control': 'public, max-age=3600',
          'Retry-After': '3600',
          'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const body = { app_id: 'com.external.app' }
    const first = await snippet.fetch(buildRequest('/updates', body))
    expect(first.status).toBe(429)
    expect(first.headers.get('Retry-After')).toBe('3600')
    expect(first.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(resetAt / 1000)))
    expect(cache.put).toHaveBeenCalledTimes(1)

    const second = await snippet.fetch(buildRequest('/updates', body))
    expect(second.status).toBe(429)
    expect(second.headers.get('Retry-After')).toBeTruthy()
    const retryAfter = Number.parseInt(second.headers.get('Retry-After') || '0', 10)
    expect(retryAfter).toBeGreaterThan(3500)
    expect(second.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(resetAt / 1000)))
    expect(second.headers.get('Cache-Control')).toBe(`public, max-age=${retryAfter}`)
    const secondBody = await second.json() as { moreInfo?: { retryAfterSeconds?: number } }
    expect(secondBody.moreInfo?.retryAfterSeconds).toBe(retryAfter)
    // Second request must be served from edge cache — no extra worker fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
