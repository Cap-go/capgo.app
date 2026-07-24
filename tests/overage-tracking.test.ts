import type { Database } from '../src/types/supabase.types'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { ORG_ID_OVERAGE } from './test-utils'

const supabaseUrl = env.SUPABASE_URL as string
const supabaseServiceKey = env.SUPABASE_SERVICE_KEY as string
const supabase = createClient<Database>(supabaseUrl, supabaseServiceKey)

async function callRpc<T>(
  fn: () => PromiseLike<{ data: T | null, error: any }>,
): Promise<{ data: T | null, error: any }> {
  return await fn()
}

type CreditMetric = Database['public']['Enums']['credit_metric_type']

async function countOverageEvents(metric: CreditMetric, billingStart: Date, billingEnd: Date) {
  const { count, error } = await supabase
    .from('usage_overage_events')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', ORG_ID_OVERAGE)
    .eq('metric', metric)
    .eq('billing_cycle_start', billingStart.toISOString().slice(0, 10))
    .eq('billing_cycle_end', billingEnd.toISOString().slice(0, 10))
  expect(error).toBeNull()
  return count ?? 0
}

describe('overage Tracking - Duplicate Prevention', () => {
  beforeAll(async () => {
    // Clean up any existing overage/credit rows for our dedicated test org (PostgREST only).
    const { error: overageCleanupError } = await supabase.from('usage_overage_events').delete().eq('org_id', ORG_ID_OVERAGE)
    expect(overageCleanupError).toBeNull()
    const { error: transactionCleanupError } = await supabase.from('usage_credit_transactions').delete().eq('org_id', ORG_ID_OVERAGE)
    expect(transactionCleanupError).toBeNull()
    const { error: consumptionCleanupError } = await supabase.from('usage_credit_consumptions').delete().eq('org_id', ORG_ID_OVERAGE)
    expect(consumptionCleanupError).toBeNull()
    const { error: grantCleanupError } = await supabase.from('usage_credit_grants').delete().eq('org_id', ORG_ID_OVERAGE)
    expect(grantCleanupError).toBeNull()
  })

  it('should not create duplicate overage records when called multiple times with same values', async () => {
    const testMetric = 'bandwidth' as const
    const overageAmount = 163066288 // Same value from the CSV data
    const billingStart = new Date('2025-10-07')
    const billingEnd = new Date('2025-11-07')
    const details = { limit: 53687091200, usage: 53850157488 }

    // Call apply_usage_overage 5 times with identical parameters
    for (let i = 0; i < 5; i++) {
      const { data, error } = await callRpc(() => supabase.rpc('apply_usage_overage', {
        p_org_id: ORG_ID_OVERAGE,
        p_metric: testMetric,
        p_overage_amount: overageAmount,
        p_billing_cycle_start: billingStart.toISOString(),
        p_billing_cycle_end: billingEnd.toISOString(),
        p_details: details,
      }))

      expect(error).toBeNull()
      expect(data).toBeDefined()
    }

    // Should only create 1 record, not 5
    expect(await countOverageEvents(testMetric, billingStart, billingEnd)).toBe(1)
  })

  it('should create new record when overage amount increases significantly', async () => {
    const testMetric = 'storage' as const
    const billingStart = new Date('2025-12-07')
    const billingEnd = new Date('2026-01-07')

    // First call with initial overage
    await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: 1000000,
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 10000000, usage: 11000000 },
    }))

    // Second call with significantly higher overage (>1% increase)
    await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: 2000000, // 100% increase
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 10000000, usage: 12000000 },
    }))

    expect(await countOverageEvents(testMetric, billingStart, billingEnd)).toBe(2)
  })

  it('should create new record when credits become available', async () => {
    const testMetric = 'mau' as const
    const billingStart = new Date('2025-12-01')
    const billingEnd = new Date('2026-01-01')
    const overageAmount = 10000

    // Grant some credits FIRST
    const { error: grantError } = await supabase.from('usage_credit_grants').insert({
      org_id: ORG_ID_OVERAGE,
      credits_total: 100,
      credits_consumed: 0,
      granted_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      source: 'manual',
      source_ref: { test: true },
    })
    expect(grantError).toBeNull()

    // Call with credits available - should apply them
    const { data: firstCall, error: firstError } = await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: overageAmount,
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 5000, usage: 15000 },
    }))

    expect(firstError).toBeNull()
    const firstResult = Array.isArray(firstCall) ? firstCall[0] : firstCall
    // Should have applied some credits
    expect(Number(firstResult?.credits_applied)).toBeGreaterThan(0)

    // Second call with same params - should NOT create new record (no new credits, same overage)
    const { error: secondError } = await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: overageAmount,
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 5000, usage: 15000 },
    }))

    expect(secondError).toBeNull()

    // Should only have 1 record since nothing changed
    expect(await countOverageEvents(testMetric, billingStart, billingEnd)).toBe(1)
  })

  it('should not create record when overage increases by less than 1%', async () => {
    const testMetric = 'build_time' as const
    const billingStart = new Date('2025-11-01')
    const billingEnd = new Date('2025-12-01')

    // First call
    await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: 100000,
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 1000000, usage: 1100000 },
    }))

    // Second call with tiny increase (0.5%)
    await callRpc(() => supabase.rpc('apply_usage_overage', {
      p_org_id: ORG_ID_OVERAGE,
      p_metric: testMetric,
      p_overage_amount: 100500, // Only 0.5% increase
      p_billing_cycle_start: billingStart.toISOString(),
      p_billing_cycle_end: billingEnd.toISOString(),
      p_details: { limit: 1000000, usage: 1100500 },
    }))

    expect(await countOverageEvents(testMetric, billingStart, billingEnd)).toBe(1)
  })
})
