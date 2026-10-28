import { afterEach, describe, expect, it, vi } from 'vitest'
import { CacheHelper } from '../supabase/functions/_backend/plugin_runtime/utils/cache.ts'
import { getReadReplicaBinding } from '../supabase/functions/_backend/plugin_runtime/utils/pg.ts'
import { computeLogicalSubscriberApplyLagSeconds, edgeCacheTtlForReplicaLag, isReadReplicaSource, LOGICAL_SUBSCRIBER_APPLY_LAG_PROBE_SQL, maxLogicalSubscriberApplyLagSeconds, pgLsnGreaterThan, REPLICA_LAG_QUERY, REPLICATION_LAG_APPLY_THRESHOLD_SECONDS, replicationLagCacheRequest, replicationLagStatusFromSeconds, resetReplicationLagMemory, setReplicationLagMemoryEntry, UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS } from '../supabase/functions/_backend/plugin_runtime/utils/replicaFreshness.ts'

function contextFrom(source: string | undefined) {
  return {
    env: {},
    req: { url: 'https://plugin.capgo.test/updates', raw: new Request('https://plugin.capgo.test/updates'), header: () => undefined },
    get: (key: string) => key === 'databaseSource' ? source : undefined,
    res: { headers: new Headers() },
  } as any
}

/** In-memory Cache API stand-in. */
function stubCaches() {
  const store = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      store.set(request.url, response.clone())
    }),
    delete: vi.fn(async (request: Request) => store.delete(request.url)),
  }
  vi.stubGlobal('caches', { default: cache, open: vi.fn().mockResolvedValue(cache) })
  return cache
}

