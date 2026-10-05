import type { ClientBase } from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeInventoryBatch } from '../cloudflare_workers/r2_inventory/index.ts'
import { inventoryTransaction, parseInventoryConfig, parseInventoryEvent, timestampUs } from '../supabase/functions/_backend/utils/r2_inventory.ts'

const mocks = vi.hoisted(() => ({ apply: vi.fn(), end: vi.fn(), head: vi.fn(), publish: vi.fn(), config: { enabled: true, tombstoneDays: 7, minBatchMs: 500 } }))
vi.mock('pg', () => ({ Client: class { connect = vi.fn(); end = mocks.end } }))
vi.mock('../supabase/functions/_backend/utils/r2_inventory.ts', async importOriginal => ({
  ...await importOriginal<object>(),
  loadInventoryConfig: async () => mocks.config,
  applyInventoryEvents: mocks.apply,
}))
const body = { bucket: 'inventory-test', action: 'PutObject', eventTime: '2026-10-01T00:00:00.123456Z', object: { key: 'legacy/file', size: 42, eTag: '"etag"' } }
function fixture(bodies: unknown[]) {
  const messages = bodies.map(body => ({ body, ack: vi.fn(), retry: vi.fn() }))
  const batch = { queue: 'capgo-r2-inventory-test', messages, retryAll: vi.fn() }
  const env = { INVENTORY_BUCKET: 'inventory-test', HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'local' }, ATTACHMENT_BUCKET: { head: mocks.head }, REPAIR_QUEUE: { sendBatch: mocks.publish } }
  return { messages, batch: batch as unknown as MessageBatch<unknown>, env: env as unknown as Parameters<typeof consumeInventoryBatch>[1], retryAll: batch.retryAll }
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.apply.mockResolvedValue([])
  mocks.publish.mockResolvedValue(undefined)
  mocks.config.enabled = true
})

describe('r2 inventory queue', () => {
  it('preserves the original batch failure when rollback also fails', async () => {
    const original = new Error('Batch constraint violation')
    const db = { query: vi.fn(async (statement: string) => {
      if (statement === 'ROLLBACK')
        throw new Error('Connection lost during rollback')
      return { rows: [] }
    }) }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(inventoryTransaction(db as unknown as ClientBase, async () => {
        throw original
      })).rejects.toBe(original)
      expect(db.query).toHaveBeenCalledWith('ROLLBACK')
    }
    finally {
      log.mockRestore()
    }
  })

  it('keeps the invocation pending for its pacing interval after releasing the client', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture([body])
      let finished = false
      const consume = consumeInventoryBatch(f.batch, f.env).then(() => {
        finished = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(mocks.end).toHaveBeenCalledTimes(1)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(499)
      expect(finished).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await consume
      expect(finished).toBe(true)
    }
    finally {
      vi.useRealTimers()
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
  it('requires retention beyond queue retention and enforces pacing', () => {
    expect(() => parseInventoryConfig({ enabled: true, tombstoneDays: 4, minBatchMs: 500 })).toThrow()
    expect(() => parseInventoryConfig({ enabled: true, tombstoneDays: 7, minBatchMs: 0 })).toThrow()
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
    expect(f.retryAll).toHaveBeenCalled()
  })
  it('acknowledges only after awaited repair publication', async () => {
    const f = fixture([body])
    mocks.apply.mockResolvedValue([{ bucket: 'inventory-test', key: 'legacy/file', kind: 'verify' }])
    await consumeInventoryBatch(f.batch, f.env)
    expect(mocks.publish.mock.invocationCallOrder[0]).toBeLessThan(f.messages[0].ack.mock.invocationCallOrder[0])
  })
  it('isolates malformed messages and fails closed when ingestion is disabled', async () => {
    const f = fixture([body, { broken: true }])
    await consumeInventoryBatch(f.batch, f.env)
    expect(f.messages[0].ack).toHaveBeenCalled()
    expect(f.messages[1].ack).not.toHaveBeenCalled()
    expect(f.messages[1].retry).toHaveBeenCalled()
    mocks.config.enabled = false
    const disabled = fixture([body])
    await consumeInventoryBatch(disabled.batch, disabled.env)
    expect(disabled.messages[0].ack).not.toHaveBeenCalled()
    expect(disabled.retryAll).toHaveBeenCalled()
  })
})
