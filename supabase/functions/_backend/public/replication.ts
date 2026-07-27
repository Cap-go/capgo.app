import { sql } from 'drizzle-orm'
import { honoFactory, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getDrizzleClient, getPgClient, logPgError } from '../utils/pg.ts'
import { validatePlatformAdminOrApiSecret } from '../utils/platform_admin_access.ts'

const DEFAULT_THRESHOLD_SECONDS = 180
const DEFAULT_THRESHOLD_BYTES = 16 * 1024 * 1024

type SlotStatus = 'ok' | 'ko'
type ReplicationQueryMode = 'wal_stats' | 'replication_stats' | 'slots_only'

interface ReplicationSlotLag {
  slot_name: string
  active: boolean
  confirmed_flush_lsn: string | null
  restart_lsn: string | null
  lag_bytes: number | null
  slot_lag: string | null
  lag_seconds: number | null
  lag_seconds_est: number | null
  effective_lag_seconds: number | null
  lag_minutes: number | null
  status: SlotStatus
  reasons: string[]
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  const num = Number(value)
  if (!Number.isFinite(num))
    return null
  return num
}

function buildReplicationQuery(mode: ReplicationQueryMode) {
  const slotsCte = sql`
      WITH slots AS (
        SELECT
          slot_name,
          active,
          confirmed_flush_lsn,
          restart_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS slot_lag
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
          AND slot_name !~ '^pg_[0-9]+_sync_[0-9]+_[0-9]+$'
          AND slot_name !~ '^supabase_'
      )
  `

  if (mode === 'wal_stats') {
    return sql`
      WITH wal_stats AS (
        SELECT
          wal_bytes::numeric AS wal_bytes,
          EXTRACT(EPOCH FROM (now() - stats_reset))::numeric AS seconds_since_reset
        FROM pg_stat_wal
      ),
      slots AS (
        SELECT
          slot_name,
          active,
          confirmed_flush_lsn,
          restart_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes,
          pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS slot_lag
        FROM pg_replication_slots
        WHERE slot_type = 'logical'
          AND slot_name !~ '^pg_[0-9]+_sync_[0-9]+_[0-9]+$'
          AND slot_name !~ '^supabase_'
      )
      SELECT
        slots.*,
        NULL::numeric AS lag_seconds,
        CASE
          WHEN wal_stats.seconds_since_reset > 0
            AND wal_stats.wal_bytes > 0
            AND slots.lag_bytes IS NOT NULL
            THEN (slots.lag_bytes / (wal_stats.wal_bytes / wal_stats.seconds_since_reset))
          ELSE NULL
        END AS lag_seconds_est
      FROM slots
      CROSS JOIN wal_stats
      ORDER BY slots.slot_name
    `
  }

  if (mode === 'replication_stats') {
    return sql`
      ${slotsCte}
      SELECT
        slots.*,
        EXTRACT(EPOCH FROM COALESCE(sr.flush_lag, sr.write_lag, sr.replay_lag))::numeric AS lag_seconds,
        NULL::numeric AS lag_seconds_est
      FROM slots
      LEFT JOIN pg_stat_replication sr ON sr.slot_name = slots.slot_name
      ORDER BY slots.slot_name
    `
  }

  return sql`
    ${slotsCte}
    SELECT
      slots.*,
      NULL::numeric AS lag_seconds,
      NULL::numeric AS lag_seconds_est
    FROM slots
    ORDER BY slots.slot_name
  `
}

async function executeReplicationQuery(
  c: Parameters<typeof cloudlogErr>[0],
  drizzleClient: ReturnType<typeof getDrizzleClient>,
): Promise<{ rows: any[], mode: ReplicationQueryMode }> {
  const modes: ReplicationQueryMode[] = ['wal_stats', 'slots_only']
  let lastError: unknown = null

  for (const mode of modes) {
    try {
      const query = buildReplicationQuery(mode)
      const result = await drizzleClient.execute(query)
      return { rows: result.rows as any[], mode }
    }
    catch (error) {
      lastError = error
      cloudlogErr({
        requestId: c.requestId,
        message: 'replication_lag_query_failed',
        error,
        mode,
      })
    }
  }

  throw lastError
}

export const app = honoFactory.createApp()

app.use('*', useCors)

