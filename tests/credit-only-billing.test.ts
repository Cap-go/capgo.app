import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  fetchTestRequest,
  getEndpointUrl,
  PRODUCT_ID,
  resetAndSeedAppData,
  resetAppData,
} from './test-utils.ts'

const id = randomUUID()
const orgId = randomUUID()
const appId = `com.test.credit_only.${id.replaceAll('-', '')}`
const stripeCustomerId = `cus_credit_only_${id.replaceAll('-', '').slice(0, 24)}`

const headers = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

describe('credit-only billing', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(appId, {
      orgId,
      stripeCustomerId,
      planProductId: PRODUCT_ID,
    })
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.usage_credit_consumptions WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_overage_events WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_credit_transactions WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_credit_grants WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.app_metrics_cache WHERE org_id = $1', [orgId])
    await resetAppData(appId)
    await executeSQL('DELETE FROM public.org_users WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.orgs WHERE id = $1', [orgId])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [stripeCustomerId])
  })

  it.concurrent('consumes credits for a former subscriber even when usage is under the old plan limit', async () => {
    await executeSQL('DELETE FROM public.usage_credit_consumptions WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_overage_events WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_credit_transactions WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.usage_credit_grants WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.app_metrics_cache WHERE org_id = $1', [orgId])
    await executeSQL('DELETE FROM public.daily_mau WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.daily_bandwidth WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.daily_build_time WHERE app_id = $1', [appId])

    await executeSQL(`
      UPDATE public.stripe_info
      SET
        status = 'failed',
        is_good_plan = true,
        trial_at = '1970-01-01T00:00:00+00:00',
        subscription_anchor_start = NOW() - interval '45 days',
        subscription_anchor_end = NOW() - interval '15 days',
        mau_exceeded = false,
        storage_exceeded = false,
        bandwidth_exceeded = false,
        build_time_exceeded = false
      WHERE customer_id = $1
    `, [stripeCustomerId])

    await executeSQL(`
      INSERT INTO public.daily_mau (app_id, date, mau)
      VALUES ($1, CURRENT_DATE, 10)
    `, [appId])

    await executeSQL(`
      INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        expires_at,
        source,
        notes
      )
      VALUES ($1, 100, 0, NOW() + interval '30 days', 'manual', 'former subscriber credit mode regression')
    `, [orgId])

    const response = await fetchTestRequest(getEndpointUrl('/triggers/cron_stat_org'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId, customerId: stripeCustomerId }),
    })

    expect(response.status).toBe(200)

    const creditRows = await executeSQL(`
      SELECT
        COALESCE(SUM(credits_consumed), 0)::numeric AS consumed
      FROM public.usage_credit_grants
      WHERE org_id = $1
    `, [orgId])
    expect(Number(creditRows[0]?.consumed ?? 0)).toBeGreaterThan(0)

    const overageRows = await executeSQL(`
      SELECT metric, overage_amount, credits_debited, details
      FROM public.usage_overage_events
      WHERE org_id = $1
      ORDER BY created_at DESC
    `, [orgId])
    expect(overageRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metric: 'mau',
        overage_amount: '10.000000',
        details: expect.objectContaining({ limit: 0, usage: 10 }),
      }),
    ]))

    const stripeRows = await executeSQL(`
      SELECT status, is_good_plan, mau_exceeded
      FROM public.stripe_info
      WHERE customer_id = $1
    `, [stripeCustomerId])
    expect(stripeRows[0]).toMatchObject({
      status: 'failed',
      is_good_plan: true,
      mau_exceeded: false,
    })
  })
})
