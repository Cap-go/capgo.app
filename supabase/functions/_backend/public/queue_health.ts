import { honoFactory, useCors } from '../utils/hono.ts'
import { cloudlogErr } from '../utils/logging.ts'
import { closeClient, getPgClient, logPgError } from '../utils/pg.ts'
import { validatePlatformAdminOrApiSecret } from '../utils/platform_admin_access.ts'

type QueueStatus = 'ok' | 'ko'
type SqlCountValue = string | number | null

export const STUCK_READ_CT_THRESHOLD = 5
// cleanup_queue_messages purges archives older than 2 days; allow 1 day of batch lag.
export const ARCHIVE_STALE_SECONDS = 3 * 24 * 60 * 60
export const ARCHIVE_RECENT_WINDOW_SECONDS = 60 * 60
export const DEFAULT_ARCHIVE_RECENT_THRESHOLD = 5_000
export const DEFAULT_QUEUE_DEPTH_THRESHOLD = 50_000
export const DEFAULT_NEVER_READ_STALE_SECONDS = 60 * 60
export const MIN_NEVER_READ_STALE_SECONDS = 5 * 60
export const NEVER_READ_INTERVAL_MULTIPLIER = 3

const SAFE_QUEUE_NAME = /^[a-z_]\w*$/i

export interface QueueHealthThresholds {
  stuck_read_ct: number
  archive_stale_seconds: number
  archive_recent_window_seconds: number
  archive_recent_threshold: number
  queue_depth_threshold: number
  default_never_read_stale_seconds: number
  min_never_read_stale_seconds: number
  never_read_interval_multiplier: number
}

export interface QueueMetrics {
  queue_name: string
  queue_table_exists: boolean
  archive_table_exists: boolean
  queue_count: number
  never_read_count: number
  never_read_stale_count: number
  stuck_count: number
  max_read_ct: number | null
  oldest_message_age_seconds: number | null
  archive_count: number
  archive_stale_count: number
  archive_recent_count: number
  oldest_archive_age_seconds: number | null
  expected_interval_seconds: number | null
  never_read_stale_seconds: number
}

export interface QueueHealthResult {
  queue_name: string
  status: QueueStatus
  reasons: string[]
  reason_details: Record<string, string>
  queue_table_exists: boolean
  archive_table_exists: boolean
  queue_count: number
  never_read_count: number
  never_read_stale_count: number
  stuck_count: number
  max_read_ct: number | null
  oldest_message_age_seconds: number | null
  archive_count: number
  archive_stale_count: number
  archive_recent_count: number
  oldest_archive_age_seconds: number | null
  expected_interval_seconds: number | null
  never_read_stale_seconds: number
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined)
    return null
  const num = Number(value)
  if (!Number.isFinite(num))
    return null
  return num
}

export function isSafeQueueName(queueName: string): boolean {
  return SAFE_QUEUE_NAME.test(queueName)
}

export function cronTaskIntervalSeconds(task: {
  second_interval?: number | null
  minute_interval?: number | null
  hour_interval?: number | null
  run_at_hour?: number | null
  run_on_dow?: number | null
  run_on_day?: number | null
}): number | null {
  if (task.second_interval != null && task.second_interval > 0)
    return task.second_interval
  if (task.minute_interval != null && task.minute_interval > 0)
    return task.minute_interval * 60
  if (task.hour_interval != null && task.hour_interval > 0)
    return task.hour_interval * 3600
  // Calendar schedules: prefer the coarsest cadence marker first.
  if (task.run_on_day != null)
    return 31 * 24 * 60 * 60
  if (task.run_on_dow != null)
    return 7 * 24 * 60 * 60
  if (task.run_at_hour != null)
    return 24 * 60 * 60
  return null
}

export function parseCronQueueTargets(target: unknown): string[] {
  if (typeof target === 'string') {
    const trimmed = target.trim()
    if (!trimmed)
      return []
    if (trimmed.startsWith('[')) {
      try {
        return parseCronQueueTargets(JSON.parse(trimmed))
      }
      catch {
        return isSafeQueueName(trimmed) ? [trimmed] : []
      }
    }
    return isSafeQueueName(trimmed) ? [trimmed] : []
  }

  if (Array.isArray(target)) {
    return target
      .filter((value): value is string => typeof value === 'string' && isSafeQueueName(value))
  }

  return []
}

