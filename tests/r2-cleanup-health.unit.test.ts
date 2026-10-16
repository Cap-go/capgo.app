import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkCleanupHealth, CLEANUP_HEALTH, DESTINATION_HEALTH_SQL, REPLICATION, replicationHealthy, requireCleanupHealth, SOURCE_HEALTH_SQL } from '../cloudflare_workers/r2_inventory/health.ts'

const sourceRow = () => ({ active: true, wal_status: 'reserved', state: 'streaming', feedback_age: 1, replay_seconds: null, wal_bytes: '0', publication_ok: true })
const destinationRow = () => ({ subenabled: true, subslotname: REPLICATION.slot, subpublications: [REPLICATION.publication], pid: 42, srsubstate: 'r', receipt_age: 1, observed_at: new Date().toISOString(), apply_error_count: '2', sync_error_count: '1' })
type Query = string | { text: string }
const queryText = (input: Query) => typeof input === 'string' ? input : input.text
function fixture() {
  const client = (row: object) => ({
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn(async (input: Query) => ({ rows: queryText(input).startsWith('SELECT') ? [row] : queryText(input).startsWith('INSERT') ? [{ published: true }] : [] })),
    end: vi.fn().mockResolvedValue(undefined),
  })
  const source = client(sourceRow())
  const inventory = client(destinationRow())
  const run = () => checkCleanupHealth(source as never, inventory as never, 'synthetic')
  return { source, inventory, run }
}
afterEach(() => vi.useRealTimers())

