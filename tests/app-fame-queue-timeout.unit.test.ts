import { describe, expect, it } from 'vitest'
import { __queueConsumerTestUtils__ } from '../supabase/functions/_backend/triggers/queue_consumer.ts'

describe('app fame queue contract', () => {
  it('waits long enough for Workers AI scoring instead of aborting at the default timeout', () => {
    const u = __queueConsumerTestUtils__
    // One json_schema scoring call for a 12-app batch measured ~18-20s in production.
    expect(u.getQueueHttpTimeoutMs('cron_app_fame')).toBeGreaterThanOrEqual(60_000)
    // waitUntil work is cut ~30s after the response, so the sync must be awaited.
    expect(u.shouldRunQueueSyncInBackground('cron_app_fame')).toBe(false)
    // The message must stay invisible while its request is still in flight.
    expect(u.getQueueVisibilityTimeout('cron_app_fame') * 1000).toBeGreaterThan(u.getQueueHttpTimeoutMs('cron_app_fame'))
  })
})