export function buildQueueIntervalMap(
  schedules: Array<{
    task_type: string
    target: unknown
    second_interval?: number | null
    minute_interval?: number | null
    hour_interval?: number | null
    run_at_hour?: number | null
    run_on_dow?: number | null
    run_on_day?: number | null
  }>,
): Map<string, number> {
  const intervals = new Map<string, number>()

  for (const schedule of schedules) {
    if (schedule.task_type !== 'function_queue' && schedule.task_type !== 'queue')
      continue

    const interval = cronTaskIntervalSeconds(schedule)
    if (interval == null)
      continue

    for (const queueName of parseCronQueueTargets(schedule.target)) {
      const existing = intervals.get(queueName)
      if (existing == null || interval < existing)
        intervals.set(queueName, interval)
    }
  }

  return intervals
}

export function resolveNeverReadStaleSeconds(
  expectedIntervalSeconds: number | null,
  thresholds: Pick<QueueHealthThresholds, 'default_never_read_stale_seconds' | 'min_never_read_stale_seconds' | 'never_read_interval_multiplier'>,
): number {
  if (expectedIntervalSeconds == null || expectedIntervalSeconds <= 0)
    return thresholds.default_never_read_stale_seconds

  return Math.max(
    expectedIntervalSeconds * thresholds.never_read_interval_multiplier,
    thresholds.min_never_read_stale_seconds,
  )
}

export function evaluateQueueHealth(
  metrics: QueueMetrics,
  thresholds: QueueHealthThresholds,
): QueueHealthResult {
  const reasons: string[] = []
  const reason_details: Record<string, string> = {}

  if (!metrics.queue_table_exists) {
    reasons.push('missing_queue_table')
    reason_details.missing_queue_table = `Queue table pgmq.q_${metrics.queue_name} is missing while the queue is registered in pgmq.meta`
  }

  if (!metrics.archive_table_exists) {
    reasons.push('missing_archive_table')
    reason_details.missing_archive_table = `Archive table pgmq.a_${metrics.queue_name} is missing while the queue is registered in pgmq.meta`
  }

  if (metrics.queue_table_exists && metrics.never_read_stale_count > 0) {
    reasons.push('never_read_stale')
    reason_details.never_read_stale = `${metrics.never_read_stale_count} message(s) still have read_ct=0 after ${metrics.never_read_stale_seconds}s (oldest age ${metrics.oldest_message_age_seconds ?? 'unknown'}s). Consumers are not reading this queue in time.`
  }

  if (metrics.queue_table_exists && metrics.stuck_count > 0) {
    reasons.push('stuck_high_read_ct')
    reason_details.stuck_high_read_ct = `${metrics.stuck_count} message(s) have read_ct > ${thresholds.stuck_read_ct} (max ${metrics.max_read_ct ?? 'unknown'}). Messages are being retried without successful ack/delete.`
  }

  if (metrics.queue_table_exists && metrics.queue_count > thresholds.queue_depth_threshold) {
    reasons.push('queue_depth_exceeded')
    reason_details.queue_depth_exceeded = `Queue depth is ${metrics.queue_count}, above threshold ${thresholds.queue_depth_threshold}. Consumers cannot keep up.`
  }

  if (metrics.archive_table_exists && metrics.archive_stale_count > 0) {
    reasons.push('archive_stale')
    reason_details.archive_stale = `${metrics.archive_stale_count} archived message(s) are older than ${thresholds.archive_stale_seconds}s. cleanup_queue_messages is not keeping archives from ramping up.`
  }

  if (metrics.archive_table_exists && metrics.archive_recent_count > thresholds.archive_recent_threshold) {
    reasons.push('archive_ramping')
    reason_details.archive_ramping = `${metrics.archive_recent_count} message(s) were archived in the last ${thresholds.archive_recent_window_seconds}s, above threshold ${thresholds.archive_recent_threshold}. Archive growth indicates consumers are failing and dumping work into archive.`
  }

  return {
    queue_name: metrics.queue_name,
    status: reasons.length > 0 ? 'ko' : 'ok',
    reasons,
    reason_details,
    queue_table_exists: metrics.queue_table_exists,
    archive_table_exists: metrics.archive_table_exists,
    queue_count: metrics.queue_count,
    never_read_count: metrics.never_read_count,
    never_read_stale_count: metrics.never_read_stale_count,
    stuck_count: metrics.stuck_count,
    max_read_ct: metrics.max_read_ct,
    oldest_message_age_seconds: metrics.oldest_message_age_seconds,
    archive_count: metrics.archive_count,
    archive_stale_count: metrics.archive_stale_count,
    archive_recent_count: metrics.archive_recent_count,
    oldest_archive_age_seconds: metrics.oldest_archive_age_seconds,
    expected_interval_seconds: metrics.expected_interval_seconds,
    never_read_stale_seconds: metrics.never_read_stale_seconds,
  }
}

