import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { Hono } from 'hono/tiny'
import { afterAll, describe, expect, it } from 'vitest'
import { globalStatsTestUtils } from '../supabase/functions/_backend/triggers/global_stats.ts'
import { cleanupPostgresClient, executeSQL, POSTGRES_URL, PRODUCT_ID, resetAndSeedAppData, resetAppData } from './test-utils.ts'

type StatsTestApp = Hono<{ Bindings: { SUPABASE_DB_URL: string } }>

async function requestDirectStats<T>(registerRoute: (app: StatsTestApp) => void): Promise<T> {
  const globalWithEdgeRuntime = globalThis as typeof globalThis & {
    EdgeRuntime?: { waitUntil: (promise: Promise<unknown>) => void }
  }
  const previousEdgeRuntime = globalWithEdgeRuntime.EdgeRuntime
  const previousSupabaseDbUrl = process.env.SUPABASE_DB_URL
  globalWithEdgeRuntime.EdgeRuntime = undefined
  process.env.SUPABASE_DB_URL = POSTGRES_URL

  try {
    const app = new Hono<{ Bindings: { SUPABASE_DB_URL: string } }>()
    registerRoute(app)

    const response = await app.request('http://local/', undefined, { SUPABASE_DB_URL: POSTGRES_URL })
    return await response.json() as T
  }
  finally {
    if (previousSupabaseDbUrl === undefined)
      delete process.env.SUPABASE_DB_URL
    else
      process.env.SUPABASE_DB_URL = previousSupabaseDbUrl
    globalWithEdgeRuntime.EdgeRuntime = previousEdgeRuntime
  }
}

async function getCoreSnapshotCountsAt(snapshotExclusiveEnd: Date) {
  return requestDirectStats<{
    abovePlanWithCredits: number
    abovePlanWithoutCredits: number
  }>((app) => {
    app.get('/', async c => c.json(await globalStatsTestUtils.getCoreSnapshotCounts(c, snapshotExclusiveEnd)))
  })
}

async function getBillingSnapshotCountsAt(snapshotExclusiveEnd: Date) {
  return requestDirectStats<{
    plans: Record<string, number>
  }>((app) => {
    app.get('/', async c => c.json(await globalStatsTestUtils.getBillingSnapshotCounts(c, snapshotExclusiveEnd)))
  })
}

afterAll(async () => {
  await cleanupPostgresClient()
})

