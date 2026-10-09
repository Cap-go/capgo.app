import { afterEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/snippet/index.js'
import { normalizeWebsiteLiveUrl } from '../src/stores/appUpdateMode.ts'
import { buildWebsiteLiveResponse } from '../supabase/functions/_backend/plugin_runtime/plugins/website_live.ts'

describe('buildWebsiteLiveResponse', () => {
  it('allows website apps with an active plan', () => {
    expect(buildWebsiteLiveResponse({ update_mode: 'website', website_url: 'https://a.example.com/', plan_valid: true })).toEqual({
      allowed: true,
      mode: 'website',
      website_url: 'https://a.example.com/',
      check_interval_seconds: 600,
    })
  })

  it('treats unknown and classic apps as full Capgo', () => {
    expect(buildWebsiteLiveResponse(null)).toEqual({ allowed: false, mode: 'capgo', reason: 'full_capgo' })
    expect(buildWebsiteLiveResponse({ update_mode: 'capgo', website_url: 'https://a.example.com/', plan_valid: true }))
      .toEqual({ allowed: false, mode: 'capgo', reason: 'full_capgo' })
    // Replica without the new column yet.
    expect(buildWebsiteLiveResponse({ update_mode: null, website_url: null, plan_valid: true }).mode).toBe('capgo')
  })

  it('blocks website apps without an active plan unless Stripe is not configured', () => {
    const row = { update_mode: 'website', website_url: 'https://a.example.com/', plan_valid: false }
    expect(buildWebsiteLiveResponse(row)).toEqual({ allowed: false, mode: 'website', reason: 'need_plan_upgrade', check_interval_seconds: 600 })
    expect(buildWebsiteLiveResponse(row, false).allowed).toBe(true)
  })

  it('blocks website apps without a URL', () => {
    expect(buildWebsiteLiveResponse({ update_mode: 'website', website_url: null, plan_valid: true }))
      .toEqual({ allowed: false, mode: 'website', reason: 'missing_website_url', check_interval_seconds: 600 })
  })
})

describe('normalizeWebsiteLiveUrl', () => {
  it('adds https and keeps only the origin', () => {
    expect(normalizeWebsiteLiveUrl('app.example.com?x=1#y')).toBe('https://app.example.com/')
    expect(normalizeWebsiteLiveUrl('https://app.example.com/index.html')).toBe('https://app.example.com/')
  })

  it('rejects websites served from a sub path', () => {
    expect(normalizeWebsiteLiveUrl('https://example.com/app/')).toBeNull()
  })

  it('rejects non https and invalid hosts', () => {
    expect(normalizeWebsiteLiveUrl('http://app.example.com')).toBeNull()
    expect(normalizeWebsiteLiveUrl('localhost')).toBeNull()
    expect(normalizeWebsiteLiveUrl('https://127.0.0.1')).toBeNull()
    expect(normalizeWebsiteLiveUrl('https://-bad.example.com')).toBeNull()
    expect(normalizeWebsiteLiveUrl('https://bad-.example.com')).toBeNull()
    expect(normalizeWebsiteLiveUrl('https://169.254.169.254/')).toBeNull()
    expect(normalizeWebsiteLiveUrl('https://xn--80ak6aa92e.xn--p1ai')).toBe('https://xn--80ak6aa92e.xn--p1ai/')
    expect(normalizeWebsiteLiveUrl('https://user:pass@app.example.com')).toBeNull()
    expect(normalizeWebsiteLiveUrl('   ')).toBeNull()
  })
})

function buildCache() {
  const store = new Map<string, Response>()
  return {
    match: vi.fn(async (key: RequestInfo | URL) => store.get(key instanceof Request ? key.url : String(key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      store.set(key instanceof Request ? key.url : String(key), response.clone())
    }),
    delete: vi.fn(async (key: RequestInfo | URL) => store.delete(key instanceof Request ? key.url : String(key))),
  }
}

function buildGet(path: string, colo = 'SFO') {
  const request = new Request(`https://plugin.capgo.app${path}`, { method: 'GET' })
  Object.defineProperty(request, 'cf', { value: { colo } })
  return request
}

describe('cloudflare snippet /website_live cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('serves the second request from the edge cache keyed by app id', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const cache = buildCache()
    vi.stubGlobal('caches', { default: cache })
    const body = { allowed: true, mode: 'website', website_url: 'https://a.example.com/', check_interval_seconds: 600 }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await snippet.fetch(buildGet('/website_live?app_id=com.demo.App'))
    await expect(first.json()).resolves.toEqual(body)
    const second = await snippet.fetch(buildGet('/website_live?app_id=com.demo.App'))
    await expect(second.json()).resolves.toEqual(body)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.headers.get('Cache-Tag')).toBe('capgo-updates-com.demo.app')
  })

  it('does not cache error responses', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('caches', { default: buildCache() })
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_app_id' }), { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await snippet.fetch(buildGet('/website_live?app_id=bad'))
    await snippet.fetch(buildGet('/website_live?app_id=bad'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