export function buildQueueHealthCriteria(thresholds: QueueHealthThresholds) {
  return {
    never_read_stale: {
      healthy_when: 'No queue messages remain with read_ct=0 longer than the queue stale threshold (derived from cron interval when known).',
      unhealthy_when: 'Messages sit unread long enough that consumers are likely stuck or not scheduled.',
      default_threshold_seconds: thresholds.default_never_read_stale_seconds,
      min_threshold_seconds: thresholds.min_never_read_stale_seconds,
      interval_multiplier: thresholds.never_read_interval_multiplier,
    },
    stuck_high_read_ct: {
      healthy_when: `No queue messages have read_ct > ${thresholds.stuck_read_ct}.`,
      unhealthy_when: 'Messages keep retrying past the stuck threshold without successful processing.',
      threshold: thresholds.stuck_read_ct,
    },
    queue_depth_exceeded: {
      healthy_when: `Queue depth stays at or below ${thresholds.queue_depth_threshold}.`,
      unhealthy_when: 'Backlog is too large for consumers to drain safely.',
      threshold: thresholds.queue_depth_threshold,
    },
    archive_stale: {
      healthy_when: `No archived rows older than ${thresholds.archive_stale_seconds}s (cleanup window).`,
      unhealthy_when: 'Old archive rows remain, so archive storage is ramping instead of being cleaned.',
      threshold_seconds: thresholds.archive_stale_seconds,
    },
    archive_ramping: {
      healthy_when: `Archived rows created in the last ${thresholds.archive_recent_window_seconds}s stay at or below ${thresholds.archive_recent_threshold}.`,
      unhealthy_when: 'Recent archive volume is abnormally high, usually from retry-budget exhaustion.',
      window_seconds: thresholds.archive_recent_window_seconds,
      threshold: thresholds.archive_recent_threshold,
    },
    missing_queue_table: {
      healthy_when: 'Every registered queue has pgmq.q_<name>.',
      unhealthy_when: 'pgmq.meta references a queue whose queue table is missing.',
    },
    missing_archive_table: {
      healthy_when: 'Every registered queue has pgmq.a_<name>.',
      unhealthy_when: 'pgmq.meta references a queue whose archive table is missing.',
    },
  }
}

function defaultThresholds(): QueueHealthThresholds {
  return {
    stuck_read_ct: STUCK_READ_CT_THRESHOLD,
    archive_stale_seconds: ARCHIVE_STALE_SECONDS,
    archive_recent_window_seconds: ARCHIVE_RECENT_WINDOW_SECONDS,
    archive_recent_threshold: DEFAULT_ARCHIVE_RECENT_THRESHOLD,
    queue_depth_threshold: DEFAULT_QUEUE_DEPTH_THRESHOLD,
    default_never_read_stale_seconds: DEFAULT_NEVER_READ_STALE_SECONDS,
    min_never_read_stale_seconds: MIN_NEVER_READ_STALE_SECONDS,
    never_read_interval_multiplier: NEVER_READ_INTERVAL_MULTIPLIER,
  }
}

async function listQueues(client: ReturnType<typeof getPgClient>): Promise<string[]> {
  const { rows } = await client.query<{ queue_name: string }>(
    'SELECT queue_name FROM pgmq.list_queues() ORDER BY queue_name',
  )
  return rows
    .map(row => row.queue_name)
    .filter((name): name is string => typeof name === 'string' && isSafeQueueName(name))
}

