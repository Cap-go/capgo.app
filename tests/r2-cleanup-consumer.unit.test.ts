import type { CleanupMessage } from '../cloudflare_workers/r2_inventory/cleanup.ts'
import type { CleanupConsumerEnv, CleanupDependencies } from '../cloudflare_workers/r2_inventory/cleanup_consumer.ts'
import type { CleanupInspection } from '../cloudflare_workers/r2_inventory/cleanup_database.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendCleanupAlert } from '../cloudflare_workers/r2_inventory/cleanup_alerts.ts'
import { consumeCleanupBatch } from '../cloudflare_workers/r2_inventory/cleanup_consumer.ts'
import { CLEANUP_CONSUMER, completeCleanupGroup, inspectCleanupGroup, parseCleanupMessage } from '../cloudflare_workers/r2_inventory/cleanup_database.ts'
import { consumeInventoryBatch } from '../cloudflare_workers/r2_inventory/index.ts'

vi.mock('../cloudflare_workers/r2_inventory/cleanup_database.ts', async (original) => {
  const actual = await original<typeof import('../cloudflare_workers/r2_inventory/cleanup_database.ts')>()
  return { ...actual, inspectCleanupGroup: vi.fn(), completeCleanupGroup: vi.fn() }
})
vi.mock('../cloudflare_workers/r2_inventory/cleanup_alerts.ts', async (original) => {
  const actual = await original<typeof import('../cloudflare_workers/r2_inventory/cleanup_alerts.ts')>()
  return { ...actual, sendCleanupAlert: vi.fn() }
})
const key = 'orgs/synthetic/apps/com.test.cleanup/delta/object'
const stamp = '2026-10-14T01:02:03.123456Z'
function value(suffix = ''): CleanupMessage {
  return { schemaVersion: 1, bucket: 'capgo', key: key + suffix, cleanupRequestedAt: stamp }
}
function message(body: unknown) {
  return { body, id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, ack: vi.fn(), retry: vi.fn() } as unknown as Message<unknown>
}
function fixture(bodies: unknown[]) {
  const batch = { messages: bodies.map(message), queue: 'capgo-r2-inventory-prod-cleanup', retryAll: vi.fn(), ackAll: vi.fn() } as unknown as MessageBatch<unknown>
  const env = { INVENTORY_BUCKET: 'capgo', CLEANUP_DLQ: { sendBatch: vi.fn().mockResolvedValue(undefined) } } as unknown as CleanupConsumerEnv
  const remove = vi.fn().mockResolvedValue(undefined)
  const deps = { now: Date.now, storage: () => ({ remove }), database: vi.fn(work => work({} as never)) } as CleanupDependencies
  return { batch, env, deps, remove }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(completeCleanupGroup).mockResolvedValue([])
  vi.mocked(inspectCleanupGroup).mockImplementation(async (_db, _bucket, jobs) => ({
    snapshot: { startedAt: new Date().toISOString(), rows: jobs.map(job => ({ r2_key: job.key, etag: 'etag' })) },
    decisions: new Map(jobs.map(job => [job, 'remove'])),
    healthUntil: Date.now() + 300000,
  } as CleanupInspection))
})

afterEach(() => vi.useRealTimers())

