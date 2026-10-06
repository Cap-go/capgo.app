import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/snippet/index.js'
import { decodeSnippetEdgeStat } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'

const APP_ID = 'com.edge.app'
const DEVICE_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_DEVICE_ID = '00000000-0000-4000-8000-000000000002'
const NO_NEW_BODY = { error: 'no_new_version_available', message: 'No new version available', kind: 'up_to_date' }

function updatesBody(overrides: Record<string, unknown> = {}) {
  return {
    app_id: APP_ID,
    device_id: DEVICE_ID,
    platform: 'ios',
    version_name: '1.2.3',
    version_build: '2.0',
    plugin_version: '7.40.0',
    is_emulator: false,
    is_prod: true,
    defaultChannel: 'production',
    ...overrides,
  }
}

function statsEvent(overrides: Record<string, unknown> = {}) {
  return {
    app_id: APP_ID,
    device_id: DEVICE_ID,
    platform: 'android',
    version_name: '1.2.3',
    version_os: '14',
    is_emulator: false,
    is_prod: true,
    action: 'app_moved_to_foreground',
    ...overrides,
  }
}

function buildRequest(path: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new Request(`https://plugin.capgo.app${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: { colo: 'CDG' } })
  return request
}

function fillHeader(fill: Record<string, unknown>) {
  return encodeURIComponent(JSON.stringify({ v: 1, bps: 10000, ttl: 900, tags: 'capgo-updates-com.edge.app,capgo-updates-com.edge.app:versions', ...fill }))
}

const updatesFill = fillHeader({ e: 'updates', n: '1.2.3', k: null, o: 'org-1', a: true, cs: true })
const statsFill = fillHeader({ e: 'stats' })

function buildCache() {
  const store = new Map<string, Response>()
  const keyOf = (key: RequestInfo | URL) => key instanceof Request ? key.url : String(key)
  return {
    store,
    match: vi.fn(async (key: RequestInfo | URL) => store.get(keyOf(key))?.clone()),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      store.set(keyOf(key), response.clone())
    }),
    delete: vi.fn(async (key: RequestInfo | URL) => store.delete(keyOf(key))),
  }
}

type Cache = ReturnType<typeof buildCache>

function subrequests(cache: Cache, fetchMock: ReturnType<typeof vi.fn>) {
  return cache.match.mock.calls.length + cache.put.mock.calls.length + cache.delete.mock.calls.length + fetchMock.mock.calls.length
}

describe('cloudflare snippet edge answers', () => {
  let cache: Cache

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    cache = buildCache()
    vi.stubGlobal('caches', { default: cache })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('learns an up-to-date answer from the worker and serves it without a worker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(NO_NEW_BODY), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Capgo-Edge-Fill': updatesFill },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = await snippet.fetch(buildRequest('/updates', updatesBody()))
    expect(first.headers.get('X-Capgo-Edge-Fill')).toBeNull()
    expect(await first.json()).toEqual(NO_NEW_BODY)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)

    cache.match.mockClear()
    cache.put.mockClear()
    const body = updatesBody({ device_id: OTHER_DEVICE_ID })
    const second = await snippet.fetch(buildRequest('/updates', body))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(second.status).toBe(200)
    expect(second.headers.get('X-Capgo-Edge')).toBe('answer')
    expect(await second.json()).toEqual(NO_NEW_BODY)
    // Hit: the app entry plus the IP limit lookup.
    expect(cache.match).toHaveBeenCalledTimes(2)
    expect(cache.put).not.toHaveBeenCalled()

    const stat = decodeSnippetEdgeStat(second.headers.get('X-Capgo-Edge-Stat')!)
    expect(stat).toEqual({ e: 'updates', b: JSON.stringify(body), o: 'org-1', a: true, n: '1.2.3' })
  })

  it('sends devices that are not on the served bundle, or not answerable, to the worker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(NO_NEW_BODY), {
      status: 200,
      headers: { 'X-Capgo-Edge-Fill': updatesFill },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))

    const forwarded = [
      updatesBody({ version_name: '1.2.2' }),
      updatesBody({ defaultChannel: 'beta' }),
      updatesBody({ platform: 'android' }),
      // Legacy channel_self store plugins (cs) and deprecated plugins keep the worker path.
      updatesBody({ plugin_version: '6.30.0' }),
      updatesBody({ plugin_version: '4.20.0' }),
      updatesBody({ version_build: 'unknown' }),
      updatesBody({ version_build: '1.0-beta.1' }),
      updatesBody({ is_prod: 'yes' }),
      updatesBody({ device_id: 'not-a-uuid' }),
    ]
    for (const body of forwarded)
      await snippet.fetch(buildRequest('/updates', body))
    expect(fetchMock).toHaveBeenCalledTimes(1 + forwarded.length)

    // A browser caller needs the worker's CORS answer.
    await snippet.fetch(buildRequest('/updates', updatesBody(), { Origin: 'https://example.com' }))
    expect(fetchMock).toHaveBeenCalledTimes(2 + forwarded.length)
  })

  it('stops answering an IP the update enumeration guard limited', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    let limited = false
    const fetchMock = vi.fn(async () => {
      if (limited) {
        return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected' }), {
          status: 429,
          headers: { 'Cache-Control': 'private, no-store', 'X-RateLimit-Reset': String(resetAt), 'X-Capgo-Edge-Ip-Limit': String(resetAt) },
        })
      }
      return new Response(JSON.stringify(NO_NEW_BODY), { status: 200, headers: { 'X-Capgo-Edge-Fill': updatesFill } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))

    limited = true
    const limitedAnswer = await snippet.fetch(buildRequest('/updates', updatesBody({ version_name: '0.0.1' })))
    expect(limitedAnswer.status).toBe(429)
    expect(limitedAnswer.headers.get('X-Capgo-Edge-Ip-Limit')).toBeNull()
    // The IP limit is not an app-wide on-prem answer.
    expect([...cache.store.keys()].some(key => key.includes('/edge-ip-limit-v1/'))).toBe(true)

    const guess = await snippet.fetch(buildRequest('/updates', updatesBody()))
    expect(guess.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Another IP still gets the edge answer.
    await snippet.fetch(buildRequest('/updates', updatesBody(), { 'cf-connecting-ip': '198.51.100.9' }))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('answers devices outside the sampled share through the worker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(NO_NEW_BODY), {
      status: 200,
      headers: { 'X-Capgo-Edge-Fill': fillHeader({ e: 'updates', n: '1.2.3', k: null, o: 'org-1', a: true, cs: false, bps: 1 }) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    for (let i = 0; i < 5; i++)
      await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: `00000000-0000-4000-8000-00000000001${i}` })))
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('answers /stats batches of known actions and keeps installs and failures live', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as unknown[]
      return new Response(JSON.stringify({ status: 'ok', results: events.map((_, index) => ({ status: 'ok', index })) }), {
        status: 200,
        headers: { 'X-Capgo-Edge-Fill': statsFill },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await snippet.fetch(buildRequest('/stats', [statsEvent(), statsEvent({ action: 'app_moved_to_background' })]))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const batch = [statsEvent({ action: 'app_moved_to_background' }), statsEvent()]
    const answered = await snippet.fetch(buildRequest('/stats', batch))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await answered.json()).toEqual({ status: 'ok', results: [{ status: 'ok', index: 0 }, { status: 'ok', index: 1 }] })
    expect(decodeSnippetEdgeStat(answered.headers.get('X-Capgo-Edge-Stat')!)).toEqual({ e: 'stats', b: JSON.stringify(batch) })

    // Installs, failures and actions the worker never accepted for this app go to the worker.
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'set' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'download_fail' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'unknown_action' })]))
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('answers a single /stats event with the worker body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'X-Capgo-Edge-Fill': statsFill },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await snippet.fetch(buildRequest('/stats', statsEvent()))
    const answered = await snippet.fetch(buildRequest('/stats', statsEvent({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await answered.json()).toEqual({ status: 'ok' })
  })

  it('keeps every path within the 5 subrequest snippet budget', async () => {
    let failPrimary = true
    const fetchMock = vi.fn(async (url: unknown) => {
      if (failPrimary && String(url).startsWith('https://plugin.eu.capgo.app'))
        return new Response('upstream error', { status: 502 })
      return new Response(JSON.stringify(NO_NEW_BODY), { status: 200, headers: { 'X-Capgo-Edge-Fill': updatesFill } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', updatesBody()))
    expect(response.status).toBe(200)
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
    // The answer seen after a failed worker is served but not learned.
    expect([...cache.store.keys()].some(key => key.includes('/edge-v3/'))).toBe(false)

    failPrimary = false
    cache.match.mockClear()
    cache.put.mockClear()
    cache.delete.mockClear()
    fetchMock.mockClear()
    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
  })
})
