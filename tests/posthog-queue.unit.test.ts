import type { MessageBatch } from '@cloudflare/workers-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueuePostHog, parsePostHogMessage, POSTHOG_MESSAGE_MAX_BYTES, POSTHOG_RETRY_DELAYS, processPostHogQueueBatch, replayablePostHogMessage } from '../supabase/functions/_backend/utils/posthog_queue.ts'

const { log } = vi.hoisted(() => ({ log: vi.fn() }))
vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({ cloudlog: log }))
const fetchMock = vi.fn()
const sendDlq = vi.fn()
const body = {
  version: 1,
  source: 'private_events',
  event_id: '031c6527-7d90-842d-9abd-17f442067e20',
  accepted_at: '2026-10-06T10:00:00.000Z',
  request_id: 'request-id',
  payload: {
    event: 'Private Example',
    channel: 'test',
    distinct_id: 'example-actor',
    description: 'private description',
    tags: { email: 'example@example.com' },
    groups: { organization: 'example-org' },
    ip: '192.0.2.1',
    timestamp: '2026-10-06T09:59:00.000Z',
  },
}

function entry(value: unknown = body, attempts = 1) {
  return { body: value, attempts, ack: vi.fn(), retry: vi.fn(), id: 'queue-id', timestamp: new Date() }
}
function batch(messages: ReturnType<typeof entry>[]) {
  return { queue: 'capgo-posthog-events-alpha', messages, ackAll: vi.fn(), retryAll: vi.fn() } as unknown as MessageBatch<unknown>
}
const env = { POSTHOG_API_KEY: 'runtime-key', POSTHOG_DLQ: { send: sendDlq } }