describe('replica freshness', () => {
  afterEach(() => {
    resetReplicationLagMemory()
    vi.unstubAllGlobals()
  })

  it('tells read replicas from primary sources', () => {
    expect(isReadReplicaSource('HYPERDRIVE_CAPGO_READ_OC')).toBe(true)
    expect(isReadReplicaSource('HYPERDRIVE_CAPGO_READ_EU')).toBe(true)
    expect(isReadReplicaSource('local_read_replica')).toBe(true)
    expect(isReadReplicaSource('HYPERDRIVE_CAPGO_DIRECT_EU')).toBe(false)
    expect(isReadReplicaSource('sb_pooler_main')).toBe(false)
    expect(isReadReplicaSource('unknown')).toBe(false)
  })

  it('keeps the full TTL for primary reads, even with a lagging figure recorded for them', async () => {
    stubCaches()
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_DIRECT_EU', { status: 'lagging', max_lag_seconds: 2400 })
    expect(await edgeCacheTtlForReplicaLag(contextFrom('HYPERDRIVE_CAPGO_DIRECT_EU'), 3600)).toBe(3600)
    setReplicationLagMemoryEntry('unknown', { status: 'lagging', max_lag_seconds: 2400 })
    expect(await edgeCacheTtlForReplicaLag(contextFrom(undefined), 3600)).toBe(3600)
  })

  it('shortens the TTL only for a replica measured behind (fails open)', async () => {
    stubCaches()
    const c = contextFrom('HYPERDRIVE_CAPGO_READ_HK')
    // No figure, unknown, or within the bound: unchanged TTL, no extra load.
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_HK', { status: 'unknown', max_lag_seconds: null })
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_HK', { status: 'ok', max_lag_seconds: 60 })
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
    // Measured behind.
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_HK', { status: 'ok', max_lag_seconds: 61 })
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(30)
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_HK', { status: 'lagging', max_lag_seconds: 2400 })
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(30)
    // Never raises a shorter TTL.
    expect(await edgeCacheTtlForReplicaLag(c, 10)).toBe(10)
    // An expired figure no longer counts.
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_HK', { status: 'lagging', max_lag_seconds: 2400 }, Date.now() - 1)
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
  })

  it('ignores an expired data center figure', async () => {
    stubCaches()
    const c = contextFrom('HYPERDRIVE_CAPGO_READ_ME')
    const helper = new CacheHelper(c)
    await helper.putJson(replicationLagCacheRequest(helper, 'HYPERDRIVE_CAPGO_READ_ME'), { status: 'lagging', max_lag_seconds: 2400, expiresAt: Date.now() - 1 }, 60)
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
  })

  it('keeps a figure measured while the data center read was in flight', async () => {
    const cache = stubCaches()
    const c = contextFrom('HYPERDRIVE_CAPGO_READ_AF')
    const helper = new CacheHelper(c)
    await helper.putJson(replicationLagCacheRequest(helper, 'HYPERDRIVE_CAPGO_READ_AF'), { status: 'ok', max_lag_seconds: 1, expiresAt: Date.now() + 60_000 }, 60)
    const match = cache.match.getMockImplementation()!
    cache.match.mockImplementationOnce(async (request: Request) => {
      // A probe lands first with a lagging figure.
      setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_AF', { status: 'lagging', max_lag_seconds: 2400 })
      return match(request)
    })
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(30)
    // The older data center figure did not replace it.
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(30)
  })

  it('names the local read replica on local workers', () => {
    vi.stubEnv('ENV_NAME', 'capgo_plugin-local')
    vi.stubEnv('LOCAL_READ_REPLICA_SUPABASE_DB_URL', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres')
    try {
      expect(getReadReplicaBinding(contextFrom(undefined))).toBe('local_read_replica')
      vi.unstubAllEnvs()
      vi.stubEnv('ENV_NAME', 'capgo_plugin-local')
      expect(getReadReplicaBinding(contextFrom(undefined))).toBeNull()
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it('uses an explicit source when the request itself read no database', async () => {
    stubCaches()
    setReplicationLagMemoryEntry('HYPERDRIVE_CAPGO_READ_OC', { status: 'lagging', max_lag_seconds: 2400 })
    expect(await edgeCacheTtlForReplicaLag(contextFrom(undefined), 900, 'HYPERDRIVE_CAPGO_READ_OC')).toBe(30)
  })

  it('reads the data center figure once on a cold isolate, then memoizes a miss', async () => {
    const cache = stubCaches()
    const c = contextFrom('HYPERDRIVE_CAPGO_READ_SA')
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
    expect(await edgeCacheTtlForReplicaLag(c, 3600)).toBe(3600)
    // The second call skipped the Cache API (no figure there).
    expect(cache.match).toHaveBeenCalledTimes(1)
  })

  // Smoke check only: CI has no physical standby to run the standby branch on.
  it('smoke: covers physical standbys, not only the logical subscriber', () => {
    expect(REPLICA_LAG_QUERY).toContain('pg_is_in_recovery()')
    expect(REPLICA_LAG_QUERY).toContain('pg_last_xact_replay_timestamp()')
    expect(REPLICA_LAG_QUERY).toContain('pg_stat_subscription')
    expect(REPLICA_LAG_QUERY).toContain('latest_end_time')
    expect(REPLICA_LAG_QUERY).toContain('::pg_lsn >')
    expect(REPLICA_LAG_QUERY).toContain(String(UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS))
    expect(REPLICA_LAG_QUERY).toContain('status IS NULL')
    expect(LOGICAL_SUBSCRIBER_APPLY_LAG_PROBE_SQL).toContain('::pg_lsn AS received_lsn')
  })

  it('compares pg LSN hex segments numerically', () => {
    expect(pgLsnGreaterThan('0/1000', '0/900')).toBe(true)
    expect(pgLsnGreaterThan('0/900', '0/1000')).toBe(false)
    expect(pgLsnGreaterThan('0/1000', '0/1000')).toBe(false)
  })

  it('uses strict greater-than threshold at 180 and 181 seconds', () => {
    expect(replicationLagStatusFromSeconds(180)).toBe('ok')
    expect(replicationLagStatusFromSeconds(181)).toBe('lagging')
    expect(replicationLagStatusFromSeconds(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS)).toBe('ok')
    expect(replicationLagStatusFromSeconds(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS + 1)).toBe('lagging')
  })

  it('treats unapplied WAL with null latest_end_time as lagging even with fresh receipt', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    const receiptFresh = new Date(now - 5_000)
    const row = {
      last_msg_receipt_time: receiptFresh,
      latest_end_time: null,
      received_lsn: '0/1000',
      latest_end_lsn: '0/900',
    }
    const receiptOnlyLag = (now - receiptFresh.getTime()) / 1000
    expect(receiptOnlyLag).toBeLessThan(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS)

    const applyLag = computeLogicalSubscriberApplyLagSeconds(row, now)
    expect(applyLag).toBe(UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS)
    expect(replicationLagStatusFromSeconds(applyLag)).toBe('lagging')
  })

  it('treats a stuck subscriber with fresh receipt but stale apply time as lagging', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    const receiptFresh = new Date(now - 5_000)
    const applyStale = new Date(now - 400_000)
    const row = {
      last_msg_receipt_time: receiptFresh,
      latest_end_time: applyStale,
      received_lsn: '0/300',
      latest_end_lsn: '0/100',
    }
    const receiptOnlyLag = (now - receiptFresh.getTime()) / 1000
    expect(receiptOnlyLag).toBeLessThan(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS)

    const applyLag = computeLogicalSubscriberApplyLagSeconds(row, now)
    expect(applyLag).toBeGreaterThan(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS)
    expect(replicationLagStatusFromSeconds(applyLag)).toBe('lagging')

    const aggregate = maxLogicalSubscriberApplyLagSeconds([row], now)
    expect(aggregate).toBe(applyLag)
  })

  it('keeps a healthy subscriber with fresh apply at ok lag', () => {
    const now = Date.parse('2026-10-28T12:00:00.000Z')
    const fresh = new Date(now - 2_000)
    const lag = computeLogicalSubscriberApplyLagSeconds({
      last_msg_receipt_time: fresh,
      latest_end_time: fresh,
      received_lsn: '0/100',
      latest_end_lsn: '0/100',
    }, now)
    expect(lag).toBeLessThanOrEqual(2)
    expect(replicationLagStatusFromSeconds(lag)).toBe('ok')
  })
})
