import { afterEach, describe, expect, it, vi } from 'vitest'
import { invalidIpInfo } from '../supabase/functions/_backend/plugin_runtime/utils/invalids_ip.ts'

function requestContext(cf?: Record<string, unknown>) {
  const raw = new Request('https://plugin.capgo.test/stats')
  if (cf)
    Object.defineProperty(raw, 'cf', { value: cf })
  return {
    req: { url: raw.url, header: () => undefined, raw },
    get: () => undefined,
  } as any
}

function randomIp() {
  return `198.51.${Math.floor(Math.random() * 250) + 1}.${Math.floor(Math.random() * 250) + 1}`
}

function ipApiResponse(body: Record<string, unknown>, init?: ResponseInit) {
  return new Response(JSON.stringify(body), init)
}

const googleDatacenter = { status: 'success', isp: 'Google LLC', org: 'Google Cloud', as: 'AS15169 Google LLC', asname: 'GOOGLE', proxy: false, hosting: true }

describe('provider IP lookup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips ip-api for a network Cloudflare knows is not Google or Apple', async () => {
    vi.stubGlobal('caches', undefined)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(invalidIpInfo(randomIp(), requestContext({ asn: 3215, asOrganization: 'Orange' }))).resolves.toEqual({ blocked: false, provider: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a provider ASN', { asn: 15169, asOrganization: 'Google LLC' }],
    ['a provider-named organization on another ASN', { asn: 64500, asOrganization: 'Google Cloud Partner' }],
    ['an unknown network', undefined],
  ])('looks %s up', async (_name, cf) => {
    vi.stubGlobal('caches', undefined)
    const fetchMock = vi.fn(async () => ipApiResponse(googleDatacenter))
    vi.stubGlobal('fetch', fetchMock)

    await expect(invalidIpInfo(randomIp(), requestContext(cf))).resolves.toEqual({ blocked: true, provider: 'google' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries a failed lookup after minutes, not a day', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('caches', undefined)
      const ip = randomIp()
      const fetchMock = vi.fn(async () => ipApiResponse({ status: 'fail' }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(invalidIpInfo(ip, requestContext())).resolves.toEqual({ blocked: false, provider: null })
      vi.advanceTimersByTime(6 * 60_000)
      fetchMock.mockImplementation(async () => ipApiResponse(googleDatacenter))
      await expect(invalidIpInfo(ip, requestContext())).resolves.toEqual({ blocked: true, provider: 'google' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('keeps the short TTL of a failed lookup read from the shared cache', async () => {
    vi.useFakeTimers()
    try {
      // Another isolate stored a failed lookup: this one only sees the shared cache.
      const stored = { blocked: false, provider: null, cachedUntil: Date.now() + 5 * 60_000 }
      const match = vi.fn(async () => new Response(JSON.stringify(stored)))
      vi.stubGlobal('caches', { open: async () => ({ match: () => match(), put: async () => {} }) })
      const fetchMock = vi.fn(async () => ipApiResponse(googleDatacenter))
      vi.stubGlobal('fetch', fetchMock)
      const ip = randomIp()

      await expect(invalidIpInfo(ip, requestContext())).resolves.toEqual({ blocked: false, provider: null })
      expect(fetchMock).not.toHaveBeenCalled()

      vi.advanceTimersByTime(6 * 60_000)
      match.mockImplementation(async () => new Response(null, { status: 404 }))
      await expect(invalidIpInfo(ip, requestContext())).resolves.toEqual({ blocked: true, provider: 'google' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    }
    finally {
      vi.useRealTimers()
    }
  })

  // Last: the backoff it starts outlives the test inside this module.
  it('stops calling ip-api until its rate limit window resets', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('caches', undefined)
      const fetchMock = vi.fn(async () => ipApiResponse({}, { status: 429, headers: { 'X-Rl': '0', 'X-Ttl': '30' } }))
      vi.stubGlobal('fetch', fetchMock)

      await expect(invalidIpInfo(randomIp(), requestContext())).resolves.toEqual({ blocked: false, provider: null })
      await expect(invalidIpInfo(randomIp(), requestContext())).resolves.toEqual({ blocked: false, provider: null })
      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(31_000)
      fetchMock.mockImplementation(async () => ipApiResponse(googleDatacenter))
      await expect(invalidIpInfo(randomIp(), requestContext())).resolves.toEqual({ blocked: true, provider: 'google' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
    finally {
      vi.useRealTimers()
    }
  })
})
