import { tryParse } from '@std/semver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import snippet from '../cloudflare_workers/snippet/index.js'
import { PROVIDER_INFRA_ASNS } from '../supabase/functions/_backend/plugin_runtime/utils/providerAsns.ts'
import { decodeSnippetEdgeStat } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'
import { updatesEdgeCacheBucket } from '../supabase/functions/_backend/plugin_runtime/utils/updatesEdgeCache.ts'
import { fixSemver } from '../supabase/functions/_backend/plugin_runtime/utils/utils.ts'

const PLAIN_SEMVER_RE = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/

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

function buildRequest(path: string, body: unknown, headers: Record<string, string> = {}, options: { host?: string, colo?: string, asn?: number } = {}) {
  const request = new Request(`https://${options.host ?? 'plugin.capgo.app'}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.7', ...headers },
    body: JSON.stringify(body),
  })
  Object.defineProperty(request, 'cf', { value: { colo: options.colo ?? 'CDG', asn: options.asn ?? 3215 } })
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

/** The snippet's /stats learning sample: FNV bucket of app, device and minute under 500 bps. */
function isLearnSample(deviceId: string, minute: number) {
  return updatesEdgeCacheBucket(APP_ID, `${deviceId}:${minute}`) < 500
}

/** A time (ms) in the first minute that matches. */
function minuteWhere(predicate: (minute: number) => boolean) {
  for (let minute = 29_700_000; ; minute++) {
    if (predicate(minute))
      return minute * 60_000
  }
}

/** Both test devices teach the worker: /stats without a fill reach it. */
const LEARN_TIME = minuteWhere(minute => isLearnSample(DEVICE_ID, minute) && isLearnSample(OTHER_DEVICE_ID, minute))
/** Neither does: /stats without a fill are answered at the edge. */
const ANSWER_TIME = minuteWhere(minute => !isLearnSample(DEVICE_ID, minute) && !isLearnSample(OTHER_DEVICE_ID, minute))

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
    // /stats without a fill: the test devices are in the learning sample, so
    // the fill tests below reach the worker first.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(LEARN_TIME)
    cache = buildCache()
    vi.stubGlobal('caches', { default: cache })
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('leaves provider networks to the worker for apps that block provider infrastructure', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'X-Capgo-Edge-Fill': fillHeader({ v: 3, e: 'stats', actions: ['app_moved_to_foreground'], pa: [15169, 714] }) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const answered = await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(answered.headers.get('X-Capgo-Edge')).toBe('answer')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await snippet.fetch(buildRequest('/stats', statsEvent(), {}, { asn: 15169 }))
    await snippet.fetch(buildRequest('/stats', statsEvent(), {}, { asn: 714 }))
    const unknownNetwork = new Request('https://plugin.capgo.app/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsEvent()) })
    Object.defineProperty(unknownNetwork, 'cf', { value: { colo: 'CDG' } })
    await snippet.fetch(unknownNetwork)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('ignores provider networks a v2 fill carries, and v3 fills without them', async () => {
    for (const fill of [fillHeader({ e: 'stats', actions: ['app_moved_to_foreground'], pa: [15169] }), fillHeader({ v: 3, e: 'stats', actions: ['app_moved_to_foreground'] })]) {
      cache.store.clear()
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'X-Capgo-Edge-Fill': fill } }))
      vi.stubGlobal('fetch', fetchMock)
      await snippet.fetch(buildRequest('/stats', statsEvent()))
      await snippet.fetch(buildRequest('/stats', statsEvent()))
      expect(fetchMock).toHaveBeenCalledTimes(2)
    }
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

  it('answers /stats batches once learned, keeping installs and failures live', async () => {
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

    // Actions the fill does not list are replayed (the handler rejects unknown
    // ones). Installs, failures (also inside a batch), native versions the
    // worker would reject and actions that are not a word go to the worker.
    const unknown = await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'unknown_action' })]))
    expect(unknown.headers.get('X-Capgo-Edge')).toBe('answer')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'set' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'download_fail' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent(), statsEvent({ action: 'update_fail' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build: 'bad-version' })]))
    await snippet.fetch(buildRequest('/stats', [statsEvent({ action: 'not an action' })]))
    expect(fetchMock).toHaveBeenCalledTimes(6)
    await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build: '2.1' })]))
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('answers /stats native versions only when the worker parses them', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'X-Capgo-Edge-Fill': statsFill } }))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/stats', [statsEvent()]))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // parsePluginBody: plain x.y.z, or @std/semver tryParse(fixSemver(version)).
    const workerParses = (version: string) => PLAIN_SEMVER_RE.test(version) || tryParse(fixSemver(version)) !== undefined
    const versions = [
      '0.9.315-native.0.0.1',
      '0.9.314-native.93140001',
      '1.2.3+ota.8016.ios',
      '1.2.3-beta.1+build.5',
      'v1.2.3',
      '2.1',
      '1-rc',
      '1.0-beta.1',
      '1.2.3-01',
      '1.2.3-',
      '1.2.3+',
      '1.2.3_4',
      '01.2.3',
      ' 1.2.3',
      '1.2.3.4',
      '9007199254740993.0.0',
      `1.2.3-${'a'.repeat(260)}`,
    ]
    let forwarded = 1
    for (const version_build of versions) {
      const response = await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build })]))
      const answered = response.headers.get('X-Capgo-Edge') === 'answer'
      if (!answered)
        forwarded++
      expect(fetchMock).toHaveBeenCalledTimes(forwarded)
      // Never answer a version the worker rejects with semver_error.
      if (answered)
        expect(workerParses(version_build), version_build).toBe(true)
    }
    // The prerelease and build tags of real plugins are answered.
    for (const version_build of versions.slice(0, 6)) {
      const response = await snippet.fetch(buildRequest('/stats', [statsEvent({ version_build })]))
      expect(response.headers.get('X-Capgo-Edge'), version_build).toBe('answer')
    }
  })

  it('answers /stats of an app it learned nothing about, outside the learning share', async () => {
    vi.setSystemTime(ANSWER_TIME)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const single = statsEvent({ action: 'app_launch_ready' })
    const answered = await snippet.fetch(buildRequest('/stats', single))
    expect(answered.status).toBe(200)
    expect(answered.headers.get('X-Capgo-Edge')).toBe('answer')
    expect(await answered.json()).toEqual({ status: 'ok' })
    expect(decodeSnippetEdgeStat(answered.headers.get('X-Capgo-Edge-Stat')!)).toEqual({ e: 'stats', b: JSON.stringify(single) })

    const batch = [statsEvent({ action: 'app_moved_to_background' }), statsEvent({ device_id: OTHER_DEVICE_ID })]
    const answeredBatch = await snippet.fetch(buildRequest('/stats', batch))
    expect(await answeredBatch.json()).toEqual({ status: 'ok', results: [{ status: 'ok', index: 0 }, { status: 'ok', index: 1 }] })
    expect(fetchMock).not.toHaveBeenCalled()
    // One lookup each, nothing stored.
    expect(cache.match).toHaveBeenCalledTimes(2)
    expect(cache.put).not.toHaveBeenCalled()

    // Not answerable: installs and failures, browsers, other app ids in a
    // batch, bad schema, empty batches.
    await snippet.fetch(buildRequest('/stats', statsEvent({ action: 'set' })))
    await snippet.fetch(buildRequest('/stats', statsEvent({ action: 'download_fail' })))
    await snippet.fetch(buildRequest('/stats', statsEvent(), { Origin: 'https://example.com' }))
    await snippet.fetch(buildRequest('/stats', [statsEvent(), statsEvent({ app_id: 'com.other.app' })]))
    await snippet.fetch(buildRequest('/stats', statsEvent({ device_id: 'not-a-uuid' })))
    await snippet.fetch(buildRequest('/stats', []))
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('sends /stats of provider networks to the worker while nothing is learned', async () => {
    vi.setSystemTime(ANSWER_TIME)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'provider_infrastructure_request_blocked' }), { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    // Every PROVIDER_INFRA_ASNS network, and a request of unknown network.
    for (const asn of PROVIDER_INFRA_ASNS)
      expect((await snippet.fetch(buildRequest('/stats', statsEvent(), {}, { asn }))).status).toBe(429)
    const unknownNetwork = new Request('https://plugin.capgo.app/stats', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statsEvent()) })
    Object.defineProperty(unknownNetwork, 'cf', { value: { colo: 'CDG' } })
    await snippet.fetch(unknownNetwork)
    expect(fetchMock).toHaveBeenCalledTimes(PROVIDER_INFRA_ASNS.length + 1)
    // A blocked answer teaches nothing: the next one still goes to the worker.
    await snippet.fetch(buildRequest('/stats', statsEvent(), {}, { asn: PROVIDER_INFRA_ASNS[0] }))
    expect(fetchMock).toHaveBeenCalledTimes(PROVIDER_INFRA_ASNS.length + 2)
    const answered = await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(answered.headers.get('X-Capgo-Edge')).toBe('answer')
  })

  it('sends the learning share of /stats without a fill to the worker', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // A batch follows its first event: answered when only a later device is sampled...
    vi.setSystemTime(minuteWhere(minute => !isLearnSample(DEVICE_ID, minute) && isLearnSample(OTHER_DEVICE_ID, minute)))
    const answered = await snippet.fetch(buildRequest('/stats', [statsEvent(), statsEvent({ device_id: OTHER_DEVICE_ID })]))
    expect(answered.headers.get('X-Capgo-Edge')).toBe('answer')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // ...and sent to the worker when its first device is.
    await snippet.fetch(buildRequest('/stats', [statsEvent({ device_id: OTHER_DEVICE_ID }), statsEvent()]))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // About 5% of devices per minute.
    const sampled = Array.from({ length: 4000 }, (_, i) => isLearnSample(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 29_700_000)).filter(Boolean).length
    expect(sampled).toBeGreaterThan(120)
    expect(sampled).toBeLessThan(280)
  })

  it('sends /stats to the worker when the app entry lookup fails', async () => {
    vi.setSystemTime(ANSWER_TIME)
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    cache.match.mockRejectedValueOnce(new Error('cache unavailable'))
    const response = await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(response.headers.get('X-Capgo-Edge')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps serving a learned on-prem /stats 429 instead of answering it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected', isOnprem: true }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '600', 'Cache-Control': 'public, max-age=600' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    vi.setSystemTime(ANSWER_TIME)
    const cached = await snippet.fetch(buildRequest('/stats', statsEvent()))
    expect(cached.status).toBe(429)
    expect(cached.headers.get('X-Capgo-Edge-Stat')).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

function onPremRequest(body: Record<string, unknown>) {
  return buildRequest('/updates', body, {}, { host: 'api.capgo.app', colo: 'SFO' })
}

function onPremResponse(headers: Record<string, string> = { 'Cache-Control': 'public, max-age=60' }, body: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error: 'on_premise_app', message: 'On-premise app detected', ...body }), { status: 429, headers })
}

function edgeCachePuts(cache: Cache) {
  return cache.put.mock.calls.map(([key]) => key instanceof Request ? key.url : String(key)).filter(key => key.includes('/__internal__/edge-v4/'))
}

describe('cloudflare snippet on-prem fallback', () => {
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

  it('returns and caches on-prem from the first worker without a confirming fetch', async () => {
    const body = { app_id: 'com.external.app' }
    const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app')
        return onPremResponse()
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(onPremRequest(body))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-Cached')).toBe('false')
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    // One worker fetch only: the snippet subrequest budget (5 on Enterprise) has no room for a confirm.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://plugin.na.capgo.app/updates')
    await expect(new Response(fetchMock.mock.calls[0][1]?.body).json()).resolves.toEqual(body)
    expect(edgeCachePuts(cache).length).toBeGreaterThan(0)
  })

  it('returns on-prem from a fallback worker without caching when the primary fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = new URL(String(url))
      if (target.origin === 'https://plugin.na.capgo.app')
        return new Response('upstream error', { status: 502 })
      if (target.origin === 'https://plugin.eu.capgo.app')
        return onPremResponse()
      throw new Error(`Unexpected fetch target ${target.href}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(onPremRequest({ app_id: 'com.external.app' }))

    expect(response.status).toBe(429)
    expect(response.headers.get('X-Onprem-App-Id')).toBe('com.external.app')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // Partial outage: serve the on-prem answer but never cache it.
    expect(edgeCachePuts(cache)).toEqual([])
  })

  it('passes cloud responses through after a single worker fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const response = await snippet.fetch(onPremRequest({ app_id: 'com.cloud.valid' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(edgeCachePuts(cache)).toEqual([])
  })

  it('retains Retry-After on cached on-prem responses and skips the worker', async () => {
    const resetAt = Date.now() + 3_600_000
    const fetchMock = vi.fn(async () => onPremResponse({
      'Cache-Control': 'public, max-age=3600',
      'Retry-After': '3600',
      'X-RateLimit-Reset': String(Math.ceil(resetAt / 1000)),
    }, { moreInfo: { rateLimitResetAt: resetAt, retryAfterSeconds: 3600 } }))
    vi.stubGlobal('fetch', fetchMock)

    const body = { app_id: 'com.external.app' }
    const first = await snippet.fetch(onPremRequest(body))
    expect(first.status).toBe(429)
    expect(first.headers.get('Retry-After')).toBe('3600')
    expect(first.headers.get('X-RateLimit-Reset')).toBe(String(Math.ceil(resetAt / 1000)))
    expect(edgeCachePuts(cache)).toHaveLength(1)

    const second = await snippet.fetch(onPremRequest(body))
    expect(second.status).toBe(429)
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