describe('direct cleanup health', () => {
  it('starts both database checks concurrently, then persists the direct result', async () => {
    const f = fixture()
    let connect: () => void = () => {}
    f.source.connect.mockImplementation(() => new Promise<void>((resolve) => {
      connect = resolve
    }))
    const checking = f.run()
    await vi.waitFor(() => expect(f.inventory.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'commit' }), []))
    expect(f.source.connect).toHaveBeenCalledOnce()
    expect(f.inventory.connect).toHaveBeenCalledOnce()
    expect(f.inventory.query.mock.calls.some(([sql]) => queryText(sql).startsWith('INSERT'))).toBe(false)
    connect()
    const result = await checking
    expect(result).toMatchObject({ schemaVersion: 3, healthy: true, manifestReplicationHealthy: true, reasons: [] })
    requireCleanupHealth(result)
    const publish = f.inventory.query.mock.calls.find(([sql]) => queryText(sql).startsWith('INSERT')) as unknown as [string, string[]]
    expect(publish[0]).toContain('\'cleanup_health\'')
    expect(JSON.parse(publish[1][1])).toEqual(result)
    expect(f.source.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'begin read only' }), [])
    expect(f.inventory.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'begin read only' }), [])
    expect(f.source.query).toHaveBeenCalledWith(SOURCE_HEALTH_SQL, [REPLICATION.slot, REPLICATION.publication])
    expect(f.inventory.query).toHaveBeenCalledWith(DESTINATION_HEALTH_SQL, [REPLICATION.subscription])
    expect(f.inventory.query.mock.calls.some(([sql]) => queryText(sql).startsWith('SELECT checkpoint'))).toBe(false)
  })

  it.each([
    { active: false },
    { wal_status: 'lost' },
    { state: 'catchup' },
    { publication_ok: false },
    { feedback_age: null },
    { feedback_age: NaN },
    { feedback_age: -1 },
    { feedback_age: 61 },
    { wal_bytes: null },
    { wal_bytes: '-1' },
    { wal_bytes: 'NaN' },
    { wal_bytes: String(CLEANUP_HEALTH.walBytes + 1) },
    { replay_seconds: 31 },
    { replay_seconds: NaN },
    { replay_seconds: -1 },
  ])('rejects source state %j', (override) => {
    expect(replicationHealthy({ ...sourceRow(), ...override }, destinationRow())).toBe(false)
  })

  it.each([
    { subenabled: false },
    { subslotname: 'wrong' },
    { subpublications: ['wrong'] },
    { subpublications: [REPLICATION.publication, 'extra'] },
    { pid: null },
    { pid: 0 },
    { srsubstate: 'd' },
    { receipt_age: null },
    { receipt_age: 61 },
    { receipt_age: -1 },
  ])('rejects destination state %j', (override) => {
    expect(replicationHealthy(sourceRow(), { ...destinationRow(), ...override })).toBe(false)
  })

  it('accepts idle replication, bounded WAL feedback and recovered historical errors', () => {
    expect(replicationHealthy(sourceRow(), destinationRow())).toBe(true)
    expect(replicationHealthy({ ...sourceRow(), wal_bytes: String(CLEANUP_HEALTH.walBytes), replay_seconds: 30 }, destinationRow())).toBe(true)
    expect(replicationHealthy(undefined, destinationRow())).toBe(false)
    expect(replicationHealthy(sourceRow(), undefined)).toBe(false)
  })

  it('fails closed for permission failures and writes negative evidence when inventory is available', async () => {
    const f = fixture()
    const normal = f.source.query.getMockImplementation()!
    f.source.query.mockImplementation(input => queryText(input) === SOURCE_HEALTH_SQL ? Promise.reject(new Error('permission denied')) : normal(input))
    const result = await f.run()
    expect(result.healthy).toBe(false)
    expect(result.manifestReplicationHealthy).toBe(false)
    expect(f.source.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'rollback' }), [])
    expect(f.inventory.query.mock.calls.some(([sql]) => queryText(sql).startsWith('INSERT'))).toBe(true)
  })

  it('does not authorize the producer if publication fails', async () => {
    const f = fixture()
    const normal = f.inventory.query.getMockImplementation()!
    f.inventory.query.mockImplementation(async text => queryText(text).startsWith('INSERT') ? Promise.reject(new Error('write failed')) : normal(text))
    const result = await f.run()
    expect(result.healthy).toBe(false)
    expect(result.reasons).toContain('health_query_or_write_failed')
    expect(f.source.end).toHaveBeenCalled()
    expect(f.inventory.end).toHaveBeenCalled()
    expect(f.inventory.query).toHaveBeenCalledWith(expect.objectContaining({ text: 'rollback' }), [])
  })

  it('does not overwrite a newer observation or authorize unpublished evidence', async () => {
    const f = fixture()
    const normal = f.inventory.query.getMockImplementation()!
    f.inventory.query.mockImplementation(async text => queryText(text).startsWith('INSERT') ? { rows: [] } : normal(text))
    const result = await f.run()
    expect(result.healthy).toBe(false)
    expect(result.reasons).toContain('health_query_or_write_failed')
  })

  it.each(['connection', 'read_setup', 'query', 'read_commit', 'write', 'write_commit'])('bounds the entire %s operation to five seconds and prevents late continuation', async (phase) => {
    vi.useFakeTimers()
    const f = fixture()
    let finish: (value: any) => void = () => {}
    const stalled = new Promise<any>((resolve) => {
      finish = resolve
    })
    if (phase === 'connection')
      f.source.connect.mockImplementation(() => stalled)
    if (phase === 'read_setup' || phase === 'query' || phase === 'read_commit') {
      const normal = f.source.query.getMockImplementation()!
      const target = phase === 'query' ? SOURCE_HEALTH_SQL : phase === 'read_commit' ? 'commit' : 'SET LOCAL statement_timeout = \'3s\''
      f.source.query.mockImplementation(input => queryText(input) === target ? stalled : normal(input))
    }
    if (phase === 'write') {
      const normal = f.inventory.query.getMockImplementation()!
      f.inventory.query.mockImplementation(text => queryText(text).startsWith('INSERT') ? stalled : normal(text))
    }
    if (phase === 'write_commit') {
      const normal = f.inventory.query.getMockImplementation()!
      let commits = 0
      f.inventory.query.mockImplementation(input => queryText(input) === 'commit' && ++commits === 2 ? stalled : normal(input))
    }
    const checking = f.run()
    await vi.advanceTimersByTimeAsync(4999)
    const settled = vi.fn()
    void checking.then(settled)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    const result = await checking
    expect(result.healthy).toBe(false)
    expect(result.reasons).toContain('health_timeout')
    expect(f.source.end).toHaveBeenCalled()
    expect(f.inventory.end).toHaveBeenCalled()
    const calls = f.inventory.query.mock.calls.length
    const sourceCalls = f.source.query.mock.calls.length
    finish({ rows: [sourceRow()] })
    await vi.advanceTimersByTimeAsync(0)
    // Drizzle may attempt rollback after a stalled statement settles; no late
    // SELECT, publication or commit may follow the deadline.
    expect(f.inventory.query.mock.calls.slice(calls).every(([input]) => queryText(input) === 'rollback')).toBe(true)
    expect(f.source.query.mock.calls.slice(sourceCalls).every(([input]) => queryText(input) === 'rollback')).toBe(true)
    expect(result.healthy).toBe(false)
  })

  it('rejects an expired in-memory result without reading a database row', async () => {
    const f = fixture()
    const result = await f.run()
    expect(() => requireCleanupHealth({ ...result, checkedAt: Date.now() - 30_001 })).toThrow('expired')
    expect(() => requireCleanupHealth({ ...result, healthy: false })).toThrow('failed')
    expect(() => requireCleanupHealth({ ...result, checkedAt: Date.now() + 1000 })).toThrow('failed')
  })
})
