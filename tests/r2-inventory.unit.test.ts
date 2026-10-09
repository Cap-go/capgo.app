import type { ClientBase, QueryConfig } from 'pg'
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInventoryBatch } from '../cloudflare_workers/r2_inventory/index.ts'
import { INVENTORY_CONFIG, inventoryTransaction, parseInventoryEvent, timestampUs } from '../supabase/functions/_backend/utils/r2_inventory.ts'

const mocks = vi.hoisted(() => ({ clients: vi.fn(), apply: vi.fn(), end: vi.fn(), head: vi.fn(), publish: vi.fn(), eventDlq: vi.fn(), repairDlq: vi.fn(), snapshot: vi.fn(), observe: vi.fn() }))
vi.mock('pg', async importOriginal => ({
  ...await importOriginal<object>(),
  Client: class {
    constructor(options: unknown) { mocks.clients(options) }
    connect = vi.fn()
    end = mocks.end
  },
}))
vi.mock('../supabase/functions/_backend/utils/r2_inventory.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  applyInventoryEvents: mocks.apply,
  readObservationSnapshot: mocks.snapshot,
  applyObservations: mocks.observe,
}))
const body = { bucket: 'inventory-test', action: 'PutObject', eventTime: '2026-10-01T00:00:00.123456Z', object: { key: 'legacy/file', size: 42, eTag: '"etag"' } }
function fixture(bodies: unknown[], repair = false) {
  const messages = bodies.map((body, index) => ({ id: `synthetic-message-${index}`, timestamp: new Date('2026-10-06T10:00:00Z'), attempts: 1, body, ack: vi.fn(), retry: vi.fn() }))
  const batch = { queue: `capgo-r2-inventory-test${repair ? '-repair' : ''}`, messages, retryAll: vi.fn() }
  const env = { INVENTORY_BUCKET: 'inventory-test', HYPERDRIVE_R2_INVENTORY: { connectionString: 'local' }, ATTACHMENT_BUCKET: { head: mocks.head }, REPAIR_QUEUE: { sendBatch: mocks.publish }, EVENT_DLQ: { sendBatch: mocks.eventDlq }, REPAIR_DLQ: { sendBatch: mocks.repairDlq } }
  return { messages, batch: batch as unknown as MessageBatch<unknown>, env: env as unknown as Parameters<typeof consumeInventoryBatch>[1], retryAll: batch.retryAll }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.apply.mockResolvedValue([])
  mocks.publish.mockResolvedValue(undefined)
  mocks.eventDlq.mockResolvedValue(undefined)
  mocks.repairDlq.mockResolvedValue(undefined)
  mocks.snapshot.mockResolvedValue({ rows: [], startedAt: '2026-10-06T10:00:00Z' })
  mocks.observe.mockResolvedValue([])
  mocks.head.mockResolvedValue(null)
})

