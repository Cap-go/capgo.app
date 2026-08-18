import type { Context } from 'hono'
import { readFileSync } from 'node:fs'
import { Hono } from 'hono/tiny'
import { describe, expect, it, vi } from 'vitest'
import { globalStatsTestUtils } from '../supabase/functions/_backend/triggers/global_stats.ts'
import { sendEventToTracking } from '../supabase/functions/_backend/utils/tracking.ts'

function withTestEnv(values: Record<string, string>) {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }
  }
}

describe('global stats metric helpers', () => {
  it.concurrent('keeps revenue-active snapshots limited to succeeded subscriptions', () => {
    expect(globalStatsTestUtils.REVENUE_ACTIVE_STRIPE_STATUSES).toEqual(['succeeded'])
  })

  it.concurrent('counts paid customers from paid_at rows and legacy fallback rows', () => {
    expect(globalStatsTestUtils.countUniqueCustomers(
      [
        { customer_id: 'cus_paid_1' },
        { customer_id: 'cus_paid_2' },
      ],
      [
        { customer_id: 'cus_legacy_1' },
      ],
    )).toBe(3)
  })

  it.concurrent('deduplicates customer ids across the paid_at query and legacy fallback query', () => {
    expect(globalStatsTestUtils.countUniqueCustomers(
      [
        { customer_id: 'cus_shared' },
      ],
      [
        { customer_id: 'cus_shared' },
      ],
    )).toBe(1)
  })

  it.concurrent('clamps trailing 12-month start for leap-day ends', () => {
    const start = globalStatsTestUtils.getTrailing12mStart(new Date('2024-02-29T00:00:00.000Z'))
    expect(start.toISOString()).toBe('2023-02-28T00:00:00.000Z')
  })

  it.concurrent('computes upgrade_rate_12m from upgrade events over paying orgs only', () => {
    // Daily shard: prior upgraded_orgs sum + today / paying (not users/orgs).
    const priorUpgradedOrgs12m = 101
    const todayUpgradedOrgs = 0
    const paying = 1161
    const allOrgs = 7749

    expect(globalStatsTestUtils.calculateConversionRate(
      priorUpgradedOrgs12m + todayUpgradedOrgs,
      paying,
    )).toBe(8.7)
    expect(globalStatsTestUtils.calculateConversionRate(
      priorUpgradedOrgs12m + todayUpgradedOrgs,
      allOrgs,
    )).toBe(1.3)
  })

  it.concurrent('computes plan conversion rates against paying orgs, not all users/orgs', () => {
    const rates = globalStatsTestUtils.getPlanConversionRates(
      { Solo: 15, Maker: 10, Team: 0, Enterprise: 0, Trial: 50 },
      25,
    )
    expect(rates).toEqual({
      solo: 60,
      maker: 40,
      team: 0,
      enterprise: 0,
      total: 100,
    })
    expect(globalStatsTestUtils.calculateConversionRate(15, 200)).toBe(7.5)
  })

  it.concurrent('builds UTC calendar-day bounds', () => {
    const { dayStart, nextDayStart, dayDateId } = globalStatsTestUtils.getCurrentDayWindow(new Date('2026-03-24T18:45:12.000Z'))

    expect(dayStart.toISOString()).toBe('2026-03-24T00:00:00.000Z')
    expect(nextDayStart.toISOString()).toBe('2026-03-25T00:00:00.000Z')
    expect(dayDateId).toBe('2026-03-24')
  })

  it.concurrent('builds the previous completed UTC day window for scheduled snapshots', () => {
    const { dayStart, nextDayStart, dayDateId } = globalStatsTestUtils.getCompletedDayWindow(new Date('2026-03-25T01:01:00.000Z'))

    expect(dayStart.toISOString()).toBe('2026-03-24T00:00:00.000Z')
    expect(nextDayStart.toISOString()).toBe('2026-03-25T00:00:00.000Z')
    expect(dayDateId).toBe('2026-03-24')
  })

  it.concurrent('derives replay metric bounds from a preserved snapshot date', () => {
    const replayWindow = globalStatsTestUtils.getCompletedDayWindowForDateId('2026-03-24')
    const { dayStart, nextDayStart, dayDateId } = globalStatsTestUtils.getMetricWindowFromDailyWindow(replayWindow)

    expect(dayStart.toISOString()).toBe('2026-03-24T00:00:00.000Z')
    expect(nextDayStart.toISOString()).toBe('2026-03-25T00:00:00.000Z')
    expect(dayDateId).toBe('2026-03-24')
  })

  it.concurrent('delays app build onboarding metrics until the full 24h cohort can complete', () => {
    const coreWindow = globalStatsTestUtils.getCompletedDayWindowForDateId('2026-03-24')
    const finalizedWindow = globalStatsTestUtils.getCompletedAppBuildOnboardingWindow(coreWindow)

    expect(finalizedWindow.prevDayStart.toISOString()).toBe('2026-03-23T00:00:00.000Z')
    expect(finalizedWindow.prevDayEnd.toISOString()).toBe('2026-03-24T00:00:00.000Z')
    expect(finalizedWindow.prevDayDateId).toBe('2026-03-23')
  })

  it.concurrent('summarizes app build onboarding daily cohorts', () => {
    expect(globalStatsTestUtils.summarizeAppBuildOnboardingRows([
      {
        created_at: '2026-03-24T10:00:00.000Z',
        created_from_onboarding: true,
        onboarding_completed_at: '2026-03-25T09:59:59.999Z',
        build_count: 3,
      },
      {
        created_at: '2026-03-24T10:00:00.000Z',
        created_from_onboarding: true,
        onboarding_completed_at: '2026-03-25T10:00:00.000Z',
        build_count: 4,
      },
      {
        created_at: '2026-03-24T10:00:00.000Z',
        created_from_onboarding: true,
        onboarding_completed_at: '2026-03-24T11:00:00.000Z',
        build_count: 2,
      },
      {
        created_at: '2026-03-24T10:00:00.000Z',
        created_from_onboarding: false,
        onboarding_completed_at: null,
        build_count: '3',
      },
    ])).toEqual({
      apps_created: 4,
      apps_with_cli_onboarding_builds_24h: 1,
      apps_with_manual_builds_24h: 1,
    })
  })

  it.concurrent('builds a bounded recent repair window for missing global stats days', () => {
    expect(globalStatsTestUtils.buildRecentGlobalStatsRepairDateIds('2026-06-29', 2)).toEqual([
      '2026-06-27',
      '2026-06-28',
      '2026-06-29',
    ])
    expect(globalStatsTestUtils.buildRecentGlobalStatsRepairDateIds('2026-03-01', 2)).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
    ])
  })

  it.concurrent('keeps total bundle storage on version metadata instead of manifest rows', () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260708000000_prod_baseline.sql', import.meta.url), 'utf8')
    const definition = migration.match(/CREATE OR REPLACE FUNCTION "public"\."total_bundle_storage_bytes"\(\) RETURNS bigint[\s\S]*?\$\$;/)?.[0]
    const grant = migration.match(/GRANT (?:ALL|EXECUTE) ON FUNCTION "public"\."total_bundle_storage_bytes"\(\) TO "service_role";/)?.[0]

    expect(definition).toBeDefined()
    expect(grant).toBeDefined()
    expect(definition!).toContain('public.app_versions_meta')
    expect(definition!).toContain('public.app_versions')
    expect(definition!).not.toContain('public.manifest')
    expect(definition!).not.toContain('file_size')
  })

  it.concurrent('registers the native notification shard on both trigger runtimes', () => {
    const cloudflareRouter = readFileSync(new URL('../cloudflare_workers/api/index.ts', import.meta.url), 'utf8')
    const supabaseRouter = readFileSync(new URL('../supabase/functions/triggers/index.ts', import.meta.url), 'utf8')
    const route = "route('/global_stats_native_notifications', globalStatsShardApps.native_notifications)"

    expect(cloudflareRouter).toContain(route)
    expect(supabaseRouter).toContain(route)
  })

  it.concurrent('detects missing global stats shards before notifications', () => {
    expect(globalStatsTestUtils.getMissingGlobalStatsRequiredShards(new Set())).toEqual([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])

    const completed = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
      'notifications',
      'bad',
    ])

    expect(globalStatsTestUtils.getMissingGlobalStatsRequiredShards(completed)).toEqual(['revenue'])
    expect(globalStatsTestUtils.getGlobalStatsShardQueueCandidates(completed)).toEqual(['revenue'])

    const ready = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    expect(globalStatsTestUtils.getMissingGlobalStatsRequiredShards(ready)).toEqual([])
    expect(globalStatsTestUtils.getMissingGlobalStatsShards(ready)).toEqual(['notifications', 'native_notifications'])
    expect(globalStatsTestUtils.getGlobalStatsShardQueueCandidates(ready)).toEqual(['notifications', 'native_notifications'])

    const legacyUsage = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      'usage',
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    expect(globalStatsTestUtils.getMissingGlobalStatsRequiredShards(legacyUsage)).toEqual([
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
    ])

    const sent = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      ...ready,
      'notifications',
      'native_notifications',
    ])
    expect(globalStatsTestUtils.getMissingGlobalStatsShards(sent)).toEqual([])
  })

  it.concurrent('requeues stale completed global stats shards before notifications', () => {
    const ready = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    const staleRow = {
      dateId: '2026-06-17',
      completedShards: ready,
      orgs: 0,
      bundleStorageGb: 0,
      buildTotalSecondsDayIos: 1908,
      buildTotalSecondsDayAndroid: 0,
      buildAvgSecondsDayIos: 59.6,
      buildAvgSecondsDayAndroid: 0,
      buildCountDayIos: 32,
      buildCountDayAndroid: 0,
    }
    const expectedBuildStats = {
      totalSeconds: { ios: 3816, android: 0 },
      avgSeconds: { ios: 119.3, android: 0 },
      counts: { ios: 32, android: 0 },
    }

    const staleShards = globalStatsTestUtils.getGlobalStatsStaleRepairShards(staleRow, expectedBuildStats)

    expect(staleShards).toEqual(['core', 'usage_storage', 'builds'])
    expect(globalStatsTestUtils.getGlobalStatsRepairShardQueueCandidates(ready, staleShards)).toEqual(['core', 'usage_storage', 'builds'])
    expect(globalStatsTestUtils.getGlobalStatsRepairShardQueueCandidates(ready)).toEqual(['notifications', 'native_notifications'])
  })

  it.concurrent('keeps fresh completed global stats shards eligible for notifications', () => {
    const ready = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    const freshRow = {
      dateId: '2026-06-17',
      completedShards: ready,
      orgs: 6639,
      bundleStorageGb: 489.89,
      buildTotalSecondsDayIos: 3816,
      buildTotalSecondsDayAndroid: 0,
      buildAvgSecondsDayIos: 119.3,
      buildAvgSecondsDayAndroid: 0,
      buildCountDayIos: 32,
      buildCountDayAndroid: 0,
    }
    const expectedBuildStats = {
      totalSeconds: { ios: 3816, android: 0 },
      avgSeconds: { ios: 119.3, android: 0 },
      counts: { ios: 32, android: 0 },
    }

    const staleShards = globalStatsTestUtils.getGlobalStatsStaleRepairShards(freshRow, expectedBuildStats)

    expect(staleShards).toEqual([])
    expect(globalStatsTestUtils.getGlobalStatsRepairShardQueueCandidates(ready, staleShards)).toEqual(['notifications', 'native_notifications'])
  })

  it.concurrent('detects completed global stats notifications for idempotent retries', () => {
    const ready = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    expect(globalStatsTestUtils.hasCompletedGlobalStatsNotifications(ready)).toBe(false)

    const sent = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      ...ready,
      'notifications',
    ])
    expect(globalStatsTestUtils.hasCompletedGlobalStatsNotifications(sent)).toBe(true)

    const partiallySent = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      ...ready,
      'notifications_tracking',
    ])
    expect(globalStatsTestUtils.hasCompletedGlobalStatsNotifications(partiallySent)).toBe(false)
    expect(globalStatsTestUtils.getMissingGlobalStatsShards(partiallySent)).toEqual(['notifications', 'native_notifications'])
  })

  it.concurrent('skips completed non-notification shard retries only', () => {
    const completed = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      'notifications',
    ])

    expect(globalStatsTestUtils.shouldSkipCompletedGlobalStatsShardRetry(completed, 'core')).toBe(true)
    expect(globalStatsTestUtils.shouldSkipCompletedGlobalStatsShardRetry(completed, 'usage_updates')).toBe(false)
    expect(globalStatsTestUtils.shouldSkipCompletedGlobalStatsShardRetry(completed, 'notifications')).toBe(false)
  })

  it.concurrent('derives only missing global stats shards for partial dispatcher retries', () => {
    const partial = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
    ])

    expect(globalStatsTestUtils.getMissingGlobalStatsRequiredShards(partial)).toEqual([
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])
    expect(globalStatsTestUtils.getMissingGlobalStatsShards(partial)).toEqual([
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
      'notifications',
      'native_notifications',
    ])
  })

  it.concurrent('uses notification claim markers to avoid replaying claimed sends', () => {
    const ready = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      'core',
      ...globalStatsTestUtils.USAGE_GLOBAL_STATS_SHARDS,
      'revenue',
      'plugins',
      'builds',
      'retention',
      'paid_products',
      'ltv',
    ])

    expect(globalStatsTestUtils.getGlobalStatsNotificationStepAction(ready, 'notifications_tracking', 'notifications_tracking_claim')).toBe('send')

    const claimed = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      ...ready,
      'notifications_tracking_claim',
    ])
    expect(globalStatsTestUtils.getGlobalStatsNotificationStepAction(claimed, 'notifications_tracking', 'notifications_tracking_claim')).toBe('complete_claimed')

    const sent = globalStatsTestUtils.normalizeCompletedGlobalStatsShards([
      ...claimed,
      'notifications_tracking',
    ])
    expect(globalStatsTestUtils.getGlobalStatsNotificationStepAction(sent, 'notifications_tracking', 'notifications_tracking_claim')).toBe('skip')
  })

  it.concurrent('keeps the legacy notification lock namespace during rolling deployments', () => {
    expect(globalStatsTestUtils.GLOBAL_STATS_NOTIFICATION_LOCK_NAMESPACE).toBe('logsnag_insights_notifications')
  })

  it.concurrent('computes NRR from prior MRR, churn, contraction, and expansion', () => {
    expect(globalStatsTestUtils.calculateNrr(100, {
      churnMrr: 15,
      contractionMrr: 5,
      expansionMrr: 10,
    })).toBe(90)
  })

  it.concurrent('defaults NRR to 100 when there is no starting MRR baseline', () => {
    expect(globalStatsTestUtils.calculateNrr(0, {
      churnMrr: 12,
      contractionMrr: 4,
      expansionMrr: 0,
    })).toBe(100)
  })

  it.concurrent('sums full churn and downgrade revenue into the churn revenue metric', () => {
    expect(globalStatsTestUtils.calculateChurnRevenue({
      churnMrr: 18.25,
      contractionMrr: 7.75,
      expansionMrr: 0,
    })).toBe(26)
  })

  it.concurrent('calculates current past-due org count and average days', () => {
    expect(globalStatsTestUtils.calculatePastDueOrgStats([
      {
        customer_id: 'cus_due_1',
        past_due_at: '2026-03-20T00:00:00.000Z',
        updated_at: '2026-03-21T00:00:00.000Z',
      },
      {
        customer_id: 'cus_due_2',
        past_due_at: '2026-03-22T12:00:00.000Z',
        updated_at: '2026-03-22T12:00:00.000Z',
      },
      {
        customer_id: 'cus_due_2',
        past_due_at: '2026-03-22T12:00:00.000Z',
        updated_at: '2026-03-22T12:00:00.000Z',
      },
    ], new Date('2026-03-25T00:00:00.000Z'))).toEqual({
      past_due_orgs: 2,
      past_due_orgs_average_days: 3.8,
    })
  })

  it.concurrent('ignores future past-due rows and uses the earliest start per customer', () => {
    expect(globalStatsTestUtils.calculatePastDueOrgStats([
      {
        customer_id: 'cus_due_1',
        past_due_at: '2026-03-24T00:00:00.000Z',
        updated_at: '2026-03-24T00:00:00.000Z',
      },
      {
        customer_id: 'cus_due_1',
        past_due_at: '2026-03-22T00:00:00.000Z',
        updated_at: '2026-03-22T00:00:00.000Z',
      },
      {
        customer_id: 'cus_due_future',
        past_due_at: '2026-03-25T12:00:00.000Z',
        updated_at: '2026-03-25T12:00:00.000Z',
      },
    ], new Date('2026-03-25T00:00:00.000Z'))).toEqual({
      past_due_orgs: 1,
      past_due_orgs_average_days: 3,
    })
  })

  it.concurrent('falls back to updated_at for past-due duration during rollout', () => {
    expect(globalStatsTestUtils.calculatePastDueOrgStats([
      {
        customer_id: 'cus_due_rollout',
        past_due_at: null,
        updated_at: '2026-03-24T00:00:00.000Z',
      },
    ], new Date('2026-03-25T00:00:00.000Z'))).toEqual({
      past_due_orgs: 1,
      past_due_orgs_average_days: 1,
    })
  })

  it.concurrent('counts active canceled and active past due orgs at a snapshot boundary', () => {
    const snapshotEnd = new Date('2026-03-25T00:00:00.000Z')

    expect(globalStatsTestUtils.calculateSubscriptionAccessSnapshotCounts([
      {
        customer_id: 'cus_canceled_active',
        is_good_plan: true,
        paid_at: '2026-01-01T00:00:00.000Z',
        canceled_at: '2026-03-20T00:00:00.000Z',
        subscription_anchor_end: '2026-04-01T00:00:00.000Z',
      },
      {
        customer_id: 'cus_canceled_expired',
        is_good_plan: true,
        paid_at: '2026-01-01T00:00:00.000Z',
        canceled_at: '2026-03-20T00:00:00.000Z',
        subscription_anchor_end: '2026-03-24T00:00:00.000Z',
      },
      {
        customer_id: 'cus_past_due_active',
        is_good_plan: true,
        status: 'succeeded',
        paid_at: '2026-01-01T00:00:00.000Z',
        past_due_at: '2026-03-22T00:00:00.000Z',
        subscription_anchor_end: '2026-04-01T00:00:00.000Z',
      },
      {
        customer_id: 'cus_past_due_canceled',
        is_good_plan: true,
        status: 'succeeded',
        paid_at: '2026-01-01T00:00:00.000Z',
        past_due_at: '2026-03-22T00:00:00.000Z',
        canceled_at: '2026-03-23T00:00:00.000Z',
        subscription_anchor_end: '2026-04-01T00:00:00.000Z',
      },
      {
        customer_id: 'cus_past_due_stale_status',
        is_good_plan: true,
        status: 'canceled',
        paid_at: '2026-01-01T00:00:00.000Z',
        past_due_at: '2026-03-22T00:00:00.000Z',
        subscription_anchor_end: '2026-04-01T00:00:00.000Z',
      },
    ], snapshotEnd)).toEqual({
      active_canceled_orgs: 2,
      active_past_due_orgs: 1,
    })
  })

  it.concurrent('normalizes subscription access snapshot SQL rows', () => {
    expect(globalStatsTestUtils.normalizeSubscriptionAccessSnapshotCounts({
      active_canceled_orgs: '3',
      active_past_due_orgs: null,
    })).toEqual({
      active_canceled_orgs: 3,
      active_past_due_orgs: 0,
    })
  })

  it.concurrent('only refreshes mutable past-due stats for the current daily snapshot or an empty first fill', () => {
    const currentWindow = globalStatsTestUtils.getCompletedDayWindowForDateId('2026-03-24')
    const replayReferenceDate = new Date('2026-03-26T00:00:00.000Z')

    expect(globalStatsTestUtils.shouldRefreshMutablePastDueStats(
      currentWindow,
      new Date('2026-03-25T12:00:00.000Z'),
    )).toBe(true)
    expect(globalStatsTestUtils.shouldRefreshMutablePastDueStats(
      currentWindow,
      replayReferenceDate,
    )).toBe(false)
    expect(globalStatsTestUtils.shouldRefreshMutablePastDueStats(
      currentWindow,
      replayReferenceDate,
      { past_due_orgs: 0, past_due_orgs_average_days: 0, active_canceled_orgs: 0, active_past_due_orgs: 0 },
    )).toBe(true)
    expect(globalStatsTestUtils.shouldRefreshMutablePastDueStats(
      currentWindow,
      replayReferenceDate,
      { past_due_orgs: 2, past_due_orgs_average_days: 3.8, active_canceled_orgs: 0, active_past_due_orgs: 0 },
    )).toBe(false)
  })

  it.concurrent('defaults missing plan buckets to zero for global stats snapshots', () => {
    expect(globalStatsTestUtils.normalizePlanTotals({ Solo: 12, Team: Number.NaN })).toEqual({
      Credits: 0,
      Enterprise: 0,
      Maker: 0,
      Solo: 12,
      Team: 0,
      Trial: 0,
    })
  })

  it.concurrent('keeps converted trials in replay snapshots until paid_at reaches the snapshot end', () => {
    const snapshotEnd = new Date('2026-03-25T00:00:00.000Z')

    expect(globalStatsTestUtils.isUnpaidAtBillingSnapshot(null, snapshotEnd)).toBe(true)
    expect(globalStatsTestUtils.isUnpaidAtBillingSnapshot('2026-03-25T00:00:00.000Z', snapshotEnd)).toBe(true)
    expect(globalStatsTestUtils.isUnpaidAtBillingSnapshot('2026-03-25T00:00:00.001Z', snapshotEnd)).toBe(true)
    expect(globalStatsTestUtils.isUnpaidAtBillingSnapshot('2026-03-24T23:59:59.999Z', snapshotEnd)).toBe(false)
  })

  it.concurrent('excludes unpaid trials from paid replay snapshots', () => {
    const snapshotEnd = new Date('2026-03-25T00:00:00.000Z')

    expect(globalStatsTestUtils.isPaidPlanAtBillingSnapshot(null, '2026-03-26T00:00:00.000Z', snapshotEnd)).toBe(false)
    expect(globalStatsTestUtils.isPaidPlanAtBillingSnapshot(null, '2026-03-25T00:00:00.000Z', snapshotEnd)).toBe(false)
    expect(globalStatsTestUtils.isPaidPlanAtBillingSnapshot(null, '2026-03-24T23:59:59.999Z', snapshotEnd)).toBe(false)
    expect(globalStatsTestUtils.isPaidPlanAtBillingSnapshot('2026-03-25T00:00:00.000Z', '2026-03-24T00:00:00.000Z', snapshotEnd)).toBe(false)
    expect(globalStatsTestUtils.isPaidPlanAtBillingSnapshot('2026-03-24T23:59:59.999Z', '2026-03-26T00:00:00.000Z', snapshotEnd)).toBe(true)
  })

  it.concurrent('resolves billing interval from price ids then anchor length', () => {
    expect(globalStatsTestUtils.resolvePlanBillingInterval({
      priceId: 'price_m',
      priceMId: 'price_m',
      priceYId: 'price_y',
      anchorStart: '2026-01-01T00:00:00.000Z',
      anchorEnd: '2027-01-01T00:00:00.000Z',
    })).toBe('monthly')

    expect(globalStatsTestUtils.resolvePlanBillingInterval({
      priceId: 'price_y',
      priceMId: 'price_m',
      priceYId: 'price_y',
      anchorStart: '2026-01-01T00:00:00.000Z',
      anchorEnd: '2026-02-01T00:00:00.000Z',
    })).toBe('yearly')

    expect(globalStatsTestUtils.resolvePlanBillingInterval({
      priceId: 'price_custom',
      priceMId: 'price_m',
      priceYId: 'price_y',
      anchorStart: '2026-01-01T00:00:00.000Z',
      anchorEnd: '2026-12-01T00:00:00.000Z',
    })).toBe('yearly')

    expect(globalStatsTestUtils.resolvePlanBillingInterval({
      priceId: null,
      priceMId: 'price_m',
      priceYId: 'price_y',
      anchorStart: '2026-01-01T00:00:00.000Z',
      anchorEnd: '2026-02-01T00:00:00.000Z',
    })).toBe('monthly')
  })

  it.concurrent('resolves MRR from matched price ids with list-price fallback', () => {
    expect(globalStatsTestUtils.resolvePlanMrrDollars({
      billing: 'monthly',
      priceId: 'price_m',
      priceMId: 'price_m',
      priceYId: 'price_y',
      priceM: 14,
      priceY: 146,
    })).toBe(14)

    expect(globalStatsTestUtils.resolvePlanMrrDollars({
      billing: 'yearly',
      priceId: 'price_y',
      priceMId: 'price_m',
      priceYId: 'price_y',
      priceM: 14,
      priceY: 146,
    })).toBe(146 / 12)

    expect(globalStatsTestUtils.resolvePlanMrrDollars({
      billing: 'yearly',
      priceId: 'price_custom',
      priceMId: 'price_m',
      priceYId: 'price_y',
      priceM: 249,
      priceY: 2490,
    })).toBe(2490 / 12)
  })

  it.concurrent('keeps active Stripe trials out of MRR until trial_at passes', () => {
    const snapshotEnd = new Date('2026-08-11T00:00:00.000Z')

    // Matches SQL `si.trial_at <= snapshot` (NULL does not qualify).
    expect(globalStatsTestUtils.hasLeftTrialAtSnapshot(null, snapshotEnd)).toBe(false)
    expect(globalStatsTestUtils.hasLeftTrialAtSnapshot('2026-08-10T23:59:59.999Z', snapshotEnd)).toBe(true)
    expect(globalStatsTestUtils.hasLeftTrialAtSnapshot('2026-08-11T00:00:00.000Z', snapshotEnd)).toBe(true)
    expect(globalStatsTestUtils.hasLeftTrialAtSnapshot('2026-08-11T00:00:00.001Z', snapshotEnd)).toBe(false)
  })

  it.concurrent('normalizes snapshot billing counts from SQL rows', () => {
    expect(globalStatsTestUtils.normalizeBillingSnapshotCounts([
      {
        yearly: '2',
        monthly: '3',
        total: '5',
        paying_orgs_for_conversion: '4',
        plan_name: 'Solo',
        plan_count: '2',
      },
      {
        yearly: '2',
        monthly: '3',
        total: '5',
        paying_orgs_for_conversion: '4',
        plan_name: 'Trial',
        plan_count: '1',
      },
      {
        yearly: '2',
        monthly: '3',
        total: '5',
        paying_orgs_for_conversion: '4',
        plan_name: 'Credits',
        plan_count: '3',
      },
    ])).toEqual({
      customers: { yearly: 2, monthly: 3, total: 5 },
      payingOrgsForConversion: 4,
      plans: {
        Credits: 3,
        Enterprise: 0,
        Maker: 0,
        Solo: 2,
        Team: 0,
        Trial: 1,
      },
    })
  })

  it.concurrent('defaults empty snapshot billing rows to zero counts', () => {
    expect(globalStatsTestUtils.normalizeBillingSnapshotCounts([])).toEqual({
      customers: { yearly: 0, monthly: 0, total: 0 },
      payingOrgsForConversion: 0,
      plans: {
        Credits: 0,
        Enterprise: 0,
        Maker: 0,
        Solo: 0,
        Team: 0,
        Trial: 0,
      },
    })
  })

  it.concurrent('normalizes core snapshot counts from SQL rows', () => {
    expect(globalStatsTestUtils.normalizeCoreSnapshotCounts({
      onboarded: '7',
      need_upgrade: null,
      above_plan_with_credits: '4',
      above_plan_without_credits: null,
    })).toEqual({
      onboarded: 7,
      needUpgrade: 0,
      abovePlanWithCredits: 4,
      abovePlanWithoutCredits: 0,
    })

    expect(globalStatsTestUtils.normalizeCoreSnapshotCounts(null)).toEqual({
      onboarded: 0,
      needUpgrade: 0,
      abovePlanWithCredits: 0,
      abovePlanWithoutCredits: 0,
    })
  })

  it.concurrent('reconstructs above-plan credit state at the replayed snapshot boundary', () => {
    const source = readFileSync(new URL('../supabase/functions/_backend/triggers/global_stats.ts', import.meta.url), 'utf8')
    const remainingCreditsHelper = source.match(/function remainingCreditsAtSnapshotSql[\s\S]*?\n\}/)?.[0] ?? ''
    const coreSnapshotQuery = source.match(/async function getCoreSnapshotCounts[\s\S]*?async function runCoreGlobalStatsShard/)?.[0] ?? ''

    expect(remainingCreditsHelper).toContain('g.granted_at < ${snapshotExclusiveEndIso}::timestamptz')
    expect(remainingCreditsHelper).toContain('g.expires_at >= ${snapshotExclusiveEndIso}::timestamptz')
    expect(remainingCreditsHelper).toContain('c.applied_at < ${snapshotExclusiveEndIso}::timestamptz')
    expect(coreSnapshotQuery).toContain('public.usage_credit_grants')
    expect(coreSnapshotQuery).toContain('remainingCreditsAtSnapshotSql(snapshotExclusiveEndIso)')
    expect(coreSnapshotQuery).toContain('si.is_above_plan = true')
    expect(coreSnapshotQuery).not.toContain('si.plan_usage > 100')
    expect(coreSnapshotQuery).not.toContain('o.has_usage_credits')
  })

  it.concurrent('counts credit-only orgs as a daily plan bucket at the replayed snapshot boundary', () => {
    const source = readFileSync(new URL('../supabase/functions/_backend/triggers/global_stats.ts', import.meta.url), 'utf8')
    const billingSnapshotQuery = source.match(/async function getBillingSnapshotCounts[\s\S]*?async function getSubscriptionAccessSnapshotCounts/)?.[0] ?? ''
    const coreShard = source.match(/async function runCoreGlobalStatsShard[\s\S]*?async function getRegistersToday/)?.[0] ?? ''

    expect(billingSnapshotQuery).toContain('credit_only_orgs')
    expect(billingSnapshotQuery).toContain("SELECT 'Credits'::character varying AS plan_name")
    expect(billingSnapshotQuery).toContain('public.usage_credit_grants')
    expect(billingSnapshotQuery).toContain('remainingCreditsAtSnapshotSql(snapshotExclusiveEndIso)')
    expect(billingSnapshotQuery).toContain('FROM active_subscriptions a')
    expect(billingSnapshotQuery).toContain('FROM trial_users t')
    expect(billingSnapshotQuery).not.toContain('o.has_usage_credits')
    expect(coreShard).toContain('plan_credits: plans.Credits || 0')
    expect(source).toContain('plan_credits?: number')
  })

  it.concurrent('shares remaining-credits snapshot predicate between billing and core snapshots', () => {
    const source = readFileSync(new URL('../supabase/functions/_backend/triggers/global_stats.ts', import.meta.url), 'utf8')
    const helperMatches = source.match(/remainingCreditsAtSnapshotSql\(/g) ?? []

    expect(source).toContain('function remainingCreditsAtSnapshotSql')
    expect(helperMatches).toHaveLength(3)
  })

  it.concurrent('snapshots apps with preview QR enabled in the core global stats shard', () => {
    const source = readFileSync(new URL('../supabase/functions/_backend/triggers/global_stats.ts', import.meta.url), 'utf8')
    const countFn = source.match(/async function countAppsWithPreview[\s\S]*?async function getTrialExtensionStats/)?.[0] ?? ''
    const coreShard = source.match(/async function runCoreGlobalStatsShard[\s\S]*?async function getRegistersToday/)?.[0] ?? ''

    expect(countFn).toContain('apps.allow_preview = true')
    expect(countFn).toContain('apps.created_at <')
    expect(countFn).toContain('snapshotEnd')
    expect(coreShard).toContain('countAppsWithPreview(c, window.prevDayEnd)')
    expect(coreShard).toContain('apps_with_preview,')
    // Keep writable while prod types lag the migration (auto-sync gate).
    expect(source).toContain('apps_with_preview?: number')
    expect(source).toContain('isMissingAppsWithPreviewColumnError')
  })
  it.concurrent('snapshots users with verified 2FA in the core global stats shard', () => {
    const source = readFileSync(new URL('../supabase/functions/_backend/triggers/global_stats.ts', import.meta.url), 'utf8')
    const countFn = source.match(/async function countUsersWith2fa[\s\S]*?async function getTrialExtensionStats/)?.[0] ?? ''
    const coreShard = source.match(/async function runCoreGlobalStatsShard[\s\S]*?async function getRegistersToday/)?.[0] ?? ''

    expect(countFn).toContain('auth.mfa_factors')
    expect(countFn).toContain('auth.mfa_challenges')
    expect(countFn).toContain("mfa.status = 'verified'")
    expect(countFn).toContain('mfa.created_at <')
    expect(countFn).toContain('ch.verified_at <')
    expect(countFn).toContain('u.created_at <')
    expect(coreShard).toContain('countUsersWith2fa(c, window.prevDayEnd)')
    expect(coreShard).toContain('users_with_2fa,')
    expect(source).toContain('users_with_2fa?: number')
    expect(source).toContain('isMissingUsersWith2faColumnError')
    expect(source).toContain('.includes(\'apps_with_preview\')')
    expect(source).toContain('.includes(\'users_with_2fa\')')
  })

  it.concurrent('normalizes global stats retry payload counts', () => {
    expect(globalStatsTestUtils.normalizeGlobalStatsRetryCount('2')).toBe(2)
    expect(globalStatsTestUtils.normalizeGlobalStatsRetryCount(2.8)).toBe(2)
    expect(globalStatsTestUtils.normalizeGlobalStatsRetryCount(-1)).toBe(0)
    expect(globalStatsTestUtils.normalizeGlobalStatsRetryCount('bad')).toBe(0)
  })

  it.concurrent('builds retry messages for the admin stats queue', () => {
    expect(globalStatsTestUtils.buildGlobalStatsRetryMessage(3)).toEqual({
      function_name: 'global_stats',
      function_type: 'cloudflare',
      payload: {
        retry_count: 3,
      },
    })
  })

  it.concurrent('preserves the snapshot date on dispatcher retry messages', () => {
    expect(globalStatsTestUtils.buildGlobalStatsRetryMessage(3, '2026-03-24')).toEqual({
      function_name: 'global_stats',
      function_type: 'cloudflare',
      payload: {
        date_id: '2026-03-24',
        retry_count: 3,
      },
    })
  })

  it.concurrent('builds shard messages as distinct queue HTTP calls', () => {
    expect(globalStatsTestUtils.getGlobalStatsShardFunctionName('revenue')).toBe('global_stats_revenue')
    expect(globalStatsTestUtils.getGlobalStatsShardFunctionName('usage_updates')).toBe('global_stats_usage_updates')
    expect(globalStatsTestUtils.buildGlobalStatsShardMessage('revenue', '2026-03-24')).toEqual({
      function_name: 'global_stats_revenue',
      function_type: 'cloudflare',
      payload: {
        date_id: '2026-03-24',
      },
    })
    expect(globalStatsTestUtils.buildGlobalStatsShardMessage('revenue', '2026-03-24', 2)).toEqual({
      function_name: 'global_stats_revenue',
      function_type: 'cloudflare',
      payload: {
        date_id: '2026-03-24',
        retry_count: 2,
      },
    })
  })

  it.concurrent('normalizes global stats shard and date payloads', () => {
    expect(globalStatsTestUtils.normalizeGlobalStatsShard('core')).toBe('core')
    expect(globalStatsTestUtils.normalizeGlobalStatsShard('usage_updates')).toBe('usage_updates')
    expect(globalStatsTestUtils.normalizeGlobalStatsShard('usage')).toBeNull()
    expect(globalStatsTestUtils.normalizeGlobalStatsShard('bad')).toBeNull()
    expect(globalStatsTestUtils.normalizeGlobalStatsDateId('2026-03-24')).toBe('2026-03-24')
    expect(globalStatsTestUtils.normalizeGlobalStatsDateId('2026-02-30')).toBeNull()
    expect(globalStatsTestUtils.normalizeGlobalStatsDateId('bad')).toBeNull()
  })

  it('rejects non-empty malformed JSON payloads', async () => {
    const app = new Hono()
    app.post('/', async (c) => {
      await globalStatsTestUtils.readGlobalStatsPayload(c)
      return c.json({ status: 'ok' })
    })

    const response = await app.request('http://localhost/', {
      method: 'POST',
      body: '{',
    })

    expect(response.status).toBe(400)
  })

  it('schedules global stats snapshots in the EdgeRuntime background path', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    let resolveUpdate!: () => void
    const updatePromise = new Promise<void>((resolve) => {
      resolveUpdate = resolve
    })
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runUpdate = vi.fn(() => updatePromise)
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsUpdate(c, runUpdate)
        return c.json({ status: 'ok' })
      })

      const requestTimeoutMs = 500
      const responseStatusPromise = (async () => {
        const response = await app.request('http://localhost/', { method: 'POST' })
        return response.status
      })()
      const result = await Promise.race([
        responseStatusPromise,
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), requestTimeoutMs)),
      ])

      expect(result).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      resolveUpdate()
      await scheduledPromise
      expect(runUpdate).toHaveBeenCalledTimes(1)
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('schedules global stats shard work in the EdgeRuntime background path', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    let resolveShard!: () => void
    const shardPromise = new Promise<void>((resolve) => {
      resolveShard = resolve
    })
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runShard = vi.fn((_c: Context, _shard: string, _dateId: string) => shardPromise)
      const cancelRetry = vi.fn(async (_c: Context, _retryMsgId: number) => {})
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsShardUpdate(c, 'core', '2026-03-24', {
          cancelRetry,
          retryCount: 1,
          retryMsgId: 654,
          runShard,
        })
        return c.json({ status: 'ok' })
      })

      const requestTimeoutMs = 500
      const responseStatusPromise = (async () => {
        const response = await app.request('http://localhost/', { method: 'POST' })
        return response.status
      })()
      const result = await Promise.race([
        responseStatusPromise,
        new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), requestTimeoutMs)),
      ])

      expect(result).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      resolveShard()
      await scheduledPromise
      expect(runShard).toHaveBeenCalledTimes(1)
      expect(runShard).toHaveBeenCalledWith(expect.anything(), 'core', '2026-03-24')
      expect(cancelRetry).toHaveBeenCalledTimes(1)
      expect(cancelRetry).toHaveBeenCalledWith(expect.anything(), 654)
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('leaves a reserved shard retry queued when the background shard update fails', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runShard = vi.fn(async (_c: Context, _shard: string, _dateId: string) => {
        throw new Error('shard failed')
      })
      const cancelRetry = vi.fn(async (_c: Context, _retryMsgId: number) => {})
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsShardUpdate(c, 'core', '2026-03-24', {
          cancelRetry,
          retryCount: 1,
          retryMsgId: 654,
          runShard,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      await scheduledPromise
      expect(runShard).toHaveBeenCalledTimes(1)
      expect(runShard).toHaveBeenCalledWith(expect.anything(), 'core', '2026-03-24')
      expect(cancelRetry).not.toHaveBeenCalled()
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('returns failure when the shard retry budget is exhausted and the shard update fails', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    const waitUntil = vi.fn()

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runShard = vi.fn(async (_c: Context, _shard: string, _dateId: string) => {
        throw new Error('shard failed after retry budget')
      })
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsShardUpdate(c, 'core', '2026-03-24', {
          retryCount: globalStatsTestUtils.GLOBAL_STATS_BACKGROUND_MAX_RETRIES,
          retryMsgId: null,
          runShard,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(500)
      expect(waitUntil).not.toHaveBeenCalled()
      expect(runShard).toHaveBeenCalledTimes(1)
      expect(runShard).toHaveBeenCalledWith(expect.anything(), 'core', '2026-03-24')
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('cancels a reserved retry when the background snapshot succeeds', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runUpdate = vi.fn(async () => {})
      const cancelRetry = vi.fn(async (_c: Context, _retryMsgId: number) => {})
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsUpdate(c, runUpdate, {
          cancelRetry,
          retryCount: 2,
          retryMsgId: 321,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      await scheduledPromise
      expect(runUpdate).toHaveBeenCalledTimes(1)
      expect(cancelRetry).toHaveBeenCalledTimes(1)
      expect(cancelRetry).toHaveBeenCalledWith(expect.anything(), 321)
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('propagates reserved retry cancel failures after the background snapshot succeeds', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const cancelFailure = new Error('retry cancel failed')
      const runUpdate = vi.fn(async () => {})
      const cancelRetry = vi.fn(async (_c: Context, _retryMsgId: number) => {
        throw cancelFailure
      })
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsUpdate(c, runUpdate, {
          cancelRetry,
          retryCount: 2,
          retryMsgId: 321,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      await expect(scheduledPromise).rejects.toThrow('retry cancel failed')
      expect(runUpdate).toHaveBeenCalledTimes(1)
      expect(cancelRetry).toHaveBeenCalledTimes(1)
      expect(cancelRetry).toHaveBeenCalledWith(expect.anything(), 321)
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('leaves a reserved retry queued when the background snapshot update fails', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    let scheduledPromise: Promise<unknown> | null = null
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      scheduledPromise = promise
    })

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const failure = new Error('snapshot failed')
      const runUpdate = vi.fn(async () => {
        throw failure
      })
      const cancelRetry = vi.fn(async (_c: Context, _retryMsgId: number) => {})
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsUpdate(c, runUpdate, {
          cancelRetry,
          retryCount: 2,
          retryMsgId: 321,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(200)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      if (!scheduledPromise)
        throw new Error('Expected waitUntil to receive a promise')

      await scheduledPromise
      expect(runUpdate).toHaveBeenCalledTimes(1)
      expect(cancelRetry).not.toHaveBeenCalled()
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('returns failure when the retry budget is exhausted and the snapshot update fails', async () => {
    const globalWithEdgeRuntime = globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
    }
    const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
    const waitUntil = vi.fn()

    globalWithEdgeRuntime.EdgeRuntime = { waitUntil }

    try {
      const app = new Hono()
      const runUpdate = vi.fn(async () => {
        throw new Error('snapshot failed after retry budget')
      })
      app.post('/', async (c) => {
        await globalStatsTestUtils.scheduleGlobalStatsUpdate(c, runUpdate, {
          retryCount: globalStatsTestUtils.GLOBAL_STATS_BACKGROUND_MAX_RETRIES,
          retryMsgId: null,
        })
        return c.json({ status: 'ok' })
      })

      const response = await Promise.resolve(app.request('http://localhost/', { method: 'POST' }))
      expect(response.status).toBe(500)
      expect(waitUntil).not.toHaveBeenCalled()
      expect(runUpdate).toHaveBeenCalledTimes(1)
    }
    finally {
      globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
    }
  })

  it('propagates strict tracking provider failures', async () => {
    const restoreEnv = withTestEnv({
      POSTHOG_API_KEY: '',
    })

    const c = {
      get: () => undefined,
      req: {
        header: () => undefined,
      },
    } as unknown as Context

    try {
      await expect(sendEventToTracking(c, {
        channel: 'updates-stats',
        event: 'Updates last month',
        user_id: 'admin',
      }, { background: false, strict: true })).rejects.toThrow('posthog tracking returned false')
    }
    finally {
      restoreEnv()
    }
  })

})