app.get('/', async (c) => {
  await validatePlatformAdminOrApiSecret(c, {
    logPrefix: 'replication',
    forbiddenMessage: 'Not admin - only admin users can access replication status',
  })

  const thresholdSeconds = DEFAULT_THRESHOLD_SECONDS
  const thresholdBytes = DEFAULT_THRESHOLD_BYTES

  const pgClient = getPgClient(c, false)
  const drizzleClient = getDrizzleClient(pgClient)

  try {
    const { rows, mode } = await executeReplicationQuery({ requestId: c.get('requestId') }, drizzleClient)

    const slots: ReplicationSlotLag[] = rows.map((row: any) => {
      const lagSeconds = toNumber(row.lag_seconds)
      const lagSecondsEst = toNumber(row.lag_seconds_est)
      const lagBytes = toNumber(row.lag_bytes)
      const active = Boolean(row.active)

      let effectiveLagSeconds = lagSeconds ?? lagSecondsEst
      if (effectiveLagSeconds === null && lagBytes === 0)
        effectiveLagSeconds = 0

      const reasons: string[] = []
      if (!active)
        reasons.push('inactive')
      if (effectiveLagSeconds === null) {
        if (lagBytes === null) {
          reasons.push('lag_unknown')
        }
        else if (lagBytes > thresholdBytes) {
          reasons.push('lag_bytes_threshold_exceeded')
        }
      }
      else if (effectiveLagSeconds > thresholdSeconds) {
        reasons.push('lag_threshold_exceeded')
      }

      const status: SlotStatus = reasons.length > 0 ? 'ko' : 'ok'

      return {
        slot_name: row.slot_name,
        active,
        confirmed_flush_lsn: row.confirmed_flush_lsn ?? null,
        restart_lsn: row.restart_lsn ?? null,
        lag_bytes: lagBytes,
        slot_lag: row.slot_lag ?? null,
        lag_seconds: lagSeconds,
        lag_seconds_est: lagSecondsEst,
        effective_lag_seconds: effectiveLagSeconds,
        lag_minutes: effectiveLagSeconds !== null ? Number((effectiveLagSeconds / 60).toFixed(2)) : null,
        status,
        reasons,
      }
    })

    const activeCount = slots.filter(slot => slot.active).length
    const inactiveCount = slots.length - activeCount
    const maxLagSlot = slots.reduce<{ slot: string | null, lag: number | null }>((acc, slot) => {
      if (slot.effective_lag_seconds === null)
        return acc
      if (acc.lag === null || slot.effective_lag_seconds > acc.lag) {
        return { slot: slot.slot_name, lag: slot.effective_lag_seconds }
      }
      return acc
    }, { slot: null, lag: null })

    const overallStatus: SlotStatus = slots.length === 0 || slots.some(slot => slot.status === 'ko') ? 'ko' : 'ok'

    const response = {
      status: overallStatus,
      estimation_source: mode,
      threshold_seconds: thresholdSeconds,
      threshold_minutes: Number((thresholdSeconds / 60).toFixed(2)),
      threshold_bytes: thresholdBytes,
      checked_at: new Date().toISOString(),
      slot_count: slots.length,
      active_count: activeCount,
      inactive_count: inactiveCount,
      max_lag_seconds: maxLagSlot.lag,
      max_lag_minutes: maxLagSlot.lag !== null ? Number((maxLagSlot.lag / 60).toFixed(2)) : null,
      max_lag_slot: maxLagSlot.slot,
      slots,
    }

    return c.json(response, overallStatus === 'ok' ? 200 : 503)
  }
  catch (error) {
    logPgError(c, 'replication_lag', error)
    cloudlogErr({ requestId: c.get('requestId'), message: 'replication_lag_error', error })
    return c.json({
      status: 'ko',
      error: 'replication_lag_error',
      message: 'Failed to fetch replication lag',
      threshold_seconds: thresholdSeconds,
      threshold_minutes: Number((thresholdSeconds / 60).toFixed(2)),
      threshold_bytes: thresholdBytes,
      checked_at: new Date().toISOString(),
      slot_count: 0,
      active_count: 0,
      inactive_count: 0,
      max_lag_seconds: null,
      max_lag_minutes: null,
      max_lag_slot: null,
      slots: [],
    }, 500)
  }
  finally {
    await closeClient(c, pgClient)
  }
})