beforeEach(() => {
  fetchMock.mockResolvedValue(new Response('{"status":1}'))
  sendDlq.mockResolvedValue(undefined)
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('postHog queue consumer', () => {
  it.each(['{"status":1}', '{"status":"ok"}', '{"status":"Ok"}', '{"status":"Ok","quota_limited":[]}'])('acks successful capture response %s using current credentials and immutable identity/time', async (response) => {
    fetchMock.mockResolvedValue(new Response(response))
    const message = entry()
    await processPostHogQueueBatch(batch([message]), env)
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledOnce()
    const capture = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(capture).toMatchObject({ api_key: 'runtime-key', uuid: body.event_id, distinct_id: body.payload.distinct_id, timestamp: body.payload.timestamp, properties: { $insert_id: body.event_id, $groups: body.payload.groups } })
    expect(sendDlq).not.toHaveBeenCalled()
  })

  it.each([
    [429, 'limited', 'retryable'],
    [500, 'failure', 'retryable'],
    [503, 'failure', 'retryable'],
    [200, 'malformed', 'ambiguous'],
    [200, 'false', 'ambiguous'],
    [200, '{}', 'ambiguous'],
    [200, '{"status":"unexpected","secret":"provider-secret"}', 'ambiguous'],
  ])('retries HTTP %s / %s rather than acknowledging', async (status, response, outcome) => {
    fetchMock.mockResolvedValue(new Response(response, { status }))
    const message = entry()
    await processPostHogQueueBatch(batch([message]), env)
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(sendDlq).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome, http_status: status, ...(outcome === 'ambiguous' ? { reason: 'invalid_response' } : {}) }))
    expect(JSON.stringify(log.mock.calls)).not.toContain('provider-secret')
  })

  it('retries ambiguous network failures and timeouts with the frozen insert ID', async () => {
    fetchMock.mockRejectedValue(new Error('private provider details'))
    const message = entry(body, 2)
    await processPostHogQueueBatch(batch([message]), env)
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 120 })
    expect(message.ack).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ambiguous', reason: 'network', http_status: null }))
    expect(JSON.stringify(log.mock.calls)).not.toContain('private provider details')
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timeout')))
    }))
    const timed = entry()
    const processing = processPostHogQueueBatch(batch([timed]), env)
    await vi.advanceTimersByTimeAsync(5000)
    await processing
    expect(timed.retry).toHaveBeenCalledOnce()
    expect(timed.ack).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'ambiguous', reason: 'timeout', http_status: null }))
  })

  it.each([
    [200, '{"quota_limited":["events"]}', 'quota_limited'],
    [200, '{"status":"Ok","quota_limited":["events"]}', 'quota_limited'],
    [200, '{"status":"Ok","quota_limited":true}', 'quota_limited'],
    [200, '{"status":0}', 'permanent_failure'],
    [400, 'invalid payload', 'permanent_failure'],
    [401, 'invalid key', 'permanent_failure'],
    [403, 'forbidden', 'permanent_failure'],
    [404, 'invalid endpoint', 'permanent_failure'],
  ])('persists terminal HTTP %s in the DLQ with metadata before ack', async (status, response, outcome) => {
    fetchMock.mockResolvedValue(new Response(response, { status }))
    let persisted!: () => void
    sendDlq.mockImplementation(() => new Promise<void>((resolve) => {
      persisted = resolve
    }))
    const message = entry()
    const processing = processPostHogQueueBatch(batch([message]), env)
    await vi.waitFor(() => expect(sendDlq).toHaveBeenCalledOnce())
    expect(message.ack).not.toHaveBeenCalled()
    expect(sendDlq.mock.calls[0][0]).toMatchObject({ original: body, failure: { outcome, http_status: status, attempts: 1 } })
    expect(sendDlq.mock.calls[0][1]).toEqual({ contentType: 'json' })
    persisted()
    await processing
    expect(message.ack).toHaveBeenCalledOnce()
    expect(message.retry).not.toHaveBeenCalled()
  })

  it.each([{}, { POSTHOG_API_KEY: 'key', POSTHOG_API_HOST: '://invalid' }])('dead-letters missing configuration or invalid hosts without fetching', async (config) => {
    const message = entry()
    await processPostHogQueueBatch(batch([message]), { ...config, POSTHOG_DLQ: { send: sendDlq } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendDlq).toHaveBeenCalledOnce()
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it.each([undefined, null, 'invalid', { ...body, version: 2 }, { ...body, jwt: 'secret' }, { ...body, payload: { ...body.payload, tags: { token: 'secret' } } }])('retains invalid bodies in the DLQ without PostHog delivery', async (invalid) => {
    const message = entry(invalid === undefined ? { invalid: true } : invalid)
    await processPostHogQueueBatch(batch([message]), env)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendDlq.mock.calls[0][0]).toMatchObject({ original: message.body, failure: { outcome: 'invalid_body' } })
    expect(message.ack).toHaveBeenCalledOnce()
  })

  it('preserves an invalid near-limit original in raw form when an envelope cannot fit', async () => {
    const invalid = { large: 'x'.repeat(125 * 1024) }
    const message = entry(invalid)
    await processPostHogQueueBatch(batch([message]), env)
    expect(sendDlq).toHaveBeenCalledWith(invalid, { contentType: 'json' })
    expect(message.ack).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['failure', 'missing'])('retries the original if DLQ persistence is %s', async (mode) => {
    fetchMock.mockResolvedValue(new Response('{"quota_limited":true}'))
    sendDlq.mockRejectedValue(new Error('DLQ failed'))
    const message = entry()
    await processPostHogQueueBatch(batch([message]), mode === 'missing' ? { POSTHOG_API_KEY: 'key' } : env)
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).toHaveBeenCalledOnce()
  })

  it('uses explicit per-message handling for a mixed batch and unexpected exceptions', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"status":1}'))
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"quota_limited":true}'))
    const messages = [entry(), entry(), entry(), entry({ invalid: true }), entry()]
    Object.defineProperty(messages[4], 'body', { get: () => {
      throw new Error('unexpected')
    } })
    const mixed = batch(messages)
    await processPostHogQueueBatch(mixed, env)
    expect(messages.map(message => message.ack.mock.calls.length)).toEqual([1, 0, 1, 1, 0])
    expect(messages.map(message => message.retry.mock.calls.length)).toEqual([0, 1, 0, 0, 1])
    expect(mixed.ackAll).not.toHaveBeenCalled()
    expect(mixed.retryAll).not.toHaveBeenCalled()
  })

  it.each([1, 2, 3, 4, 5, 6])('uses the bounded retry ladder on attempt %s', async (attempts) => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    const message = entry(body, attempts)
    await processPostHogQueueBatch(batch([message]), env)
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: POSTHOG_RETRY_DELAYS[Math.min(attempts - 1, 4)] })
  })

  it('runs ten bounded captures concurrently instead of accumulating their timeouts', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('timeout')))
    }))
    const messages = Array.from({ length: 10 }, () => entry())
    const processing = processPostHogQueueBatch(batch(messages), env)
    expect(fetchMock).toHaveBeenCalledTimes(10)
    await vi.advanceTimersByTimeAsync(5000)
    await processing
    expect(messages.every(message => message.retry.mock.calls.length === 1)).toBe(true)
  })

  it('logs only delivery metadata without payload/PII/provider responses', async () => {
    fetchMock.mockResolvedValue(new Response('{"quota_limited":true,"secret":"provider-secret"}'))
    await processPostHogQueueBatch(batch([entry()]), env)
    const logs = JSON.stringify(log.mock.calls)
    for (const secret of ['Private Example', 'example-actor', 'example-org', 'example@example.com', '192.0.2.1', 'private description', 'provider-secret', 'runtime-key'])
      expect(logs).not.toContain(secret)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event_id: body.event_id, outcome: 'dead_lettered', delivery_outcome: 'quota_limited', age_ms: expect.any(Number) }))
  })
})

describe('snapshot validation', () => {
  it('accepts both automatic retry-exhaustion V1 and explicit terminal envelopes for replay', () => {
    expect(replayablePostHogMessage(body)).toEqual(body)
    expect(replayablePostHogMessage({ version: 1, source: 'posthog_dlq', original: body, failure: { outcome: 'quota_limited' } })).toEqual(body)
    expect(replayablePostHogMessage({ version: 2, source: 'posthog_dlq', original: body })).toBeUndefined()
  })
  it('rejects malformed, nonfinite, deeply nested or oversized messages without persistence', async () => {
    const send = vi.fn()
    for (const invalid of [{ ...body, event_id: 'invalid' }, { ...body, payload: { ...body.payload, tags: { value: Number.NaN } } }, { ...body, payload: { ...body.payload, timestamp: 'invalid' } }]) {
      expect(parsePostHogMessage(invalid)).toBeUndefined()
      await expect(enqueuePostHog({ send }, invalid)).rejects.toMatchObject({ code: 'invalid_payload' })
    }
    await expect(enqueuePostHog({ send }, { ...body, payload: { ...body.payload, description: 'x'.repeat(POSTHOG_MESSAGE_MAX_BYTES) } })).rejects.toMatchObject({ code: 'oversized' })
    expect(send).not.toHaveBeenCalled()
  })
})
