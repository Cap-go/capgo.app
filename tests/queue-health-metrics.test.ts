import type { QueueHealthThresholds } from '../supabase/functions/_backend/public/queue_health.ts'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ARCHIVE_RECENT_WINDOW_SECONDS,
  ARCHIVE_STALE_SECONDS,
  DEFAULT_ARCHIVE_RECENT_THRESHOLD,
  DEFAULT_NEVER_READ_STALE_SECONDS,
  DEFAULT_QUEUE_DEPTH_THRESHOLD,
  fetchQueueMetrics,
  MIN_NEVER_READ_STALE_SECONDS,
  NEVER_READ_INTERVAL_MULTIPLIER,
  STUCK_READ_CT_THRESHOLD,
} from '../supabase/functions/_backend/public/queue_health.ts'
import { cleanupPostgresClient, executeSQL, getPostgresClient } from './test-utils.ts'

const thresholds: QueueHealthThresholds = {
  stuck_read_ct: STUCK_READ_CT_THRESHOLD,
  archive_stale_seconds: ARCHIVE_STALE_SECONDS,
  archive_recent_window_seconds: ARCHIVE_RECENT_WINDOW_SECONDS,
  archive_recent_threshold: DEFAULT_ARCHIVE_RECENT_THRESHOLD,
  queue_depth_threshold: DEFAULT_QUEUE_DEPTH_THRESHOLD,
  default_never_read_stale_seconds: DEFAULT_NEVER_READ_STALE_SECONDS,
  min_never_read_stale_seconds: MIN_NEVER_READ_STALE_SECONDS,
  never_read_interval_multiplier: NEVER_READ_INTERVAL_MULTIPLIER,
}

describe('fetchQueueMetrics never-read staleness', () => {
  const queueName = `qh_stale_${randomUUID().slice(0, 8)}`

  afterAll(async () => {
    await executeSQL(`SELECT pgmq.drop_queue($1)`, [queueName])
    await cleanupPostgresClient()
  })

  it('counts unread messages by how long they have been readable', async () => {
    await executeSQL(`SELECT pgmq.create($1)`, [queueName])
    await executeSQL(
      `INSERT INTO pgmq.q_${queueName} (read_ct, enqueued_at, vt, message) VALUES
        -- Unread and readable for 10 minutes: stale.
        (0, now() - interval '90 minutes', now() - interval '10 minutes', '{}'),
        -- Delayed send whose slot opened 30 seconds ago: not stale yet.
        (0, now() - interval '90 minutes', now() - interval '30 seconds', '{}'),
        -- Delayed send still waiting for its slot: not readable.
        (0, now() - interval '90 minutes', now() + interval '10 minutes', '{}'),
        -- Read once and not completed: a retry, not never-read.
        (1, now() - interval '90 minutes', now() - interval '10 minutes', '{}')`,
    )

    const client = await getPostgresClient()
    // 60s cron interval resolves to the 300s minimum stale threshold.
    const metrics = await fetchQueueMetrics(client as never, queueName, 60, thresholds)

    expect(metrics.never_read_stale_seconds).toBe(MIN_NEVER_READ_STALE_SECONDS)
    expect(metrics.queue_count).toBe(4)
    expect(metrics.never_read_count).toBe(3)
    expect(metrics.never_read_stale_count).toBe(1)
  })
})
