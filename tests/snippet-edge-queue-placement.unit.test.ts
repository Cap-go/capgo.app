import { afterEach, describe, expect, it, vi } from 'vitest'
import pluginWorker from '../cloudflare_workers/plugin/index.ts'
import { relaySnippetEdgeStatsMessage, SNIPPET_EDGE_STATS_CONSUME_PATH } from '../supabase/functions/_backend/plugin_runtime/utils/snippetEdgeReplay.ts'

const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as any
const notification = (key: string) => ({ action: 'PutObject', object: { key } })

function batchOf(bodies: unknown[]) {
  const messages = bodies.map((body, index) => ({ id: `m${index}`, body, ack: vi.fn(), retry: vi.fn() }))
  return { batch: { queue: 'capgo-snippet-edge-stats-files', messages } as any, messages }
}

/** R2 and queue bindings for a files notification whose log object is already gone. */
function statsBindings(get = vi.fn(async (_key: string) => null)) {
  return { SNIPPET_EDGE_STATS_LOGS: { get }, SNIPPET_EDGE_STATS_REPLAY: { sendBatch: vi.fn(), send: vi.fn() } }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('snippet edge stats queue placement', () => {
  it('relays each message to the placed fetch handler, with the API secret', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ status: 'ok' }))
    const { batch, messages } = batchOf([{ a: 1 }, notification('20261127/b.log')])
    await pluginWorker.queue(batch, { PLACED_SELF: { fetch }, API_SECRET: 'relay-secret' } as any, ctx)

    expect(fetch).toHaveBeenCalledTimes(2)
    const [url, init] = fetch.mock.calls[1]!
    expect(url).toBe(`https://plugin.capgo.app${SNIPPET_EDGE_STATS_CONSUME_PATH}`)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('apisecret')).toBe('relay-secret')
    expect(JSON.parse(String(init.body))).toEqual({ id: 'm1', body: notification('20261127/b.log') })
    for (const message of messages) {
      expect(message.ack).toHaveBeenCalledOnce()
      expect(message.retry).not.toHaveBeenCalled()
    }
  })

  it('retries only the messages the placed handler failed', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"boom"}', { status: 500 }))
      .mockResolvedValueOnce(Response.json({ status: 'ok' }))
    const { batch, messages } = batchOf([{ a: 1 }, { b: 2 }])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await pluginWorker.queue(batch, { PLACED_SELF: { fetch }, API_SECRET: 'relay-secret' } as any, ctx)

    expect(messages[0]!.retry).toHaveBeenCalledOnce()
    expect(messages[0]!.ack).not.toHaveBeenCalled()
    expect(messages[1]!.ack).toHaveBeenCalledOnce()
  })

  it('handles messages in process without the binding (local)', async () => {
    const env = statsBindings()
    const { batch, messages } = batchOf([notification('20261127/a.log')])
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await pluginWorker.queue(batch, env as any, ctx)

    expect(env.SNIPPET_EDGE_STATS_LOGS.get).toHaveBeenCalledWith('20261127/a.log')
    expect(messages[0]!.ack).toHaveBeenCalledOnce()
  })

  it('refuses to relay without the API secret', async () => {
    const fetch = vi.fn()
    await expect(relaySnippetEdgeStatsMessage({ PLACED_SELF: { fetch } } as any, 'm0', {})).rejects.toThrow('API_SECRET')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('snippet edge stats consume route', () => {
  function consume(body: unknown, env: Record<string, unknown>, secret?: string) {
    return pluginWorker.fetch(new Request(`https://plugin.capgo.app${SNIPPET_EDGE_STATS_CONSUME_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret ? { apisecret: secret } : {}) },
      body: JSON.stringify(body),
    }), env as any, ctx)
  }

  it('requires the API secret', async () => {
    vi.stubEnv('API_SECRET', 'relay-secret')
    const env = statsBindings()
    expect((await consume({ id: 'm0', body: notification('20261127/a.log') }, env)).status).toBe(401)
    expect((await consume({ id: 'm0', body: notification('20261127/a.log') }, env, 'wrong')).status).toBe(401)
    expect(env.SNIPPET_EDGE_STATS_LOGS.get).not.toHaveBeenCalled()
  })

  it('rejects a body that is not a relayed message', async () => {
    vi.stubEnv('API_SECRET', 'relay-secret')
    const env = statsBindings()
    expect((await consume({ body: {} }, env, 'relay-secret')).status).toBe(400)
    expect((await consume(null, env, 'relay-secret')).status).toBe(400)
    expect(env.SNIPPET_EDGE_STATS_LOGS.get).not.toHaveBeenCalled()
  })

  it('runs the message in process', async () => {
    vi.stubEnv('API_SECRET', 'relay-secret')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const env = statsBindings()
    const response = await consume({ id: 'm0', body: notification('20261127/a.log') }, env, 'relay-secret')
    expect(response.status).toBe(200)
    expect(env.SNIPPET_EDGE_STATS_LOGS.get).toHaveBeenCalledWith('20261127/a.log')
  })

  it('answers 5xx when the message must be retried', async () => {
    vi.stubEnv('API_SECRET', 'relay-secret')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const env = statsBindings(vi.fn(async () => {
      throw new Error('R2 unavailable')
    }))
    const response = await consume({ id: 'm0', body: notification('20261127/a.log') }, env, 'relay-secret')
    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
