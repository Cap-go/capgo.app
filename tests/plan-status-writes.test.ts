import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { updatePlanStatus } from '../supabase/functions/_backend/utils/plans.ts'
import { cleanupPostgresClient, getPostgresClient, getSupabaseClient, PRODUCT_ID } from './test-utils.ts'

const customerId = `cus_plan_status_${randomUUID().slice(0, 8)}`

describe('conditional plan status writes', () => {
  beforeAll(async () => {
    await getSupabaseClient().from('stripe_info').insert({
      bandwidth_exceeded: false,
      build_time_exceeded: false,
      customer_id: customerId,
      is_above_plan: false,
      is_good_plan: true,
      mau_exceeded: false,
      plan_usage: 0,
      product_id: PRODUCT_ID,
      status: 'succeeded',
      storage_exceeded: false,
      subscription_anchor_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_anchor_start: new Date().toISOString(),
      subscription_id: `sub_plan_status_${randomUUID().slice(0, 8)}`,
      trial_at: new Date(0).toISOString(),
    }).throwOnError()
  })

  afterAll(async () => {
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId).throwOnError()
    await cleanupPostgresClient()
  })

  it('updates all calculated fields once and preserves the row version when they stay unchanged', async () => {
    const pool = await getPostgresClient()
    const client = await pool.connect()
    try {
      const drizzleClient = getDrizzleClient(client, { logger: false })
      const org = { customer_id: customerId }
      const result = {
        exceededFlags: {
          bandwidth_exceeded: false,
          build_time_exceeded: true,
          mau_exceeded: true,
          storage_exceeded: false,
        },
        finalIsGoodPlan: false,
      }
      const usage = {
        bandwidth_percent: 20,
        build_time_percent: 101,
        mau_percent: 130,
        storage_percent: 10,
        total_percent: 130,
      }

      const initial = await client.query<{ row_version: string }>(`
        SELECT xmin::text AS row_version
        FROM public.stripe_info
        WHERE customer_id = $1
      `, [customerId])

      await updatePlanStatus(org, result, true, usage, drizzleClient)

      const changed = await client.query<{
        bandwidth_exceeded: boolean
        build_time_exceeded: boolean
        is_above_plan: boolean
        is_good_plan: boolean
        mau_exceeded: boolean
        plan_usage: string
        row_version: string
        storage_exceeded: boolean
      }>(`
        SELECT bandwidth_exceeded,
               build_time_exceeded,
               is_above_plan,
               is_good_plan,
               mau_exceeded,
               plan_usage::text AS plan_usage,
               xmin::text AS row_version,
               storage_exceeded
        FROM public.stripe_info
        WHERE customer_id = $1
      `, [customerId])

      expect(changed.rows[0]).toMatchObject({
        bandwidth_exceeded: false,
        build_time_exceeded: true,
        is_above_plan: true,
        is_good_plan: false,
        mau_exceeded: true,
        plan_usage: '130',
        storage_exceeded: false,
      })
      expect(changed.rows[0]?.row_version).not.toBe(initial.rows[0]?.row_version)

      await updatePlanStatus(org, result, true, usage, drizzleClient)

      const unchanged = await client.query<{ row_version: string }>(`
        SELECT xmin::text AS row_version
        FROM public.stripe_info
        WHERE customer_id = $1
      `, [customerId])
      expect(unchanged.rows[0]?.row_version).toBe(changed.rows[0]?.row_version)
    }
    finally {
      client.release()
    }
  })
})
