import { describe, expect, it, vi } from 'vitest'
import { cleanupPreviewBundles } from '../scripts/cleanup-pr-preview-bundles'

const config = { appId: 'com.example.preview', apiKey: 'test-key', prNumber: '42', runNumber: '100', runAttempt: '2' }
const version = (run: number, attempt = 1, pr = 42, base = '1.0.0') => `${base}-pr.${pr}.${run}.${attempt}`
const bundle = (id: number, name = version(id)) => ({ id, name, app_id: config.appId, deleted: false })
const channel = (id: number, active: number | null, rollout: number | null = null) => ({
  id, app_id: config.appId, version: active === null ? null : { id: active, name: 'linked' }, rollout_version: rollout,
})

function harness(bundles: unknown[][] = [[]], channels: unknown[][] = [[]]) {
  const events: string[] = []
  const log = vi.fn()
  const sleep = vi.fn(async () => {})
  const fetch = vi.fn(async (url: URL, init: RequestInit): Promise<Response> => {
    const page = Number(url.searchParams.get('page'))
    events.push(`${init.method} ${url.pathname} ${page}`)
    expect(init.headers).toMatchObject({ Authorization: config.apiKey })
    expect(url.origin).toBe('https://api.capgo.app')
    expect(init.redirect).toBe('error')
    if (init.method === 'DELETE') {
      const body = JSON.parse(String(init.body))
      expect(body.app_id).toBe(config.appId)
      expect(body.version).toMatch(/-pr\.42\.\d+\.\d+$/)
      return Response.json({ status: 'ok' })
    }
    expect(url.searchParams.get('app_id')).toBe(config.appId)
    return Response.json((url.pathname === '/bundle' ? bundles : channels)[page] ?? [])
  })
  return { fetch, log, sleep, events }
}