describe('r2 inventory queue', () => {
  it('preserves the original batch failure when rollback also fails', async () => {
    const original = new Error('Batch constraint violation')
    const db = { query: vi.fn(async (statement: string | QueryConfig) => {
      if ((typeof statement === 'string' ? statement : statement.text).toLowerCase() === 'rollback')
        throw new Error('Connection lost during rollback')
      return { rows: [] }
    }) }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(inventoryTransaction(db as unknown as ClientBase, async () => {
        throw original
      })).rejects.toBe(original)
      expect(db.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'rollback' }), [])
    }
    finally {
      log.mockRestore()
    }
  })

  it('finishes a committed batch without a pacing timer or configuration query', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture([body])
      await consumeInventoryBatch(f.batch, f.env)
      expect(mocks.end).toHaveBeenCalledTimes(1)
      expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
      expect(mocks.apply.mock.calls[0][2]).toBe(INVENTORY_CONFIG)
      expect(vi.getTimerCount()).toBe(0)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it.each([false, true])('uses only the dedicated inventory database binding (repair=%s)', async (repair) => {
    const f = fixture([repair ? { bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' } : body], repair)
    const env = { ...f.env, HYPERDRIVE_R2_INVENTORY: { connectionString: 'postgres://dedicated-inventory' }, HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://primary-must-not-be-used' } }
    await consumeInventoryBatch(f.batch, env as unknown as typeof f.env)
    expect(mocks.clients).toHaveBeenCalledTimes(repair ? 2 : 1)
    for (const [options] of mocks.clients.mock.calls)
      expect(options).toMatchObject({ connectionString: 'postgres://dedicated-inventory' })
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('retries without connecting to the primary when the inventory binding is absent (repair=%s)', async (repair) => {
    const f = fixture([repair ? { bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' } : body], repair)
    const { HYPERDRIVE_R2_INVENTORY: _, ...rest } = f.env
    const env = { ...rest, HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgres://primary-must-not-be-used' } }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await consumeInventoryBatch(f.batch, env as unknown as typeof f.env)
      expect(mocks.clients).not.toHaveBeenCalled()
      expect(mocks.apply).not.toHaveBeenCalled()
      expect(mocks.snapshot).not.toHaveBeenCalled()
      expect(f.messages[0].ack).not.toHaveBeenCalled()
      expect(f.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
    }
    finally {
      log.mockRestore()
    }
  })

  it('routes production inventory to its PlanetScale Hyperdrive and preserves the other environment origins', () => {
    const wrangler = JSON.parse(readFileSync(new URL('../cloudflare_workers/r2_inventory/wrangler.jsonc', import.meta.url), 'utf8'))
    expect(wrangler.env.prod.hyperdrive).toEqual([{ binding: 'HYPERDRIVE_R2_INVENTORY', id: 'af73fa6a112b495f80e81718b153db76' }])
    for (const name of ['alpha', 'preprod'])
      expect(wrangler.env[name].hyperdrive).toEqual([{ binding: 'HYPERDRIVE_R2_INVENTORY', id: 'ae1fe6178b564adc9fc9a71ccc769a35' }])
  })

  it('caps the combined event and repair consumer concurrency at two in every environment', () => {
    const wrangler = JSON.parse(readFileSync(new URL('../cloudflare_workers/r2_inventory/wrangler.jsonc', import.meta.url), 'utf8'))
    for (const environment of Object.values(wrangler.env) as { queues: { consumers: { max_concurrency: number, dead_letter_queue: string }[], producers: { binding: string, queue: string }[] } }[]) {
      expect(environment.queues.consumers).toHaveLength(2)
      expect(environment.queues.consumers.map(consumer => consumer.max_concurrency)).toEqual([1, 1])
      const bindings = Object.fromEntries(environment.queues.producers.map(producer => [producer.binding, producer.queue]))
      expect(bindings.EVENT_DLQ).toBe(environment.queues.consumers[0].dead_letter_queue)
      expect(bindings.REPAIR_DLQ).toBe(environment.queues.consumers[1].dead_letter_queue)
    }
  })

  it('normalizes creation metadata and preserves microsecond ordering', () => {
    expect(parseInventoryEvent(body, 'inventory-test')).toMatchObject({ state: 'present', size: 42, etag: 'etag' })
    expect(timestampUs(body.eventTime) - timestampUs('2026-10-01T00:00:00.123455Z')).toBe(1n)
    expect(() => parseInventoryEvent(body, 'another-bucket')).toThrow()
    expect(() => parseInventoryEvent({ ...body, object: { key: 'x', size: -1, eTag: 'a' } }, 'inventory-test')).toThrow()
    expect(() => timestampUs('yesterday')).toThrow()
    expect(() => timestampUs('2026-09-31T12:00:00Z')).toThrow()
    expect(() => timestampUs('0000-01-01T00:00:00Z')).toThrow()
    expect(() => parseInventoryEvent({ ...body, object: { ...body.object, key: 'invalid\0key' } }, 'inventory-test')).toThrow()
  })
  it('batches legacy creates without making HEAD calls and releases before acknowledgement', async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => ({ ...body, object: { ...body.object, key: `file-${i}` } })))
    await consumeInventoryBatch(f.batch, f.env)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(mocks.apply.mock.calls[0][1]).toHaveLength(100)
    expect(mocks.head).not.toHaveBeenCalled()
    expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(f.messages[0].ack.mock.invocationCallOrder[0])
    expect(f.messages.every(message => message.ack.mock.calls.length === 1)).toBe(true)
  })
  it('does not acknowledge ambiguous source events when repair publication fails', async () => {
    const f = fixture([body])
    mocks.apply.mockResolvedValue([{ bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' }])
    mocks.publish.mockRejectedValue(new Error('Queue unavailable'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(f.messages[0].ack).not.toHaveBeenCalled()
    expect(f.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(f.retryAll).not.toHaveBeenCalled()
  })
  it('acknowledges only after awaited repair publication', async () => {
    const f = fixture([body])
    mocks.apply.mockResolvedValue([{ bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' }])
    let finishPublication: () => void = () => {}
    const publication = new Promise<void>((resolve) => {
      finishPublication = resolve
    })
    mocks.publish.mockReturnValue(publication)
    const consuming = consumeInventoryBatch(f.batch, f.env)
    try {
      await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
      expect(f.messages[0].ack).not.toHaveBeenCalled()
    }
    finally {
      finishPublication()
      await consuming
    }
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
  })
  it('acknowledges committed notifications while retrying only failed repair publication', async () => {
    const healthy = { ...body, object: { ...body.object, key: 'healthy' } }
    const f = fixture([healthy, body, body])
    mocks.apply.mockResolvedValue([{ bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' }])
    mocks.publish.mockRejectedValue(new Error('Repair queue unavailable'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
    expect(f.messages[0].retry).not.toHaveBeenCalled()
    for (const message of f.messages.slice(1)) {
      expect(message.ack).not.toHaveBeenCalled()
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    }
    expect(mocks.publish.mock.calls[0][0]).toHaveLength(1)
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it('keeps normal notification acknowledgements independent of pending repair publication', async () => {
    const healthy = { ...body, object: { ...body.object, key: 'healthy' } }
    const f = fixture([healthy, body])
    mocks.apply.mockResolvedValue([{ bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' }])
    let finishPublication: () => void = () => {}
    mocks.publish.mockReturnValue(new Promise<void>((resolve) => {
      finishPublication = resolve
    }))
    const consuming = consumeInventoryBatch(f.batch, f.env)
    try {
      await vi.waitFor(() => expect(mocks.publish).toHaveBeenCalledTimes(1))
      expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
      expect(f.messages[1].ack).not.toHaveBeenCalled()
      expect(mocks.end.mock.invocationCallOrder[0]).toBeLessThan(f.messages[0].ack.mock.invocationCallOrder[0])
    }
    finally {
      finishPublication()
      await consuming
    }
    expect(f.messages.every(message => message.ack.mock.calls.length === 1)).toBe(true)
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it('acknowledges committed repair keys and retries only conflicting keys, including duplicate messages', async () => {
    const task = (key: string) => ({ bucket: 'inventory-test', key, kind: 'verify' })
    const f = fixture([task('healthy'), task('conflict'), task('conflict')], true)
    let finishObservations: (keys: string[]) => void = () => {}
    mocks.observe.mockReturnValue(new Promise<string[]>((resolve) => {
      finishObservations = resolve
    }))
    const consuming = consumeInventoryBatch(f.batch, f.env)
    try {
      await vi.waitFor(() => expect(mocks.observe).toHaveBeenCalledTimes(1))
      expect(f.messages.every(message => message.ack.mock.calls.length === 0 && message.retry.mock.calls.length === 0)).toBe(true)
    }
    finally {
      finishObservations(['conflict'])
      await consuming
    }
    expect(mocks.head).toHaveBeenCalledTimes(2)
    expect(mocks.observe.mock.calls[0][3].map((item: { key: string }) => item.key)).toEqual(['healthy', 'conflict'])
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
    expect(f.messages[0].retry).not.toHaveBeenCalled()
    expect(mocks.end.mock.invocationCallOrder[1]).toBeLessThan(f.messages[0].ack.mock.invocationCallOrder[0])
    for (const message of f.messages.slice(1)) {
      expect(message.ack).not.toHaveBeenCalled()
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    }
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it('isolates a failed HEAD, waits for its peer, and applies successful observations in later pairs', async () => {
    const tasks = ['failed', 'slow', 'later-a', 'later-b'].map(key => ({ bucket: 'inventory-test', key, kind: 'verify' }))
    const f = fixture(tasks, true)
    let finishSlow: () => void = () => {}
    mocks.head.mockImplementation(async (key: string) => {
      if (key === 'failed')
        throw new Error('Synthetic R2 HEAD failure')
      if (key === 'slow')
        await new Promise<void>((resolve) => { finishSlow = resolve })
      return null
    })
    const consuming = consumeInventoryBatch(f.batch, f.env)
    try {
      await vi.waitFor(() => expect(mocks.head).toHaveBeenCalledTimes(2))
      expect(mocks.observe).not.toHaveBeenCalled()
      expect(f.messages.every(message => message.ack.mock.calls.length === 0 && message.retry.mock.calls.length === 0)).toBe(true)
    }
    finally {
      finishSlow()
      await consuming
    }
    expect(mocks.head).toHaveBeenCalledTimes(4)
    expect(mocks.observe.mock.calls[0][3]).toEqual(tasks.slice(1).map(({ key }) => ({ key, object: null })))
    expect(f.messages[0].ack).not.toHaveBeenCalled()
    expect(f.messages[0].retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(f.messages.slice(1).every(message => message.ack.mock.calls.length === 1 && message.retry.mock.calls.length === 0)).toBe(true)
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it('retries all failed HEAD messages individually without opening a write connection', async () => {
    const f = fixture(['a', 'b'].map(key => ({ bucket: 'inventory-test', key, kind: 'verify' })), true)
    mocks.head.mockRejectedValue(new Error('Synthetic R2 outage'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(mocks.observe).not.toHaveBeenCalled()
    expect(mocks.end).toHaveBeenCalledTimes(1)
    for (const message of f.messages) {
      expect(message.ack).not.toHaveBeenCalled()
      expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    }
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it.each(['snapshot', 'observe'] as const)('retries unconfirmed repair results when the database %s fails', async (stage) => {
    const f = fixture(['a', 'b'].map(key => ({ bucket: 'inventory-test', key, kind: 'verify' })), true)
    mocks[stage].mockRejectedValue(new Error('Synthetic database failure'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(f.messages.every(message => message.ack.mock.calls.length === 0)).toBe(true)
    expect(f.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(mocks.head).toHaveBeenCalledTimes(stage === 'snapshot' ? 0 : 2)
  })

  it.each([false, true])('batches malformed messages into the matching DLQ without retrying (repair=%s)', async (repair) => {
    const validBody = repair ? { bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' } : body
    const invalidBodies = [{ broken: true }, null]
    const f = fixture([validBody, ...invalidBodies], repair)
    const dlq = repair ? mocks.repairDlq : mocks.eventDlq
    const otherDlq = repair ? mocks.eventDlq : mocks.repairDlq
    await consumeInventoryBatch(f.batch, f.env)
    expect(dlq).toHaveBeenCalledTimes(1)
    expect(otherDlq).not.toHaveBeenCalled()
    expect(dlq.mock.calls[0][0]).toEqual(invalidBodies.map((body, index) => ({
      contentType: 'json',
      body: {
        kind: 'invalid_inventory_message',
        originalQueue: f.batch.queue,
        originalMessageId: f.messages[index + 1].id,
        originalTimestamp: '2026-10-06T10:00:00.000Z',
        attempts: 1,
        reason: expect.any(String),
        body,
      },
    })))
    expect(f.messages.every(message => message.ack.mock.calls.length === 1)).toBe(true)
    expect(f.messages.every(message => message.retry.mock.calls.length === 0)).toBe(true)
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it.each([false, true])('retries failed DLQ publication without blocking valid peers (repair=%s)', async (repair) => {
    const validBody = repair ? { bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' } : body
    const f = fixture([validBody, { broken: true }], repair)
    const dlq = repair ? mocks.repairDlq : mocks.eventDlq
    dlq.mockRejectedValue(new Error('DLQ unavailable'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
    expect(f.messages[0].retry).not.toHaveBeenCalled()
    expect(f.messages[1].ack).not.toHaveBeenCalled()
    expect(f.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(f.retryAll).not.toHaveBeenCalled()
  })

  it('awaits DLQ publication before acknowledging an invalid source message', async () => {
    const f = fixture([{ broken: true }])
    let finishPublication: () => void = () => {}
    mocks.eventDlq.mockReturnValue(new Promise<void>((resolve) => {
      finishPublication = resolve
    }))
    const consuming = consumeInventoryBatch(f.batch, f.env)
    try {
      await vi.waitFor(() => expect(mocks.eventDlq).toHaveBeenCalledTimes(1))
      expect(f.messages[0].ack).not.toHaveBeenCalled()
    }
    finally {
      finishPublication()
      await consuming
    }
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(mocks.end).not.toHaveBeenCalled()
  })

  it('preserves non-JSON invalid bodies with structured-clone serialization', async () => {
    const invalidBody = { unexpected: 42n }
    const f = fixture([invalidBody])
    await consumeInventoryBatch(f.batch, f.env)
    expect(mocks.eventDlq.mock.calls[0][0][0]).toMatchObject({ contentType: 'v8', body: { body: invalidBody } })
    expect(f.messages[0].ack).toHaveBeenCalledTimes(1)
    expect(f.messages[0].retry).not.toHaveBeenCalled()
  })

  it('keeps rejected messages acknowledged when valid processing subsequently fails', async () => {
    const f = fixture([body, { broken: true }])
    mocks.apply.mockRejectedValue(new Error('Database unavailable'))
    await consumeInventoryBatch(f.batch, f.env)
    expect(mocks.eventDlq).toHaveBeenCalledTimes(1)
    expect(f.messages[1].ack).toHaveBeenCalledTimes(1)
    expect(f.messages[1].retry).not.toHaveBeenCalled()
    expect(f.messages[0].ack).not.toHaveBeenCalled()
    expect(f.retryAll).toHaveBeenCalledWith({ delaySeconds: 30 })
  })
})
