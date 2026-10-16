import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESTINATION_HEALTH_SQL, REPLICATION, SOURCE_HEALTH_SQL } from '../cloudflare_workers/r2_inventory/health.ts'
import { scheduleInventoryCleanup } from '../cloudflare_workers/r2_inventory/index.ts'

const state = vi.hoisted(() => ({ queries: [] as string[], connections: [] as string[], sourceHealthy: true, pages: 0 }))
vi.mock('pg', async (original) => {
  const actual = await original<typeof import('pg')>()
  return { ...actual, Client: class {
    constructor(readonly options: { connectionString: string }) {}
    on() {}
    async connect() { state.connections.push(this.options.connectionString) }
    async end() {}
    async query(input: string | { text: string }, values?: unknown[]) {
      const text = typeof input === 'string' ? input : input.text
      state.queries.push(text)
      let rows: object[] = []
      if (text === SOURCE_HEALTH_SQL)
        rows = [{ active: state.sourceHealthy, wal_status: 'reserved', state: 'streaming', feedback_age: 1, replay_seconds: null, wal_bytes: '0', publication_ok: true }]
      else if (text === DESTINATION_HEALTH_SQL)
        rows = [{ subenabled: true, subslotname: REPLICATION.slot, subpublications: [REPLICATION.publication], pid: 42, srsubstate: 'r', receipt_age: 1, observed_at: new Date().toISOString() }]
      else if (text.startsWith('INSERT INTO public.r2_inventory_checkpoints AS c'))
        rows = text.includes('leaseUntil') ? [{ owner: values![2], fence: '1', cursor: '' }] : [{ published: true }]
      else if (text.startsWith('WITH page'))
        rows = state.pages++ === 0 ? [{ r2_key: 'orgs/synthetic/apps/com.test.cleanup/delta/file', eligible: true }] : []
      else if (text.startsWith('UPDATE public.r2_objects'))
        rows = (values![1] as string[]).map(r2_key => ({ r2_key, cleanup_requested_at: '2026-10-15T10:00:00.123456Z' }))
      else if (text.startsWith('SELECT 1 FROM public.r2_inventory_checkpoints') || (text.startsWith('UPDATE public.r2_inventory_checkpoints') && text.includes('RETURNING 1')))
        rows = [{ present: true }]
      return { rows, fields: [], rowCount: rows.length }
    }
  } }
})
afterEach(() => vi.restoreAllMocks())

function fixture() {
  state.connections = []
  state.queries = []
  state.sourceHealthy = true
  state.pages = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const metrics = vi.fn().mockResolvedValue({ backlogCount: 1_000_000, backlogBytes: 256_000_000 })
  const probe = vi.fn(() => {
    throw new Error('Unexpected health probe')
  })
  const queue = { metrics, sendBatch: vi.fn().mockResolvedValue(undefined) }
  const env = {
    INVENTORY_BUCKET: 'capgo',
    HYPERDRIVE_R2_INVENTORY: { connectionString: 'postgresql://inventory.invalid' },
    HYPERDRIVE_CAPGO_DIRECT_EU: { connectionString: 'postgresql://source.invalid' },
    EVENT_QUEUE: { metrics, send: probe, sendBatch: probe },
    REPAIR_QUEUE: { metrics, send: probe, sendBatch: probe },
    EVENT_DLQ: { metrics, send: probe, sendBatch: probe },
    REPAIR_DLQ: { metrics, send: probe, sendBatch: probe },
    CLEANUP_QUEUE: queue,
  }
  const run = () => scheduleInventoryCleanup({} as ScheduledController, env as never)
  return { run, queue, metrics, probe }
}

describe('enabled cleanup cron', () => {
  it('ignores queue backlogs and publishes cleanup work using the existing inventory connection', async () => {
    const f = fixture()
    await f.run()
    expect(state.connections).toEqual(['postgresql://source.invalid', 'postgresql://inventory.invalid'])
    expect(f.queue.sendBatch).toHaveBeenCalledOnce()
    expect(f.metrics).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.queue.sendBatch.mock.calls[0][0][0].body).toMatchObject({ bucket: 'capgo', key: 'orgs/synthetic/apps/com.test.cleanup/delta/file', cleanupRequestedAt: '2026-10-15T10:00:00.123456Z' })
    expect(state.queries.some(sql => sql.startsWith('INSERT') && sql.includes('\'cleanup_health\''))).toBe(true)
    expect(state.queries.some(sql => sql.startsWith('SELECT') && sql.includes('\'cleanup_health\''))).toBe(false)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"retired":1'))
  })

  it('continues producing when consumer metrics are unavailable', async () => {
    const f = fixture()
    f.metrics.mockImplementation(() => {
      throw new Error('Consumer metrics unavailable')
    })
    await f.run()
    expect(f.queue.sendBatch).toHaveBeenCalledOnce()
    expect(f.metrics).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
  })

  it('persists health without sending probe messages when there is no cleanup work', async () => {
    const f = fixture()
    state.pages = 1
    await f.run()
    expect(f.queue.sendBatch).not.toHaveBeenCalled()
    expect(f.metrics).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    expect(state.queries.some(sql => sql.startsWith('INSERT') && sql.includes('\'cleanup_health\''))).toBe(true)
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"retired":0'))
  })

  it('publishes negative health and skips all retirement when replication is unhealthy', async () => {
    const f = fixture()
    state.sourceHealthy = false
    await f.run()
    expect(f.queue.sendBatch).not.toHaveBeenCalled()
    expect(state.queries.some(sql => sql.startsWith('UPDATE public.r2_objects'))).toBe(false)
    expect(state.queries.some(sql => sql.includes('cleanup_producer'))).toBe(false)
    expect(state.queries.some(sql => sql.startsWith('INSERT') && sql.includes('\'cleanup_health\''))).toBe(true)
  })
})