describe('global stats core snapshots', () => {
  it.concurrent('counts just-over-limit orgs after plan usage rounds to 100', async () => {
    const snapshotExclusiveEnd = new Date('2030-01-02T00:00:00.000Z')
    const beforeSnapshot = '2029-12-01T00:00:00.000Z'
    const afterSnapshot = '2030-02-01T00:00:00.000Z'
    const withCreditsOrgId = randomUUID()
    const withoutCreditsOrgId = randomUUID()
    const withCreditsAppId = `com.global.stats.credit.with.${withCreditsOrgId.slice(0, 8)}`
    const withoutCreditsAppId = `com.global.stats.credit.without.${withoutCreditsOrgId.slice(0, 8)}`
    const withCreditsCustomerId = `cus_global_stats_credit_with_${withCreditsOrgId.slice(0, 8)}`
    const withoutCreditsCustomerId = `cus_global_stats_credit_without_${withoutCreditsOrgId.slice(0, 8)}`
    const orgIds = [withCreditsOrgId, withoutCreditsOrgId]
    const appIds = [withCreditsAppId, withoutCreditsAppId]
    const customerIds = [withCreditsCustomerId, withoutCreditsCustomerId]
    const baseline = await getCoreSnapshotCountsAt(snapshotExclusiveEnd)

    try {
      await Promise.all([
        resetAndSeedAppData(withCreditsAppId, {
          orgId: withCreditsOrgId,
          stripeCustomerId: withCreditsCustomerId,
          planProductId: PRODUCT_ID,
        }),
        resetAndSeedAppData(withoutCreditsAppId, {
          orgId: withoutCreditsOrgId,
          stripeCustomerId: withoutCreditsCustomerId,
          planProductId: PRODUCT_ID,
        }),
      ])

      // Raw 100.1% usage is rounded to 100 in plan_usage; is_above_plan retains the exact fit result.
      await executeSQL(`
        UPDATE public.stripe_info
        SET status = 'succeeded'::public.stripe_status,
            plan_usage = 100,
            is_above_plan = true,
            is_good_plan = true,
            created_at = $2::timestamptz,
            paid_at = $2::timestamptz,
            canceled_at = NULL,
            subscription_anchor_end = $3::timestamptz
        WHERE customer_id = ANY($1::text[])
      `, [customerIds, beforeSnapshot, afterSnapshot])

      await executeSQL(`
        UPDATE public.org_stats_refresh_state
        SET plan_calculated_at = $2::timestamptz
        WHERE org_id = ANY($1::uuid[])
      `, [orgIds, beforeSnapshot])

      const [grant] = await executeSQL(`
        INSERT INTO public.usage_credit_grants (
          org_id,
          credits_total,
          granted_at,
          expires_at,
          source
        ) VALUES ($1, 10, $2::timestamptz, $3::timestamptz, 'manual')
        RETURNING id
      `, [withCreditsOrgId, beforeSnapshot, snapshotExclusiveEnd.toISOString()])

      await executeSQL(`
        INSERT INTO public.usage_credit_consumptions (
          grant_id,
          org_id,
          metric,
          credits_used,
          applied_at
        ) VALUES
          ($1, $2, 'mau'::public.credit_metric_type, 3, '2029-12-15T00:00:00.000Z'::timestamptz),
          ($1, $2, 'mau'::public.credit_metric_type, 7, $3::timestamptz)
      `, [grant.id, withCreditsOrgId, snapshotExclusiveEnd.toISOString()])

      await executeSQL(`
        INSERT INTO public.usage_credit_grants (
          org_id,
          credits_total,
          granted_at,
          expires_at,
          source
        ) VALUES ($1, 10, $2::timestamptz, $3::timestamptz, 'manual')
      `, [withoutCreditsOrgId, snapshotExclusiveEnd.toISOString(), afterSnapshot])

      await executeSQL('UPDATE public.orgs SET has_usage_credits = false WHERE id = ANY($1::uuid[])', [orgIds])

      const counts = await getCoreSnapshotCountsAt(snapshotExclusiveEnd)
      expect(counts.abovePlanWithCredits).toBe(baseline.abovePlanWithCredits + 1)
      expect(counts.abovePlanWithoutCredits).toBe(baseline.abovePlanWithoutCredits + 1)
    }
    finally {
      await executeSQL('DELETE FROM public.usage_credit_consumptions WHERE org_id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.usage_credit_grants WHERE org_id = ANY($1::uuid[])', [orgIds])
      await Promise.all(appIds.map(appId => resetAppData(appId)))
      await executeSQL('DELETE FROM public.org_users WHERE org_id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])', [customerIds])
    }
  }, 90000)

  it.concurrent('counts orgs with remaining credits and no plan as the Credits plan bucket', async () => {
    const snapshotExclusiveEnd = new Date('2030-03-02T00:00:00.000Z')
    const beforeSnapshot = '2030-01-01T00:00:00.000Z'
    const afterSnapshot = '2030-04-01T00:00:00.000Z'
    const creditOnlyOrgId = randomUUID()
    const planPlusCreditsOrgId = randomUUID()
    const consumedOrgId = randomUUID()
    const trialPlusCreditsOrgId = randomUUID()
    const creditOnlyAppId = `com.global.stats.plan.credits.only.${creditOnlyOrgId.slice(0, 8)}`
    const planPlusCreditsAppId = `com.global.stats.plan.credits.sub.${planPlusCreditsOrgId.slice(0, 8)}`
    const consumedAppId = `com.global.stats.plan.credits.consumed.${consumedOrgId.slice(0, 8)}`
    const trialPlusCreditsAppId = `com.global.stats.plan.credits.trial.${trialPlusCreditsOrgId.slice(0, 8)}`
    const creditOnlyCustomerId = `cus_global_stats_plan_credits_only_${creditOnlyOrgId.slice(0, 8)}`
    const planPlusCreditsCustomerId = `cus_global_stats_plan_credits_sub_${planPlusCreditsOrgId.slice(0, 8)}`
    const consumedCustomerId = `cus_global_stats_plan_credits_consumed_${consumedOrgId.slice(0, 8)}`
    const trialPlusCreditsCustomerId = `cus_global_stats_plan_credits_trial_${trialPlusCreditsOrgId.slice(0, 8)}`
    const orgIds = [creditOnlyOrgId, planPlusCreditsOrgId, consumedOrgId, trialPlusCreditsOrgId]
    const appIds = [creditOnlyAppId, planPlusCreditsAppId, consumedAppId, trialPlusCreditsAppId]
    const customerIds = [creditOnlyCustomerId, planPlusCreditsCustomerId, consumedCustomerId, trialPlusCreditsCustomerId]
    const baseline = await getBillingSnapshotCountsAt(snapshotExclusiveEnd)

    try {
      await Promise.all([
        resetAndSeedAppData(creditOnlyAppId, {
          orgId: creditOnlyOrgId,
          stripeCustomerId: creditOnlyCustomerId,
          planProductId: PRODUCT_ID,
        }),
        resetAndSeedAppData(planPlusCreditsAppId, {
          orgId: planPlusCreditsOrgId,
          stripeCustomerId: planPlusCreditsCustomerId,
          planProductId: PRODUCT_ID,
        }),
        resetAndSeedAppData(consumedAppId, {
          orgId: consumedOrgId,
          stripeCustomerId: consumedCustomerId,
          planProductId: PRODUCT_ID,
        }),
        resetAndSeedAppData(trialPlusCreditsAppId, {
          orgId: trialPlusCreditsOrgId,
          stripeCustomerId: trialPlusCreditsCustomerId,
          planProductId: PRODUCT_ID,
        }),
      ])

      await executeSQL(`
        UPDATE public.stripe_info
        SET status = 'canceled'::public.stripe_status,
            is_good_plan = false,
            created_at = $2::timestamptz,
            paid_at = $2::timestamptz,
            canceled_at = $2::timestamptz,
            trial_at = '1970-01-01T00:00:00.000Z'::timestamptz,
            subscription_anchor_end = $2::timestamptz
        WHERE customer_id = ANY($1::text[])
      `, [[creditOnlyCustomerId, consumedCustomerId], beforeSnapshot])

      await executeSQL(`
        UPDATE public.stripe_info
        SET status = 'succeeded'::public.stripe_status,
            is_good_plan = true,
            created_at = $2::timestamptz,
            paid_at = $2::timestamptz,
            canceled_at = NULL,
            trial_at = '1970-01-01T00:00:00.000Z'::timestamptz,
            subscription_anchor_end = $3::timestamptz
        WHERE customer_id = $1
      `, [planPlusCreditsCustomerId, beforeSnapshot, afterSnapshot])

      await executeSQL(`
        UPDATE public.stripe_info
        SET status = 'created'::public.stripe_status,
            is_good_plan = false,
            created_at = $2::timestamptz,
            paid_at = NULL,
            canceled_at = NULL,
            trial_at = $3::timestamptz,
            subscription_anchor_end = $3::timestamptz
        WHERE customer_id = $1
      `, [trialPlusCreditsCustomerId, beforeSnapshot, afterSnapshot])

      const grants = await executeSQL(`
        INSERT INTO public.usage_credit_grants (
          org_id,
          credits_total,
          granted_at,
          expires_at,
          source
        ) VALUES
          ($1, 10, $5::timestamptz, $6::timestamptz, 'manual'),
          ($2, 10, $5::timestamptz, $6::timestamptz, 'manual'),
          ($3, 10, $5::timestamptz, $6::timestamptz, 'manual'),
          ($4, 10, $5::timestamptz, $6::timestamptz, 'manual')
        RETURNING id, org_id
      `, [creditOnlyOrgId, planPlusCreditsOrgId, consumedOrgId, trialPlusCreditsOrgId, beforeSnapshot, afterSnapshot])

      const consumedGrantId = grants.find(row => row.org_id === consumedOrgId)?.id
      expect(consumedGrantId).toBeTruthy()

      await executeSQL(`
        INSERT INTO public.usage_credit_consumptions (
          grant_id,
          org_id,
          metric,
          credits_used,
          applied_at
        ) VALUES ($1, $2, 'mau'::public.credit_metric_type, 10, $3::timestamptz)
      `, [consumedGrantId, consumedOrgId, beforeSnapshot])

      const counts = await getBillingSnapshotCountsAt(snapshotExclusiveEnd)
      expect(counts.plans.Credits).toBe((baseline.plans.Credits ?? 0) + 1)
    }
    finally {
      await executeSQL('DELETE FROM public.usage_credit_consumptions WHERE org_id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.usage_credit_grants WHERE org_id = ANY($1::uuid[])', [orgIds])
      await Promise.all(appIds.map(appId => resetAppData(appId)))
      await executeSQL('DELETE FROM public.org_users WHERE org_id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [orgIds])
      await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])', [customerIds])
    }
  }, 90000)
})