describe('cleanup delivery isolation', () => {
  it('deduplicates identical jobs and acknowledges storage success before any completion database call', async () => {
    const f = fixture([value(), value(), value('-peer')])
    vi.mocked(completeCleanupGroup).mockImplementation(async () => {
      expect(f.batch.messages.every(m => vi.mocked(m.ack).mock.calls.length === 1)).toBe(true)
      throw new Error('Synthetic completion outage after acknowledgement')
    })
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.remove).toHaveBeenCalledTimes(2)
    for (const m of f.batch.messages)
      expect(m.retry).not.toHaveBeenCalled()
    expect(f.batch.retryAll).not.toHaveBeenCalled()
    expect(sendCleanupAlert).toHaveBeenLastCalledWith(f.deps.database, 'capgo', undefined, { completion: 1 })
  })

  it('retries only one failed storage job and keeps peers acknowledged after a bookkeeping conflict', async () => {
    const f = fixture([value(), value('-bad'), value('-peer')])
    f.remove.mockImplementation(async (_bucket, path) => {
      if (path.endsWith('-bad'))
        throw new Error('Synthetic copy failure')
    })
    vi.mocked(completeCleanupGroup).mockResolvedValue([key])
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.batch.messages[1].retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    for (const m of [f.batch.messages[0], f.batch.messages[2]]) {
      expect(m.ack).toHaveBeenCalledOnce()
      expect(m.retry).not.toHaveBeenCalled()
    }
  })

  it('logs at most three distinct storage diagnostics per batch while retrying every failed message', async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => value(String(i))))
    const types = ['AccessDenied', 'TypeError', 'Error', 'AbortError', 'TimeoutError']
    let index = 0
    f.deps.storage = report => ({ remove: async () => {
      report?.({ stage: 'copy', errorType: types[index++ % types.length], httpStatus: 403 })
      throw new Error('synthetic private detail')
    } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await consumeCleanupBatch(f.batch, f.env, f.deps)
      const entries = log.mock.calls.map(([entry]) => JSON.parse(entry))
      expect(entries).toEqual([
        ...types.slice(0, 3).map(errorType => ({ event: 'r2_cleanup_storage_failure', stage: 'copy', errorType, httpStatus: 403 })),
        { event: 'r2_cleanup_batch', received: 100, counts: { storage: 100 } },
      ])
      expect(JSON.stringify(entries)).not.toContain('synthetic private detail')
      expect(f.batch.messages.every(m => vi.mocked(m.retry).mock.calls.length === 1)).toBe(true)
    }
    finally {
      log.mockRestore()
    }
  })

  it('preserves references/leases, drops ordinary old/completed jobs quietly, and retries invisible retirement', async () => {
    const f = fixture(Array.from({ length: 6 }, (_, i) => value(String(i))))
    vi.mocked(inspectCleanupGroup).mockImplementationOnce(async (_db, _bucket, jobs) => ({
      snapshot: { rows: [], startedAt: new Date().toISOString() },
      healthUntil: Date.now() + 300000,
      decisions: new Map(jobs.map((job, i) => [job, ['referenced', 'leased', 'obsolete', 'completed', 'retry', 'retry'][i]])),
    } as CleanupInspection))
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.remove).not.toHaveBeenCalled()
    expect(completeCleanupGroup).not.toHaveBeenCalled()
    expect(sendCleanupAlert).toHaveBeenLastCalledWith(f.deps.database, 'capgo', undefined, { referenced: 1, leased: 1 })
    for (const m of f.batch.messages.slice(0, 4))
      expect(m.ack).toHaveBeenCalledOnce()
    for (const m of f.batch.messages.slice(4))
      expect(m.retry).toHaveBeenCalledOnce()
  })

  it('routes cleanup outside notification parsing and never uses the legacy retryAll path', async () => {
    const f = fixture([value()])
    await consumeInventoryBatch(f.batch, f.env as never)
    expect(f.batch.messages[0].retry).toHaveBeenCalledOnce() // missing inventory binding
    expect(f.batch.retryAll).not.toHaveBeenCalled()
    expect(inspectCleanupGroup).not.toHaveBeenCalled()
  })

  it('requires durable invalid-message publication and isolates failed publication from valid peers', async () => {
    const f = fixture([{ invalid: true }, value()])
    vi.mocked(f.env.CLEANUP_DLQ.sendBatch).mockRejectedValue(new Error('Synthetic DLQ outage'))
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.batch.messages[0].ack).not.toHaveBeenCalled()
    expect(f.batch.messages[0].retry).toHaveBeenCalledOnce()
    expect(f.batch.messages[1].ack).toHaveBeenCalledOnce()
    expect(f.batch.messages[1].retry).not.toHaveBeenCalled()
  })

  it('only acknowledges an invalid body after its DLQ publication resolves', async () => {
    const f = fixture([null])
    vi.mocked(f.env.CLEANUP_DLQ.sendBatch).mockImplementationOnce(async () => {
      expect(f.batch.messages[0].ack).not.toHaveBeenCalled()
      return {} as QueueSendBatchResponse
    })
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.batch.messages[0].ack).toHaveBeenCalledOnce()
  })

  it('uses fresh groups of 20, four progressing workflows, and no per-object database connections', async () => {
    const f = fixture(Array.from({ length: 100 }, (_, i) => value(String(i))))
    let inFlight = 0
    let maximum = 0
    f.remove.mockImplementation(async () => {
      maximum = Math.max(maximum, ++inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight--
    })
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(maximum).toBe(4)
    expect(inspectCleanupGroup).toHaveBeenCalledTimes(5)
    expect(completeCleanupGroup).toHaveBeenCalledTimes(5)
    expect(f.deps.database).toHaveBeenCalledTimes(10)
    expect(f.batch.messages.every(m => vi.mocked(m.ack).mock.calls.length === 1)).toBe(true)
  })

  it('bounds a full near-deadline batch with fresh snapshots and no DB held during storage', async () => {
    vi.useFakeTimers()
    const f = fixture(Array.from({ length: 100 }, (_, i) => value(String(i))))
    let databaseOpen = false
    f.deps.database = async (work) => {
      databaseOpen = true
      try {
        return await work({} as never)
      }
      finally {
        databaseOpen = false
      }
    }
    f.remove.mockImplementation(async () => {
      expect(databaseOpen).toBe(false)
      await new Promise(resolve => setTimeout(resolve, 19999))
    })
    const start = Date.now()
    const run = consumeCleanupBatch(f.batch, f.env, f.deps)
    await vi.runAllTimersAsync()
    await run
    expect(Date.now() - start).toBe(499975)
    expect(inspectCleanupGroup).toHaveBeenCalledTimes(5)
    expect(completeCleanupGroup).toHaveBeenCalledTimes(5)
    for (const m of f.batch.messages) {
      expect(m.ack).toHaveBeenCalledOnce()
      expect(m.retry).not.toHaveBeenCalled()
    }
  })

  it('rechecks health between groups and keeps earlier successes final when the next check fails', async () => {
    const f = fixture(Array.from({ length: 21 }, (_, i) => value(String(i))))
    vi.mocked(inspectCleanupGroup).mockImplementationOnce(async (_db, _bucket, jobs) => ({
      snapshot: { startedAt: new Date().toISOString(), rows: [] },
      decisions: new Map(jobs.map(job => [job, 'remove'])),
      healthUntil: Date.now() + 300000,
    } as CleanupInspection)).mockRejectedValueOnce(new Error('Stale replication'))
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.batch.messages[0].ack).toHaveBeenCalledOnce()
    expect(f.batch.messages[0].retry).not.toHaveBeenCalled()
    expect(f.batch.messages[20].retry).toHaveBeenCalledOnce()
  })

  it('stops starting storage with insufficient batch or health budget', async () => {
    const f = fixture([value()])
    let calls = 0
    const start = Date.now()
    f.deps.now = () => start + (calls++ ? CLEANUP_CONSUMER.batchMs : 0)
    await consumeCleanupBatch(f.batch, f.env, f.deps)
    expect(f.remove).not.toHaveBeenCalled()
    expect(f.batch.messages[0].retry).toHaveBeenCalledOnce()
    const g = fixture([value()])
    vi.mocked(inspectCleanupGroup).mockImplementationOnce(async (_db, _bucket, jobs) => ({
      snapshot: { startedAt: new Date().toISOString(), rows: [] },
      decisions: new Map(jobs.map(job => [job, 'remove'])),
      healthUntil: Date.now() + 19000,
    } as CleanupInspection))
    await consumeCleanupBatch(g.batch, g.env, g.deps)
    expect(g.remove).not.toHaveBeenCalled()
    expect(g.batch.messages[0].retry).toHaveBeenCalledOnce()
  })
})

describe('cleanup message validation', () => {
  it('preserves exact microsecond identity', () => {
    expect(parseCleanupMessage(value(), 'capgo').cleanupRequestedAt).toBe(stamp)
  })
  it.each([
    { schemaVersion: 2 },
    { bucket: 'other' },
    { key: 'deleted-after-7-days/object' },
    { key: `${key}/../file` },
    { key: `${key}/trash/file` },
    { key: `${key}/a.ZIP` },
    { key: `${key}//file` },
    { key: `${key}\0` },
    { key: key + 'x'.repeat(1024) },
    { cleanupRequestedAt: '2026-02-30T01:02:03.123456Z' },
    { cleanupRequestedAt: '2026-10-14T01:02:03.123Z' },
  ])('rejects invalid scope or identity %j', (override) => {
    expect(() => parseCleanupMessage({ ...value(), ...override }, 'capgo')).toThrow()
  })
})