describe('PR preview bundle cleanup', () => {
  it.concurrent('snapshots all pages before deleting and preserves other PRs, current/future runs and active/rollout bundles', async () => {
    const h = harness([
      [bundle(1, version(1)), bundle(2, version(99, 7, 42, '2.0.0-alpha.1')), bundle(3, version(100, 1))],
      [bundle(4, version(90)), bundle(5, version(91)), bundle(6, version(1, 1, 420)), bundle(7, '1.0.0')],
      [bundle(8, version(100, 2)), bundle(9, version(100, 3)), bundle(10, version(101)), bundle(11, `${version(1)}-extra`), bundle(12, '1.0.0-PR.42.1.1')],
    ], [[channel(1, null)], [channel(2, 4, 5)]])
    const summary = await cleanupPreviewBundles(config, h)
    expect(summary).toMatchObject({ scanned: 12, candidates: 3, linked: 2, deleted: 3, failed: 0 })
    const deletes = h.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')
    expect(deletes.map(([, init]) => JSON.parse(String(init.body)).version).sort()).toEqual([
      version(1), version(99, 7, 42, '2.0.0-alpha.1'), version(100, 1),
    ].sort())
    expect(h.events.slice(0, h.events.findIndex(event => event.startsWith('DELETE')))).toEqual([
      'GET /bundle 0', 'GET /bundle 1', 'GET /bundle 2', 'GET /bundle 3',
      'GET /channel 0', 'GET /channel 1', 'GET /channel 2',
      'GET /channel 0', 'GET /channel 1', 'GET /channel 2',
    ])
  })

  it.concurrent('does not skip rows when deletion shrinks the paginated list', async () => {
    const remaining = Array.from({ length: 120 }, (_, i) => bundle(i + 1, version(10, i + 1)))
    const h = harness()
    h.fetch.mockImplementation(async (url, init) => {
      if (init.method === 'DELETE') {
        const name = JSON.parse(String(init.body)).version
        remaining.splice(remaining.findIndex(row => row.name === name), 1)
        return Response.json({ status: 'ok' })
      }
      const page = Number(url.searchParams.get('page'))
      return Response.json(url.pathname === '/channel' ? [] : remaining.slice(page * 50, (page + 1) * 50))
    })
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ deleted: 120 })
    expect(remaining).toEqual([])
  })

  it.concurrent.each([
    { appId: '' }, { apiKey: '' }, { prNumber: '0' }, { prNumber: '42junk' },
    { runNumber: '' }, { runAttempt: '1.5' }, { runNumber: '9007199254740992' },
  ])('rejects malformed configuration before any request: %j', async (override) => {
    const h = harness()
    await expect(cleanupPreviewBundles({ ...config, ...override }, h)).rejects.toThrow()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it.concurrent.each([
    [[bundle(1, '')], []],
    [[{ ...bundle(1), app_id: 'com.example.other' }], []],
    [[{ ...bundle(1), id: null }], []],
    [[bundle(1)], [{ id: 1, app_id: config.appId }]],
    [[bundle(1)], [{ ...channel(1, null), rollout_version: '1' }]],
  ])('fails closed on malformed API rows without sending any DELETE', async (bundles, channels) => {
    const h = harness([bundles], [channels])
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow()
    expect(h.fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
  })

  it.concurrent('rejects response wrappers and repeated pagination instead of deleting a partial inventory', async () => {
    const h = harness()
    h.fetch.mockResolvedValueOnce(Response.json({ data: [bundle(1)] }))
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('array')
    const repeated = harness([[bundle(1)], [bundle(1)]])
    await expect(cleanupPreviewBundles(config, repeated)).rejects.toThrow('pagination')
    expect(repeated.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it.concurrent('limits delete concurrency to four', async () => {
    const h = harness([Array.from({ length: 13 }, (_, i) => bundle(i + 1))])
    const original = h.fetch.getMockImplementation()!
    let active = 0
    let maximum = 0
    h.fetch.mockImplementation(async (url, init) => {
      if (init.method !== 'DELETE')
        return original(url, init)
      active++
      maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active--
      return Response.json({ status: 'ok' })
    })
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ deleted: 13 })
    expect(maximum).toBe(4)
  })

  it.concurrent.each([408, 429, 500, 502, 503, 504])('retries transient DELETE HTTP %i with visible backoff', async (status) => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    let deletes = 0
    h.fetch.mockImplementation((url, init) => init.method === 'DELETE' && ++deletes === 1
      ? Promise.resolve(Response.json({ error: 'temporarily_unavailable' }, { status, headers: { 'Retry-After': '2' } }))
      : original(url, init))
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ deleted: 1, failed: 0 })
    expect(h.sleep).toHaveBeenCalledWith(2000)
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`))
    expect(deletes).toBe(2)
    const bodies = h.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE').map(([, init]) => init.body)
    const expectedBody = JSON.stringify({ app_id: config.appId, version: version(1) })
    expect(bodies).toEqual([expectedBody, expectedBody])
  })

  it.concurrent.each([400, 401, 403, 404, 422])('does not retry permanent HTTP %i failures', async (status) => {
    const h = harness()
    h.fetch.mockResolvedValueOnce(Response.json({ error: 'denied' }, { status }))
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow(`HTTP ${status}`)
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.sleep).not.toHaveBeenCalled()
  })

  it.concurrent('bounds network retries, reports exhaustion and never prints the token', async () => {
    const h = harness()
    h.fetch.mockRejectedValue(new TypeError(`network error containing ${config.apiKey}`))
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('network')
    expect(h.fetch).toHaveBeenCalledTimes(3)
    expect(h.sleep.mock.calls).toEqual([[1000], [2000]])
    expect(h.log.mock.calls.flat().join('\n')).not.toContain(config.apiKey)
  })

  it.concurrent('retries request timeouts, but fails immediately on invalid success JSON', async () => {
    const h = harness()
    h.fetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    await cleanupPreviewBundles(config, h)
    expect(h.fetch).toHaveBeenCalledTimes(3)
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('request timed out'))
    const malformed = harness()
    malformed.fetch.mockResolvedValueOnce(new Response('invalid JSON'))
    await expect(cleanupPreviewBundles(config, malformed)).rejects.toBeInstanceOf(SyntaxError)
    expect(malformed.fetch).toHaveBeenCalledTimes(1)
  })

  it.concurrent('honors Retry-After dates and refuses a retry beyond the total budget', async () => {
    const h = harness()
    h.fetch.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 1970 00:00:04 GMT' } }))
    await cleanupPreviewBundles(config, { ...h, now: () => 0 })
    expect(h.sleep).toHaveBeenCalledWith(4000)
    const limited = harness()
    limited.fetch.mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '300' } }))
    await expect(cleanupPreviewBundles(config, limited)).rejects.toThrow('budget')
    expect(limited.sleep).not.toHaveBeenCalled()
    expect(limited.fetch).toHaveBeenCalledTimes(1)
  })

  it.concurrent('never deletes a partial snapshot when a later page fails', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    h.fetch.mockImplementation((url, init) => url.searchParams.get('page') === '1'
      ? Promise.resolve(Response.json({ error: 'denied' }, { status: 403 }))
      : original(url, init))
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('HTTP 403')
    expect(h.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
  })

  it.concurrent('refreshes every channel page before DELETE, including new links beyond the server row cap', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    const channels = Array.from({ length: 1001 }, (_, i) => channel(i + 1, i === 1000 ? 1 : null))
    let inventories = 0
    h.fetch.mockImplementation((url, init) => {
      if (url.pathname !== '/channel')
        return original(url, init)
      const page = Number(url.searchParams.get('page'))
      if (page === 0)
        inventories++
      return Promise.resolve(Response.json(inventories === 1 ? [] : channels.slice(page * 50, (page + 1) * 50)))
    })
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ protected: 1, deleted: 0, failed: 0 })
    expect(h.fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
    expect(h.fetch.mock.calls.some(([url]) => url.pathname === '/channel' && url.searchParams.get('page') === '21')).toBe(true)
  })

  it.concurrent('refreshes channel links again before scheduling the next delete batch', async () => {
    const h = harness([Array.from({ length: 6 }, (_, i) => bundle(i + 1))])
    const original = h.fetch.getMockImplementation()!
    let deletes = 0
    h.fetch.mockImplementation((url, init) => {
      if (init.method === 'DELETE')
        deletes++
      if (url.pathname === '/channel' && deletes > 0 && url.searchParams.get('page') === '0')
        return Promise.resolve(Response.json([channel(1, 5)]))
      return original(url, init)
    })
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ protected: 1, deleted: 5, failed: 0 })
    expect(h.fetch.mock.calls.filter(([, init]) => init.method === 'DELETE').map(([, init]) => JSON.parse(String(init.body)).version)).not.toContain(version(5))
  })

  it.concurrent('stops before deleting when the fresh channel inventory fails', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    let inventories = 0
    h.fetch.mockImplementation((url, init) => {
      if (url.pathname === '/channel' && ++inventories === 2)
        return Promise.resolve(Response.json({ error: 'denied' }, { status: 403 }))
      return original(url, init)
    })
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('HTTP 403')
    expect(h.fetch.mock.calls.some(([, init]) => init.method === 'DELETE')).toBe(false)
  })

  it.concurrent('keeps server-guarded bundles if a channel links after the snapshot', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    h.fetch.mockImplementation((url, init) => init.method === 'DELETE'
      ? Promise.resolve(Response.json({ error: 'cannot_delete_linked_version' }, { status: 400 }))
      : original(url, init))
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ protected: 1, failed: 0, deleted: 0 })
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('cannot_delete_linked_version'))
  })

  it.concurrent('confirms absence after an ambiguous delete retry instead of hiding a failure', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    let deletes = 0
    h.fetch.mockImplementation((url, init) => {
      if (init.method === 'DELETE') {
        if (++deletes === 1)
          return Promise.reject(new TypeError('response lost after commit'))
        return Promise.resolve(Response.json({ error: 'cannot_delete_version' }, { status: 400 }))
      }
      return url.searchParams.has('version') ? Promise.resolve(Response.json([])) : original(url, init)
    })
    expect(await cleanupPreviewBundles(config, h)).toMatchObject({ absent: 1, failed: 0 })
    expect(deletes).toBe(2)
  })

  it.concurrent('reports failed deletes in the summary and exits unsuccessfully after other candidates finish', async () => {
    const h = harness([[bundle(1), bundle(2)]])
    const original = h.fetch.getMockImplementation()!
    h.fetch.mockImplementation((url, init) => init.method === 'DELETE' && JSON.parse(String(init.body)).version === version(1)
      ? Promise.resolve(Response.json({ error: 'cannot_delete_bundle' }, { status: 400 }))
      : original(url, init))
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('1 failed')
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('deleted=1'))
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('failed=1'))
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('cannot_delete_bundle'))
  })

  it.concurrent('does not accept a missing-version error unless a lookup confirms absence', async () => {
    const h = harness([[bundle(1)]])
    const original = h.fetch.getMockImplementation()!
    h.fetch.mockImplementation((url, init) => {
      if (init.method === 'DELETE')
        return Promise.resolve(Response.json({ error: 'cannot_delete_version' }, { status: 400 }))
      return url.searchParams.has('version') ? Promise.resolve(Response.json([bundle(1)])) : original(url, init)
    })
    await expect(cleanupPreviewBundles(config, h)).rejects.toThrow('1 failed')
  })

  it.concurrent('stops scheduling requests when the total budget expires and reports unfinished work', async () => {
    const h = harness([[bundle(1)]])
    let now = 0
    const original = h.fetch.getMockImplementation()!
    h.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init)
      if (url.pathname === '/channel')
        now = 270_001
      return response
    })
    await expect(cleanupPreviewBundles(config, { ...h, now: () => now })).rejects.toThrow('unfinished')
    expect(h.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true)
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('unfinished=1'))
  })
})
