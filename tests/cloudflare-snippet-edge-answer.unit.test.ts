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

function buildRequest(path: string, body: unknown, headers: Record<string, string> = {}, options: { host?: string, colo?: string } = {}) {
  const request = new Request(`https://${options.host ?? 'plugin.capgo.app'}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: { colo: options.colo ?? 'CDG' } })
  return request
}

function fillHeader(fill: Record<string, unknown>) {
  return encodeURIComponent(JSON.stringify({ v: 2, bps: 10000, ttl: 900, tags: 'capgo-updates-com.edge.app,capgo-updates-com.edge.app:versions,capgo-snippet-edge-answers', ...fill }))
}

const updatesFill = fillHeader({ e: 'updates', n: '1.2.3', k: null, cs: true })
const statsFill = fillHeader({ e: 'stats', actions: ['ping', 'app_moved_to_foreground', 'app_moved_to_background'] })

function noNewWithFill(fill = updatesFill) {
  return new Response(JSON.stringify(NO_NEW_BODY), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Capgo-Edge-Fill': fill } })
}

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
    // No owner org in a header the device can read.
    expect(stat).toEqual({ e: 'updates', b: JSON.stringify(body), n: '1.2.3' })
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
      headers: { 'X-Capgo-Edge-Fill': fillHeader({ e: 'updates', n: '1.2.3', k: null, cs: false, bps: 1 }) },
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

    // Installs, failures, actions the worker does not list and native versions it would reject go to the worker.
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'set' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'download_fail' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'unknown_action' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build: 'bad-version' })]))
    expect(fetchMock).toHaveBeenCalledTimes(5)
    await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build: '2.1' })]))
    expect(fetchMock).toHaveBeenCalledTimes(5)
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

  it('sends /stats to the worker when the stat header would be cut by Logpush', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const events = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer)) as unknown[]
      return new Response(JSON.stringify({ status: 'ok', results: events.map((_, index) => ({ status: 'ok', index })) }), {
        status: 200,
        headers: { 'X-Capgo-Edge-Fill': statsFill },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/stats', [statsEvent()]))

    // Under the 6000 byte body cap, but JSON escaping plus base64 passes 8000.
    const batch = Array.from({ length: 28 }, () => statsEvent())
    expect(JSON.stringify(batch).length).toBeLessThan(6000)
    const response = await snippet.fetch(buildRequest('/stats', batch))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(response.headers.get('X-Capgo-Edge-Stat')).toBeNull()
  })

  it('keeps every path within the 5 subrequest snippet budget', async () => {
    let failPrimary = true
    const fetchMock = vi.fn(async (url: unknown) => {
      if (failPrimary && new URL(String(url)).origin === 'https://plugin.eu.capgo.app')
        return new Response('upstream error', { status: 502 })
      return new Response(JSON.stringify(NO_NEW_BODY), { status: 200, headers: { 'X-Capgo-Edge-Fill': updatesFill } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(buildRequest('/updates', updatesBody()))
    expect(response.status).toBe(200)
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
    // The answer seen after a failed worker is served but not learned.
    expect([...cache.store.keys()].some(key => key.includes('/edge-v4/'))).toBe(false)

    failPrimary = false
    cache.match.mockClear()
    cache.put.mockClear()
    cache.delete.mockClear()
    fetchMock.mockClear()
    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
  })

  it('never brings back an answer a purge removed when another channel refills', async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(new TextDecoder().decode(init?.body as ArrayBuffer))
      return noNewWithFill(body.defaultChannel === 'beta' ? fillHeader({ e: 'updates', n: '9.9.9', k: null, cs: true }) : updatesFill)
    })
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))
    // A channel change purges the app tags.
    cache.store.clear()
    await snippet.fetch(buildRequest('/updates', updatesBody({ defaultChannel: 'beta', version_name: '9.9.9' })))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('replaces the answer of a channel with the newer fill', async () => {
    let served = '1.2.3'
    const fetchMock = vi.fn(async () => noNewWithFill(fillHeader({ e: 'updates', n: served, k: null, cs: true })))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))
    served = '2.0.0'
    await snippet.fetch(buildRequest('/updates', updatesBody({ version_name: '2.0.0' })))
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID, version_name: '2.0.0' })))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('shares IP limits between the hosts of the same workers', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    let limited = false
    const fetchMock = vi.fn(async () => limited
      ? new Response(JSON.stringify({ error: 'on_premise_app' }), { status: 429, headers: { 'Cache-Control': 'private, no-store', 'X-Capgo-Edge-Ip-Limit': String(resetAt) } })
      : noNewWithFill())
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody(), {}, { host: 'api.capgo.app' }))

    limited = true
    await snippet.fetch(buildRequest('/updates', updatesBody({ version_name: '0.0.1' })))
    const guess = await snippet.fetch(buildRequest('/updates', updatesBody(), {}, { host: 'api.capgo.app' }))
    expect(guess.status).toBe(429)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('calls the worker when the IP limit lookup fails', async () => {
    const fetchMock = vi.fn(async () => noNewWithFill())
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))
    const match = cache.match.getMockImplementation()!
    cache.match.mockImplementation(async (key) => {
      if (String(key instanceof Request ? key.url : key).includes('/edge-ip-limit-v1/'))
        throw new Error('cache unavailable')
      return match(key)
    })
    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('stores the IP limit even after a worker failure', async () => {
    const resetAt = Math.floor(Date.now() / 1000) + 600
    let limited = false
    const fetchMock = vi.fn(async (url: unknown) => {
      if (!limited)
        return noNewWithFill()
      if (new URL(String(url)).origin === 'https://plugin.eu.capgo.app')
        return new Response('upstream error', { status: 502 })
      return new Response(JSON.stringify({ error: 'on_premise_app' }), { status: 429, headers: { 'Cache-Control': 'private, no-store', 'X-Capgo-Edge-Ip-Limit': String(resetAt) } })
    })
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))

    limited = true
    cache.match.mockClear()
    cache.put.mockClear()
    cache.delete.mockClear()
    fetchMock.mockClear()
    await snippet.fetch(buildRequest('/updates', updatesBody({ version_name: '0.0.1' })))
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
    expect([...cache.store.keys()].some(key => key.includes('/edge-ip-limit-v1/'))).toBe(true)
  })

  it('reaches the third worker of a zone when the first two fail', async () => {
    const fetchMock = vi.fn(async (url: unknown) => new URL(String(url)).origin === 'https://plugin.as.capgo.app'
      ? noNewWithFill()
      : new Response('upstream error', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const response = await snippet.fetch(buildRequest('/updates', updatesBody(), {}, { colo: 'HKG' }))
    expect(response.status).toBe(200)
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).origin)).toEqual(['https://plugin.hk.capgo.app', 'https://plugin.jp.capgo.app', 'https://plugin.as.capgo.app'])
    expect(subrequests(cache, fetchMock)).toBeLessThanOrEqual(5)
  })

  it('answers only the paths Logpush ships', async () => {
    const fetchMock = vi.fn(async () => noNewWithFill())
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates/', updatesBody()))
    await snippet.fetch(buildRequest('/updates/', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('skips the edge entry for a default channel too long to key on', async () => {
    const fetchMock = vi.fn(async () => noNewWithFill())
    vi.stubGlobal('fetch', fetchMock)
    const body = updatesBody({ defaultChannel: 'x'.repeat(200) })
    await snippet.fetch(buildRequest('/updates', body))
    await snippet.fetch(buildRequest('/updates', { ...body, device_id: OTHER_DEVICE_ID }))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cache.put).not.toHaveBeenCalled()
  })

  it('ignores fills of the previous format', async () => {
    const fetchMock = vi.fn(async () => noNewWithFill(encodeURIComponent(JSON.stringify({ v: 1, bps: 10000, ttl: 900, tags: 't', e: 'updates', n: '1.2.3', k: null, o: 'org-1', a: true, cs: true }))))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/updates', updatesBody()))
    await snippet.fetch(buildRequest('/updates', updatesBody({ device_id: OTHER_DEVICE_ID })))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
