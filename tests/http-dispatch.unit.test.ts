import type { HttpDispatchRow } from '../supabase/functions/_backend/utils/http_dispatch.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueueDispatcher } from '../cloudflare_workers/api/queue_dispatcher.ts'
import {
  buildHttpDispatchRequests,
  dispatchAllowedOrigins,
  HTTP_DISPATCH_CLAIM_LIMIT,
  HTTP_DISPATCH_MAX_CALLS_PER_ROW,
  isAllowedDispatchUrl,
} from '../supabase/functions/_backend/utils/http_dispatch.ts'

const { queryMock, closeClientMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  closeClientMock: vi.fn(),
}))

vi.mock('../supabase/functions/_backend/utils/pg.ts', () => ({
  getPgClient: vi.fn(async () => ({ query: queryMock })),
  closeClient: closeClientMock,
}))

const ORIGIN = 'https://project.supabase.co'
const CONSUMER_URL = `${ORIGIN}/functions/v1/triggers/queue_consumer/sync`

function row(overrides: Partial<HttpDispatchRow> = {}): HttpDispatchRow {
  return {
    id: '1',
    target: 'on_app_update',
    url: CONSUMER_URL,
    body: { queue_name: 'on_app_update', batch_size: 100, wait_for_completion: false },
    timeout_ms: 8000,
    calls: 1,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('http dispatch requests', () => {
  it.concurrent('sends one POST per call with the API secret and the stored body', () => {
    const { requests, rejected } = buildHttpDispatchRequests([row({ calls: 3 })], 'secret', [ORIGIN])

    expect(rejected).toEqual([])
    expect(requests).toHaveLength(3)
    expect(requests[0]).toEqual({
      target: 'on_app_update',
      url: CONSUMER_URL,
      timeoutMs: 8000,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apisecret': 'secret' },
        body: JSON.stringify({ queue_name: 'on_app_update', batch_size: 100, wait_for_completion: false }),
      },
    })
  })

  it.concurrent('caps calls per row like process_function_queue', () => {
    const { requests } = buildHttpDispatchRequests([row({ calls: 50 })], 'secret', [ORIGIN])
    expect(requests).toHaveLength(HTTP_DISPATCH_MAX_CALLS_PER_ROW)
  })

  it.concurrent('never sends the API secret to an origin that is not allowed', () => {
    const foreign = row({ id: '2', url: 'https://attacker.example/functions/v1/triggers/queue_consumer/sync' })
    const { requests, rejected } = buildHttpDispatchRequests([row(), foreign, row({ id: '3', url: 'not a url' })], 'secret', [ORIGIN])

    expect(requests.map(request => request.url)).toEqual([CONSUMER_URL])
    expect(rejected.map(rejectedRow => rejectedRow.id)).toEqual(['2', '3'])
  })

  it.concurrent('builds the allowlist from configured origins', () => {
    expect(dispatchAllowedOrigins(['https://sb.capgo.app', undefined, ' ', `${ORIGIN}/rest/v1`, ORIGIN, 'bad'])).toEqual(['https://sb.capgo.app', ORIGIN])
    expect(isAllowedDispatchUrl(`${ORIGIN}.evil.example/x`, [ORIGIN])).toBe(false)
  })
})

function createDispatcher(claimResponse: () => Promise<Response>, env: Record<string, unknown> = {}) {
  const alarms: number[] = []
  const storage = {
    getAlarm: vi.fn(async () => alarms.at(-1) ?? null),
    setAlarm: vi.fn(async (time: number) => {
      alarms.push(time)
    }),
  }
  const apiSelf = { fetch: vi.fn(claimResponse) }
  const dispatcher = new QueueDispatcher(
    { storage } as never,
    { API_SECRET: 'secret', SUPABASE_URL: 'https://sb.capgo.app', HTTP_DISPATCH_ALLOWED_ORIGINS: ORIGIN, API_SELF: apiSelf, ...env } as never,
  )
  return { dispatcher, storage, apiSelf, alarms }
}

describe('QueueDispatcher', () => {
  it('claims through the self binding and sends every claimed call', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const { dispatcher, apiSelf, alarms } = createDispatcher(async () => Response.json({ rows: [row({ calls: 2 })] }))

    await dispatcher.alarm()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(alarms).toHaveLength(1)
    const [claimUrl, claimInit] = apiSelf.fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(claimUrl).toContain('/triggers/http_dispatch/claim')
    expect(claimInit.headers).toEqual({ apisecret: 'secret' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(CONSUMER_URL)
    expect((init.headers as Record<string, string>).apisecret).toBe('secret')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('does not wait for slow consumer calls before finishing the tick', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    const { dispatcher } = createDispatcher(async () => Response.json({ rows: [row({ timeout_ms: 100000 })] }))

    await expect(dispatcher.alarm()).resolves.toBeUndefined()
    const status = await (await dispatcher.fetch(new Request('https://queue-dispatcher.capgo.internal/ensure'))).json()
    expect(status).toEqual({ status: 'ok', inFlight: 1 })
  })

  it('keeps ticking when the claim fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { dispatcher, alarms } = createDispatcher(async () => new Response('boom', { status: 500 }))

    await expect(dispatcher.alarm()).resolves.toBeUndefined()
    expect(alarms).toHaveLength(1)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('queue_dispatcher_claim_failed'))
  })

  it('only arms an alarm when none is scheduled', async () => {
    const { dispatcher, storage } = createDispatcher(async () => Response.json({ rows: [] }))

    await dispatcher.fetch(new Request('https://queue-dispatcher.capgo.internal/ensure'))
    await dispatcher.fetch(new Request('https://queue-dispatcher.capgo.internal/ensure'))
    expect(storage.setAlarm).toHaveBeenCalledTimes(1)
  })
})

describe('http_dispatch claim route', () => {
  it('requires the API secret and returns the claimed rows', async () => {
    const { app } = await import('../supabase/functions/_backend/triggers/http_dispatch.ts')
    // Hono reads process.env in Node, so the bindings argument is not enough.
    vi.stubEnv('API_SECRET', 'secret')
    const env = { API_SECRET: 'secret' }

    const denied = await app.request('/claim', { method: 'POST' }, env)
    expect(denied.ok).toBe(false)
    expect(queryMock).not.toHaveBeenCalled()

    queryMock.mockResolvedValueOnce({ rows: [row()] })
    const response = await app.request('/claim', { method: 'POST', headers: { apisecret: 'secret' } }, env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ rows: [row()] })
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/DELETE FROM public\.http_dispatch_outbox/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(params).toEqual([HTTP_DISPATCH_CLAIM_LIMIT])
    expect(closeClientMock).toHaveBeenCalledTimes(1)
  })
})
