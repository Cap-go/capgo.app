import type { QueueInfo } from '../scripts/lib/posthog-queues.ts'
import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureR2InventoryQueues, INVENTORY_RETENTION_SECONDS } from '../scripts/ensure-r2-inventory-queues.ts'
import { createQueueApi } from '../scripts/lib/posthog-queues.ts'

const names = (env = 'prod') => ['', '-dlq', '-repair', '-repair-dlq'].map(suffix => `capgo-r2-inventory-${env}${suffix}`)
function fixtures(): QueueInfo[] {
  return names().map((queue_name, index) => ({ queue_id: `queue-${index}`, queue_name, settings: { message_retention_period: INVENTORY_RETENTION_SECONDS } }))
}

function cloudflare(initial = fixtures(), options: { createError?: boolean, lostCreateResponse?: boolean, rejectCreate?: boolean, ignorePatch?: boolean, lookupStatus?: number, malformedListing?: boolean, disappear?: boolean } = {}) {
  const queues = new Map(initial.map(queue => [queue.queue_id, structuredClone(queue)]))
  const requests: Array<{ path: string, method: string, body: any }> = []
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.split('/queues')[1]
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ path, method, body })
    const success = (result: unknown) => Response.json({ success: true, result })
    const failure = (status: number, code = 10000) => Response.json({ success: false, errors: [{ code, message: 'private-token provider details' }] }, { status })
    if (!path && method === 'GET') {
      if (options.lookupStatus)
        return failure(options.lookupStatus)
      if (options.malformedListing)
        return success({ invalid: true })
      const name = new URL(url).searchParams.get('name')
      return success([...queues.values()].filter(queue => queue.queue_name === name))
    }
    if (!path && method === 'POST') {
      if (!options.rejectCreate) {
        const queue = { queue_id: `queue-${queues.size}`, ...body }
        queues.set(queue.queue_id, queue)
      }
      if (options.lostCreateResponse)
        throw new Error('Lost response after creation')
      if (options.createError)
        return failure(409, 11009)
      return success({ queue_id: 'ignored-create-response' })
    }
    const queue = queues.get(path.slice(1))
    if (!queue)
      throw new Error('Unexpected queue request')
    if (method === 'PATCH') {
      if (!options.ignorePatch)
        queue.settings = body.settings
      if (options.disappear)
        queues.delete(queue.queue_id)
    }
    return success(structuredClone(queue))
  })
  vi.stubGlobal('fetch', fetchMock)
  return { queues, requests, fetchMock }
}

beforeEach(() => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'private-token')
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('r2 inventory deployment queue provisioning', () => {
  it.each(['alpha', 'prod', 'preprod'] as const)('creates only missing %s queues and verifies four-day retention from the API', async (env) => {
    const { queues, requests } = cloudflare([])
    await ensureR2InventoryQueues(createQueueApi(), env)
    expect([...queues.values()].map(queue => queue.queue_name)).toEqual(names(env))
    expect([...queues.values()].every(queue => queue.settings?.message_retention_period === 345600)).toBe(true)
    expect(requests.filter(request => request.method === 'POST').map(request => request.body.queue_name)).toEqual(names(env))
    expect(requests.filter(request => request.path && request.method === 'GET')).toHaveLength(8)
    expect(console.log).toHaveBeenCalledTimes(4)
    requests.length = 0
    await ensureR2InventoryQueues(createQueueApi(), env)
    expect(requests.every(request => request.method === 'GET')).toBe(true)
  })

  it('reuses existing queues without attempting creation or changing consumers or queued messages', async () => {
    const initial = fixtures().map(queue => ({ ...queue, consumers: [{ type: 'worker', settings: { max_retries: 5 } }] }))
    const { queues, requests } = cloudflare(initial)
    await ensureR2InventoryQueues(createQueueApi(), 'prod')
    expect([...queues.values()]).toEqual(initial)
    expect(requests.every(request => request.method === 'GET' && !request.path.includes('/messages'))).toBe(true)
  })

  it('repairs retention drift while preserving pause, delay and consumer settings', async () => {
    const initial = fixtures()
    const settings = { message_retention_period: 86400, delivery_paused: true, delivery_delay: 30 }
    initial[0] = { ...initial[0], settings, consumers: [{ type: 'worker', settings: { max_retries: 5 } }] }
    const { queues, requests } = cloudflare(initial)
    await ensureR2InventoryQueues(createQueueApi(), 'prod')
    expect(requests.filter(request => request.method === 'PATCH')).toEqual([{ path: '/queue-0', method: 'PATCH', body: { settings: { message_retention_period: 345600, delivery_paused: true, delivery_delay: 30 } } }])
    expect(queues.get('queue-0')).toEqual({ ...initial[0], settings: { ...initial[0].settings, message_retention_period: 345600 } })
    expect(requests.some(request => request.method === 'POST')).toBe(false)
  })

  it('creates missing queues in a partially provisioned environment', async () => {
    const { requests } = cloudflare(fixtures().slice(0, 2))
    await ensureR2InventoryQueues(createQueueApi(), 'prod')
    expect(requests.filter(request => request.method === 'POST').map(request => request.body.queue_name)).toEqual(names().slice(2))
  })

  it.each([{ createError: true }, { lostCreateResponse: true }])('recovers an uncertain create only after discovering and verifying the exact queue: %j', async (options) => {
    const { requests } = cloudflare([], options)
    await ensureR2InventoryQueues(createQueueApi(), 'prod')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(4)
    expect(console.log).toHaveBeenCalledTimes(4)
  })

  it('does not treat a failed create as success when the queue remains absent', async () => {
    const { requests } = cloudflare([], { createError: true, rejectCreate: true })
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Queue API request failed')
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(console.log).not.toHaveBeenCalled()
  })

  it('does not trust a successful create response when the queue remains absent', async () => {
    cloudflare([], { rejectCreate: true })
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Queue does not exist')
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([401, 403, 429, 500])('fails closed on a %s lookup instead of trying creation', async (lookupStatus) => {
    const { requests } = cloudflare([], { lookupStatus })
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Queue API request failed')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('GET')
    expect(console.log).not.toHaveBeenCalled()
  })

  it('rejects malformed listings and network errors without logging provider content', async () => {
    const { fetchMock } = cloudflare([], { malformedListing: true })
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Invalid queue listing')
    fetchMock.mockRejectedValue(new Error('private-token response content'))
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Cloudflare Queue API request failed; no payload was logged')
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([{ ignorePatch: true }, { disappear: true }])('refuses deployment if final server state does not confirm retention: %j', async (options) => {
    const initial = fixtures()
    initial[0].settings!.message_retention_period = 86400
    cloudflare(initial, options)
    await expect(ensureR2InventoryQueues(createQueueApi(), 'prod')).rejects.toThrow('Queue missing or retention is not four days')
    expect(console.log).not.toHaveBeenCalled()
  })

  it.each([{ args: [] }, { args: ['unsupported'] }, { args: ['prod', 'extra'] }])('rejects invalid CLI arguments before API access: %j', ({ args }) => {
    const result = spawnSync('bun', ['scripts/ensure-r2-inventory-queues.ts', ...args], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
      encoding: 'utf8',
      timeout: 10000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/Usage:|Expected alpha/)
  })

  it('rejects missing credentials before attempting API access', () => {
    const { fetchMock } = cloudflare()
    vi.stubEnv('CLOUDFLARE_API_TOKEN', '')
    expect(() => createQueueApi()).toThrow('Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
