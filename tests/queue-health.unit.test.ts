import type { QueueHealthThresholds, QueueMetrics } from '../supabase/functions/_backend/public/queue_health.ts'
import { describe, expect, it } from 'vitest'
import {
  ARCHIVE_RECENT_WINDOW_SECONDS,
  ARCHIVE_STALE_SECONDS,
  buildQueueHealthCriteria,
  buildQueueIntervalMap,
  cronTaskIntervalSeconds,
  DEFAULT_ARCHIVE_RECENT_THRESHOLD,
  DEFAULT_NEVER_READ_STALE_SECONDS,
  DEFAULT_QUEUE_DEPTH_THRESHOLD,
  evaluateQueueHealth,
  isSafeQueueName,
  MIN_NEVER_READ_STALE_SECONDS,
  NEVER_READ_INTERVAL_MULTIPLIER,
  parseCronQueueTargets,
  resolveNeverReadStaleSeconds,
  STUCK_READ_CT_THRESHOLD,
} from '../supabase/functions/_backend/public/queue_health.ts'

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

function createMetrics(overrides: Partial<QueueMetrics> = {}): QueueMetrics {
  return {
    queue_name: 'on_version_update',
    queue_table_exists: true,
    archive_table_exists: true,
    queue_count: 0,
    never_read_count: 0,
    never_read_stale_count: 0,
    stuck_count: 0,
    max_read_ct: null,
    oldest_message_age_seconds: null,
    archive_count: 0,
    archive_stale_count: 0,
    archive_recent_count: 0,
    oldest_archive_age_seconds: null,
    expected_interval_seconds: 10,
    never_read_stale_seconds: 300,
    ...overrides,
  }
}

describe('queue_health helpers', () => {
  it.concurrent('accepts only safe pgmq queue names', () => {
    expect(isSafeQueueName('on_version_update')).toBe(true)
    expect(isSafeQueueName('q;drop table')).toBe(false)
    expect(isSafeQueueName('a-b')).toBe(false)
  })

  it.concurrent('parses cron queue targets from arrays and json strings', () => {
    expect(parseCronQueueTargets(['webhook_delivery', 'bad-name', 1])).toEqual(['webhook_delivery'])
    expect(parseCronQueueTargets('["on_app_create","on_app_delete"]')).toEqual(['on_app_create', 'on_app_delete'])
    expect(parseCronQueueTargets('cron_email')).toEqual(['cron_email'])
  })

  it.concurrent('derives cron intervals and picks the fastest schedule per queue', () => {
    expect(cronTaskIntervalSeconds({ second_interval: 10 })).toBe(10)
    expect(cronTaskIntervalSeconds({ minute_interval: 5 })).toBe(300)
    expect(cronTaskIntervalSeconds({ hour_interval: 2 })).toBe(7200)
    expect(cronTaskIntervalSeconds({ run_at_hour: 3 })).toBe(86400)
    expect(cronTaskIntervalSeconds({ run_at_hour: 12, run_on_dow: 6 })).toBe(7 * 24 * 60 * 60)
    expect(cronTaskIntervalSeconds({ run_at_hour: 12, run_on_day: 1 })).toBe(31 * 24 * 60 * 60)

    const intervals = buildQueueIntervalMap([
      {
        task_type: 'function_queue',
        target: '["on_version_update"]',
        second_interval: 10,
      },
      {
        task_type: 'function_queue',
        target: ['on_version_update', 'admin_stats'],
        hour_interval: 2,
      },
      {
        task_type: 'function',
        target: '["ignored"]',
        second_interval: 10,
      },
    ])

    expect(intervals.get('on_version_update')).toBe(10)
    expect(intervals.get('admin_stats')).toBe(7200)
    expect(intervals.has('ignored')).toBe(false)
  })

  it.concurrent('resolves never-read stale threshold from cron interval with a floor', () => {
    expect(resolveNeverReadStaleSeconds(null, thresholds)).toBe(DEFAULT_NEVER_READ_STALE_SECONDS)
    expect(resolveNeverReadStaleSeconds(10, thresholds)).toBe(MIN_NEVER_READ_STALE_SECONDS)
    expect(resolveNeverReadStaleSeconds(7200, thresholds)).toBe(21600)
  })
})

describe('evaluateQueueHealth', () => {
  it.concurrent('marks a clean queue healthy', () => {
    const result = evaluateQueueHealth(createMetrics(), thresholds)
    expect(result.status).toBe('ok')
    expect(result.reasons).toEqual([])
  })

  it.concurrent('fails when unread messages sit too long', () => {
    const result = evaluateQueueHealth(createMetrics({
      never_read_stale_count: 3,
      never_read_count: 3,
      oldest_message_age_seconds: 900,
    }), thresholds)

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('never_read_stale')
    expect(result.reason_details.never_read_stale).toContain('read_ct=0')
  })

  it.concurrent('fails when messages are stuck with high read_ct', () => {
    const result = evaluateQueueHealth(createMetrics({
      stuck_count: 2,
      max_read_ct: 12,
    }), thresholds)

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('stuck_high_read_ct')
    expect(result.reason_details.stuck_high_read_ct).toContain('read_ct > 5')
  })

  it.concurrent('fails when archive cleanup is lagging or archive is ramping', () => {
    const stale = evaluateQueueHealth(createMetrics({
      archive_stale_count: 10,
      archive_count: 10,
    }), thresholds)
    expect(stale.reasons).toContain('archive_stale')

    const ramp = evaluateQueueHealth(createMetrics({
      archive_recent_count: DEFAULT_ARCHIVE_RECENT_THRESHOLD + 1,
    }), thresholds)
    expect(ramp.reasons).toContain('archive_ramping')
    expect(ramp.reason_details.archive_ramping).toContain('archived in the last')
  })

  it.concurrent('fails when queue or archive tables are missing', () => {
    const result = evaluateQueueHealth(createMetrics({
      queue_table_exists: false,
      archive_table_exists: false,
    }), thresholds)

    expect(result.status).toBe('ko')
    expect(result.reasons).toEqual(expect.arrayContaining([
      'missing_queue_table',
      'missing_archive_table',
    ]))
  })

  it.concurrent('fails when queue depth exceeds the threshold', () => {
    const result = evaluateQueueHealth(createMetrics({
      queue_count: DEFAULT_QUEUE_DEPTH_THRESHOLD + 1,
    }), thresholds)

    expect(result.status).toBe('ko')
    expect(result.reasons).toContain('queue_depth_exceeded')
    expect(result.reason_details.queue_depth_exceeded).toContain(String(DEFAULT_QUEUE_DEPTH_THRESHOLD))
  })

  it.concurrent('documents healthy and unhealthy criteria', () => {
    const criteria = buildQueueHealthCriteria(thresholds)
    expect(criteria.never_read_stale.healthy_when).toContain('vt <= now()')
    expect(criteria.never_read_stale.healthy_when).toContain('read_ct=0')
    expect(criteria.archive_stale.unhealthy_when).toContain('ramping')
    expect(criteria.stuck_high_read_ct.threshold).toBe(STUCK_READ_CT_THRESHOLD)
    expect(criteria.stuck_high_read_ct.healthy_when).toContain('hard max retries = 5')
  })
})
