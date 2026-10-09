import type { QueueApi, QueueInfo } from '../scripts/lib/posthog-queues.ts'
import { Buffer } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensurePostHogQueues } from '../scripts/ensure-posthog-queues.ts'
import { createQueueApi, POSTHOG_RETENTION_SECONDS } from '../scripts/lib/posthog-queues.ts'
import { replayPostHogDlq } from '../scripts/replay-posthog-dlq.ts'

const message = {
  version: 1,
  source: 'private_events',
  event_id: '031c6527-7d90-842d-9abd-17f442067e20',
  accepted_at: '2026-10-06T10:00:00.000Z',
  request_id: 'request-id',
  payload: { event: 'Example 雪', channel: 'test', distinct_id: 'example-actor', timestamp: '2026-10-06T09:59:00.000Z' },
}
const envelope = { version: 1, source: 'posthog_dlq', original: message, failure: { outcome: 'quota_limited', failed_at: '2026-10-06T10:01:00Z', attempts: 1 } }
function leased(body: unknown, lease = 'lease', attempts = 0) {
  return { body: Buffer.from(JSON.stringify(body)).toString('base64'), metadata: { 'CF-Content-Type': 'json' }, lease_id: lease, attempts }
}

function mockApi(initial: QueueInfo[] = [], messages: unknown[] = []) {
  const queues = new Map(initial.map(queue => [queue.queue_id, structuredClone(queue)]))
  const pending = [...messages]
  const request = vi.fn(async (path: string, method = 'GET', body?: any): Promise<any> => {
    if (path.startsWith('?name='))
      return [...queues.values()].filter(queue => queue.queue_name === decodeURIComponent(path.slice(6)))
    if (path === '' && method === 'POST') {
      const queue = { queue_id: `queue-${queues.size}`, ...body }
      queues.set(queue.queue_id, queue)
      return queue
    }
    const [, id, action, subaction] = path.split('/')
    const queue = queues.get(id)
    if (!queue)
      throw new Error('Missing fixture queue')
    if (!action && method === 'GET')
      return structuredClone(queue)
    if (!action && method === 'PATCH') {
      queue.settings = { ...queue.settings, ...body.settings }
      return queue
    }
    if (action === 'consumers' && method === 'POST') {
      queue.consumers = [body]
      return body
    }
    if (action === 'metrics')
      return { backlog_count: pending.length }
    if (subaction === 'peek')
      return { messages: pending.slice(0, body.batch_size) }
    if (subaction === 'pull')
      return { messages: pending.splice(0, body.batch_size) }
    if (subaction === 'ack')
      return { ackCount: 1, warnings: {} }
    return {}
  })
  return { api: request as QueueApi, request, queues }
}
function existingQueues() {
  return [
    { queue_id: 'main', queue_name: 'capgo-posthog-events-alpha', settings: { message_retention_period: POSTHOG_RETENTION_SECONDS } },
    { queue_id: 'dlq', queue_name: 'capgo-posthog-events-alpha-dlq', settings: { message_retention_period: POSTHOG_RETENTION_SECONDS }, consumers: [{ type: 'http_pull', settings: { max_retries: 5 } }] },
  ]
}

beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('resource provisioning', () => {
  it.each(['alpha', 'preprod', 'prod'] as const)('creates the DLQ before main, sets fourteen days and verifies idempotently for %s', async (environment) => {
    const { api, request, queues } = mockApi()
    await ensurePostHogQueues(api, environment)
    const creation = request.mock.calls.filter(([path, method]) => !path && method === 'POST')
    expect(creation.map(([, , body]) => body.queue_name)).toEqual([`capgo-posthog-events-${environment}-dlq`, `capgo-posthog-events-${environment}`])
    expect([...queues.values()].every(queue => queue.settings?.message_retention_period === 1209600)).toBe(true)
    request.mockClear()
    await ensurePostHogQueues(api, environment)
    expect(request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true)
    await ensurePostHogQueues(api, environment, true)
  })

  it('repairs retention drift and verifies fresh server state', async () => {
    const fixtures = existingQueues()
    fixtures[0].settings.message_retention_period = 86400
    const { api, request } = mockApi(fixtures)
    await expect(ensurePostHogQueues(api, 'alpha', true)).rejects.toThrow('retention')
    expect(request.mock.calls.every(([, method]) => method !== 'POST' && method !== 'PATCH')).toBe(true)
    await ensurePostHogQueues(api, 'alpha')
    expect(request).toHaveBeenCalledWith('/main', 'PATCH', { settings: { message_retention_period: 1209600 } })
  })

  it('refuses a deployment when resources remain missing or retention verification fails', async () => {
    const { api } = mockApi()
    await expect(ensurePostHogQueues(api, 'alpha', true)).rejects.toThrow('does not exist')
    const request = vi.fn(async (path: string) => path.startsWith('?') ? existingQueues() : { ...existingQueues()[1], settings: { message_retention_period: 86400 } }) as QueueApi
    await expect(ensurePostHogQueues(request, 'alpha')).rejects.toThrow('retention')
  })

  it('refuses an automatic DLQ consumer or excess retries', async () => {
    for (const consumer of [{ type: 'worker', settings: { max_retries: 5 } }, { type: 'http_pull', settings: { max_retries: 6 } }]) {
      const fixtures = existingQueues()
      fixtures[1].consumers = [consumer]
      await expect(ensurePostHogQueues(mockApi(fixtures).api, 'alpha')).rejects.toThrow(/unexpected|exactly five/)
    }
  })

  it('does not expose API responses or credentials on API failure', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'private-token')
    vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"success":false,"errors":["private-token private-payload"]}', { status: 400 })))
    await expect(createQueueApi()('/main/messages', 'POST', { body: 'private-payload' })).rejects.toThrow('Cloudflare Queue API request failed; no payload was logged')
  })
})