async function loadQueueIntervals(client: ReturnType<typeof getPgClient>): Promise<Map<string, number>> {
  const { rows } = await client.query<{
    task_type: string
    target: unknown
    second_interval: number | null
    minute_interval: number | null
    hour_interval: number | null
    run_at_hour: number | null
    run_on_dow: number | null
    run_on_day: number | null
  }>(`
    SELECT task_type::text AS task_type,
           target,
           second_interval,
           minute_interval,
           hour_interval,
           run_at_hour,
           run_on_dow,
           run_on_day
    FROM public.cron_tasks
    WHERE enabled = true
      AND task_type IN ('function_queue', 'queue')
  `)

  return buildQueueIntervalMap(rows)
}

async function fetchQueueMetrics(
  client: ReturnType<typeof getPgClient>,
  queueName: string,
  expectedIntervalSeconds: number | null,
  thresholds: QueueHealthThresholds,
): Promise<QueueMetrics> {
  if (!isSafeQueueName(queueName))
    throw new Error(`Invalid queue name: ${queueName}`)

  const neverReadStaleSeconds = resolveNeverReadStaleSeconds(expectedIntervalSeconds, thresholds)

  const { rows: existenceRows } = await client.query<{
    queue_table_exists: boolean
    archive_table_exists: boolean
  }>(
    `
    SELECT
      to_regclass($1) IS NOT NULL AS queue_table_exists,
      to_regclass($2) IS NOT NULL AS archive_table_exists
    `,
    [`pgmq.q_${queueName}`, `pgmq.a_${queueName}`],
  )

  const queueExists = Boolean(existenceRows[0]?.queue_table_exists)
  const archiveExists = Boolean(existenceRows[0]?.archive_table_exists)

  let queue_count = 0
  let never_read_count = 0
  let never_read_stale_count = 0
  let stuck_count = 0
  let max_read_ct: number | null = null
  let oldest_message_age_seconds: number | null = null

  if (queueExists) {
    const { rows } = await client.query<{
      queue_count: SqlCountValue
      never_read_count: SqlCountValue
      never_read_stale_count: SqlCountValue
      stuck_count: SqlCountValue
      max_read_ct: SqlCountValue
      oldest_message_age_seconds: SqlCountValue
    }>(
      `
      SELECT
        COUNT(*)::bigint AS queue_count,
        COUNT(*) FILTER (WHERE read_ct = 0)::bigint AS never_read_count,
        COUNT(*) FILTER (
          WHERE read_ct = 0
            AND enqueued_at < now() - ($1::text || ' seconds')::interval
        )::bigint AS never_read_stale_count,
        COUNT(*) FILTER (WHERE read_ct > $2)::bigint AS stuck_count,
        MAX(read_ct)::bigint AS max_read_ct,
        EXTRACT(EPOCH FROM (now() - MIN(enqueued_at)))::numeric AS oldest_message_age_seconds
      FROM pgmq.q_${queueName}
      `,
      [String(neverReadStaleSeconds), thresholds.stuck_read_ct],
    )

    queue_count = toNumber(rows[0]?.queue_count) ?? 0
    never_read_count = toNumber(rows[0]?.never_read_count) ?? 0
    never_read_stale_count = toNumber(rows[0]?.never_read_stale_count) ?? 0
    stuck_count = toNumber(rows[0]?.stuck_count) ?? 0
    max_read_ct = toNumber(rows[0]?.max_read_ct ?? null)
    oldest_message_age_seconds = toNumber(rows[0]?.oldest_message_age_seconds ?? null)
  }

  let archive_count = 0
  let archive_stale_count = 0
  let archive_recent_count = 0
  let oldest_archive_age_seconds: number | null = null

  if (archiveExists) {
    const { rows } = await client.query<{
      archive_count: SqlCountValue
      archive_stale_count: SqlCountValue
      archive_recent_count: SqlCountValue
      oldest_archive_age_seconds: SqlCountValue
    }>(
      `
      SELECT
        COUNT(*)::bigint AS archive_count,
        COUNT(*) FILTER (
          WHERE archived_at < now() - ($1::text || ' seconds')::interval
        )::bigint AS archive_stale_count,
        COUNT(*) FILTER (
          WHERE archived_at >= now() - ($2::text || ' seconds')::interval
        )::bigint AS archive_recent_count,
        EXTRACT(EPOCH FROM (now() - MIN(archived_at)))::numeric AS oldest_archive_age_seconds
      FROM pgmq.a_${queueName}
      `,
      [String(thresholds.archive_stale_seconds), String(thresholds.archive_recent_window_seconds)],
    )

    archive_count = toNumber(rows[0]?.archive_count) ?? 0
    archive_stale_count = toNumber(rows[0]?.archive_stale_count) ?? 0
    archive_recent_count = toNumber(rows[0]?.archive_recent_count) ?? 0
    oldest_archive_age_seconds = toNumber(rows[0]?.oldest_archive_age_seconds ?? null)
  }

  return {
    queue_name: queueName,
    queue_table_exists: queueExists,
    archive_table_exists: archiveExists,
    queue_count,
    never_read_count,
    never_read_stale_count,
    stuck_count,
    max_read_ct,
    oldest_message_age_seconds,
    archive_count,
    archive_stale_count,
    archive_recent_count,
    oldest_archive_age_seconds,
    expected_interval_seconds: expectedIntervalSeconds,
    never_read_stale_seconds: neverReadStaleSeconds,
  }
}

