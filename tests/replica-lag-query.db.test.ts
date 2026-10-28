import { describe, expect, it } from 'vitest'
import {
  LOGICAL_SUBSCRIBER_APPLY_LAG_PROBE_SQL,
  REPLICA_LAG_QUERY,
  REPLICATION_LAG_APPLY_THRESHOLD_SECONDS,
  UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS,
  logicalSubscriberApplyLagCaseSql,
  replicationLagStatusFromSeconds,
} from '../supabase/functions/_backend/plugin_runtime/utils/replicaFreshness.ts'
import { executeSQL } from './test-utils.ts'

function toLagSeconds(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

async function probeApplyLag(
  latestEndTime: Date | null,
  lastReceipt: Date | null,
  receivedLsn: string | null,
  latestEndLsn: string | null,
): Promise<number | null> {
  const rows = await executeSQL<{ lag_seconds: string | number | null }>(
    LOGICAL_SUBSCRIBER_APPLY_LAG_PROBE_SQL,
    [latestEndTime, lastReceipt, receivedLsn, latestEndLsn],
  )
  return toLagSeconds(rows[0]?.lag_seconds)
}

describe('logical subscriber apply lag SQL', () => {
  it('embeds the shared CASE in REPLICA_LAG_QUERY', () => {
    expect(REPLICA_LAG_QUERY).toContain(logicalSubscriberApplyLagCaseSql(''))
    expect(REPLICA_LAG_QUERY).toContain('pg_stat_subscription')
    expect(REPLICA_LAG_QUERY).toContain('::pg_lsn >')
  })

  it('treats unapplied WAL with null latest_end_time as over-threshold lag', async () => {
    const receiptFresh = new Date(Date.now() - 5_000)
    const lag = await probeApplyLag(null, receiptFresh, '0/1000', '0/900')
    expect(lag).toBe(UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS)
    expect(replicationLagStatusFromSeconds(lag)).toBe('lagging')
  })

  it('uses pg_lsn ordering so 0/1000 is ahead of 0/900', async () => {
    const lag = await probeApplyLag(null, null, '0/1000', '0/900')
    expect(lag).toBe(UNAPPLIED_LOGICAL_SUBSCRIBER_WAL_LAG_SECONDS)
  })

  it('marks exactly 180s apply age as ok and 181s as lagging', async () => {
    const rows180 = await executeSQL<{ lag_seconds: string }>(`
      SELECT ${logicalSubscriberApplyLagCaseSql('t.')} AS lag_seconds
      FROM (
        SELECT
          now() - interval '180 seconds' AS latest_end_time,
          NULL::timestamptz AS last_msg_receipt_time,
          NULL::pg_lsn AS received_lsn,
          NULL::pg_lsn AS latest_end_lsn
      ) t
    `)
    const lag180 = toLagSeconds(rows180[0]?.lag_seconds)
    expect(lag180).not.toBeNull()
    expect(lag180!).toBeGreaterThanOrEqual(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS - 1)
    expect(lag180!).toBeLessThanOrEqual(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS + 1)
    expect(replicationLagStatusFromSeconds(lag180)).toBe('ok')

    const rows181 = await executeSQL<{ lag_seconds: string }>(`
      SELECT ${logicalSubscriberApplyLagCaseSql('t.')} AS lag_seconds
      FROM (
        SELECT
          now() - interval '181 seconds' AS latest_end_time,
          NULL::timestamptz AS last_msg_receipt_time,
          NULL::pg_lsn AS received_lsn,
          NULL::pg_lsn AS latest_end_lsn
      ) t
    `)
    const lag181 = toLagSeconds(rows181[0]?.lag_seconds)
    expect(lag181).not.toBeNull()
    expect(lag181!).toBeGreaterThan(REPLICATION_LAG_APPLY_THRESHOLD_SECONDS)
    expect(replicationLagStatusFromSeconds(lag181)).toBe('lagging')
  })
})