describe('bounded DLQ replay', () => {
  it('defaults to a dry run without leasing, sending or acknowledging any messages', async () => {
    const { api, request } = mockApi(existingQueues(), [leased(message)])
    await replayPostHogDlq(api, 'alpha')
    expect(request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true)
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ mode: 'dry_run', backlog_count: 1, limit: 10 }))
  })

  it.each([message, envelope])('preserves V1 identity and frozen timestamps, acknowledges only after republish', async (body) => {
    const { api, request } = mockApi(existingQueues(), [leased(body)])
    const operations: string[] = []
    let publish!: () => void
    const gated = vi.fn(async (path: string, method?: string, payload?: unknown) => {
      operations.push(path)
      if (path === '/main/messages')
        await new Promise<void>((resolve) => { publish = resolve })
      return api(path, method, payload)
    }) as QueueApi
    const result = replayPostHogDlq(gated, 'alpha', true, 1)
    await vi.waitFor(() => expect(operations).toContain('/main/messages'))
    expect(operations).not.toContain('/dlq/messages/ack')
    publish()
    expect(await result).toEqual({ published: 1, refused: 0 })
    expect(request).toHaveBeenCalledWith('/main/messages', 'POST', { body: message, content_type: 'json' })
    expect(request).toHaveBeenCalledWith('/dlq/messages/ack', 'POST', { acks: [{ lease_id: 'lease' }], retries: [] })
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('example-actor')
  })

  it('never acknowledges a lease when republishing fails', async () => {
    const { api, request } = mockApi(existingQueues(), [leased(message)])
    const failing = (async (path: string, method?: string, body?: unknown) => {
      if (path === '/main/messages')
        throw new Error('unavailable')
      return api(path, method, body)
    }) as QueueApi
    await expect(replayPostHogDlq(failing, 'alpha', true, 1)).rejects.toThrow('unavailable')
    expect(request.mock.calls.some(([path]) => path.endsWith('/ack'))).toBe(false)
  })

  it.each([leased({ version: 9 }), leased(message, 'lease', 4), { ...leased(message), metadata: { 'CF-Content-Type': 'v8' } }])('refuses invalid or near-exhaustion messages before leasing without deleting them', async (invalid) => {
    const { api, request } = mockApi(existingQueues(), [invalid])
    expect(await replayPostHogDlq(api, 'alpha', true, 1)).toEqual({ published: 0, refused: 1 })
    expect(request.mock.calls.some(([path]) => path.endsWith('/pull') || path.endsWith('/ack') || path.endsWith('/purge') || path === '/main/messages')).toBe(false)
  })

  it('refuses a changed invalid pull body even after a valid preview and leaves the lease untouched', async () => {
    const { api, request } = mockApi(existingQueues(), [leased(message)])
    const changed = (async (path: string, method?: string, body?: unknown) => path.endsWith('/pull') ? { messages: [leased({ invalid: true })] } : api(path, method, body)) as QueueApi
    expect(await replayPostHogDlq(changed, 'alpha', true, 1)).toEqual({ published: 0, refused: 1 })
    expect(request.mock.calls.some(([path]) => path.endsWith('/ack') || path === '/main/messages')).toBe(false)
  })

  it('limits execution to the requested message count and checks ack confirmation', async () => {
    const { api, request } = mockApi(existingQueues(), [leased(message), leased(message)])
    expect(await replayPostHogDlq(api, 'alpha', true, 1)).toEqual({ published: 1, refused: 0 })
    expect(request.mock.calls.filter(([path]) => path === '/main/messages')).toHaveLength(1)
    const badAck = (async (path: string, method?: string, body?: unknown) => path.endsWith('/ack') ? { ackCount: 0 } : api(path, method, body)) as QueueApi
    await expect(replayPostHogDlq(badAck, 'alpha', true, 1)).rejects.toThrow('not confirmed')
  })

  it.each([0, 101, 1.5])('rejects an unsafe replay limit %s without API calls', async (limit) => {
    const { api, request } = mockApi(existingQueues())
    await expect(replayPostHogDlq(api, 'alpha', true, limit)).rejects.toThrow('Replay limit')
    expect(request).not.toHaveBeenCalled()
  })
})
