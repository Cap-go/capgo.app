import { describe, expect, it } from 'vitest'
import { __queueConsumerTestUtils__, MAX_QUEUE_READS } from '../supabase/functions/_backend/triggers/queue_consumer.ts'
import { onboardingRefreshBody } from '../supabase/functions/_backend/utils/app_onboarding_refresh.ts'

describe('onboarding refresh queue contract', () => {
  it('accepts at most 25 app IDs with the enqueue timestamp', () => {
    const queuedAt = '2026-09-19T12:00:00.000Z'
    const appIds = Array.from({ length: 25 }, (_, i) => `com.example.${i}`)
    expect(onboardingRefreshBody.safeParse({ appIds, queuedAt }).success).toBe(true)
    expect(onboardingRefreshBody.safeParse({ appIds: [...appIds, 'com.example.25'], queuedAt }).success).toBe(false)
    expect(onboardingRefreshBody.safeParse({ appIds, batchToken: 'unused' }).success).toBe(false)
  })

  it('dispatches at most 100 apps per minute and awaits acknowledgments', () => {
    const u = __queueConsumerTestUtils__
    expect(u.getQueueBatchSize('cron_onboarding_refresh_apps', 950)).toBe(4)
    expect(u.getQueueHttpConcurrency('cron_onboarding_refresh_apps')).toBe(4)
    expect(u.getQueueHttpTimeoutMs('cron_onboarding_refresh_apps')).toBe(45_000)
    expect(u.getQueueVisibilityTimeout('cron_onboarding_refresh_apps')).toBe(120)
    expect(u.shouldRunQueueSyncInBackground('cron_onboarding_refresh_apps')).toBe(false)
    expect(u.getQueueMaxReads('cron_onboarding_refresh_apps')).toBe(MAX_QUEUE_READS)
    expect(MAX_QUEUE_READS).toBe(5)
  })
})