export const app = honoFactory.createApp()

app.use('*', useCors)

app.get('/', async (c) => {
  await validatePlatformAdminOrApiSecret(c, {
    logPrefix: 'queue_health',
    forbiddenMessage: 'Not admin - only admin users can access queue health',
  })

  const thresholds = defaultThresholds()
  const pgClient = getPgClient(c, false)

  try {
    const queueNames = await listQueues(pgClient)
    const intervalMap = await loadQueueIntervals(pgClient)

    const metricsList = await Promise.all(
      queueNames.map(queueName => fetchQueueMetrics(
        pgClient,
        queueName,
        intervalMap.get(queueName) ?? null,
        thresholds,
      )),
    )

    const queues = metricsList.map(metrics => evaluateQueueHealth(metrics, thresholds))
    const unhealthy = queues.filter(queue => queue.status === 'ko')
    // Empty registry is not a processing failure (fresh installs / no pgmq queues yet).
    const overallStatus: QueueStatus = unhealthy.length > 0 ? 'ko' : 'ok'

    const maxQueueDepth = queues.reduce((max, queue) => Math.max(max, queue.queue_count), 0)
    const maxArchiveRecent = queues.reduce((max, queue) => Math.max(max, queue.archive_recent_count), 0)
    const totalStuck = queues.reduce((sum, queue) => sum + queue.stuck_count, 0)
    const totalNeverReadStale = queues.reduce((sum, queue) => sum + queue.never_read_stale_count, 0)
    const totalArchiveStale = queues.reduce((sum, queue) => sum + queue.archive_stale_count, 0)

    return c.json({
      status: overallStatus,
      checked_at: new Date().toISOString(),
      no_queues_registered: queues.length === 0,
      queue_count: queues.length,
      healthy_count: queues.length - unhealthy.length,
      unhealthy_count: unhealthy.length,
      max_queue_depth: maxQueueDepth,
      max_archive_recent_count: maxArchiveRecent,
      total_stuck_count: totalStuck,
      total_never_read_stale_count: totalNeverReadStale,
      total_archive_stale_count: totalArchiveStale,
      thresholds,
      criteria: buildQueueHealthCriteria(thresholds),
      unhealthy_queues: unhealthy.map(queue => ({
        queue_name: queue.queue_name,
        status: queue.status,
        reasons: queue.reasons,
        reason_details: queue.reason_details,
      })),
      queues,
    }, overallStatus === 'ok' ? 200 : 503)
  }
  catch (error) {
    logPgError(c, 'queue_health', error)
    cloudlogErr({ requestId: c.get('requestId'), message: 'queue_health_error', error })
    return c.json({
      status: 'ko',
      error: 'queue_health_error',
      message: 'Failed to check queue health',
      checked_at: new Date().toISOString(),
      no_queues_registered: null,
      queue_count: 0,
      healthy_count: 0,
      unhealthy_count: 0,
      max_queue_depth: 0,
      max_archive_recent_count: 0,
      total_stuck_count: 0,
      total_never_read_stale_count: 0,
      total_archive_stale_count: 0,
      thresholds,
      criteria: buildQueueHealthCriteria(thresholds),
      unhealthy_queues: [],
      queues: [],
    }, 500)
  }
  finally {
    await closeClient(c, pgClient)
  }
})
