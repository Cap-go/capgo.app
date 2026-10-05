import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { executeSQL, getBaseData, getEndpointUrl, getSupabaseClient, postUpdate, resetAndSeedAppData, resetAppData, warmEdgeEndpoint } from './test-utils.ts'

describe('plugin plan gating: credits flag', () => {
  const supabase = getSupabaseClient()
  const orgId = randomUUID()
  const stripeCustomerId = `cus_missing_stripe_${orgId.replaceAll('-', '')}`
  const appId = `com.test.credits_flag.${orgId.replaceAll('-', '')}`

  beforeAll(async () => {
    await resetAndSeedAppData(appId, { orgId, stripeCustomerId })

    // Force the "plan" branch to fail: buildPlanValidationExpression joins stripe_info by customer_id.
    // Use direct SQL to avoid any RLS/service-key issues accidentally leaving the org "plan_valid".
    await executeSQL(
      'UPDATE public.stripe_info SET status = $1, is_good_plan = $2, trial_at = $3 WHERE customer_id = $4',
      ['canceled', false, '1970-01-01T00:00:00+00:00', stripeCustomerId],
    )

    // Ensure default state is "no credits flag".
    await executeSQL('UPDATE public.orgs SET has_usage_credits = false WHERE id = $1', [orgId])

    // Sanity checks: if these don't apply, the test may silently become a no-op and pass/fail randomly.
    const stripeRows = await executeSQL('SELECT status, is_good_plan, trial_at FROM public.stripe_info WHERE customer_id = $1', [stripeCustomerId])
    expect(stripeRows[0]?.status).toBe('canceled')
    expect(stripeRows[0]?.is_good_plan).toBe(false)
    const orgRows = await executeSQL('SELECT has_usage_credits FROM public.orgs WHERE id = $1', [orgId])
    expect(orgRows[0]?.has_usage_credits).toBe(false)

    // Cold /updates isolate can 503 under Cloudflare shard load; warm before assertions.
    await warmEdgeEndpoint(getEndpointUrl('/updates'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getBaseData(appId)),
    })
  })

  afterAll(async () => {
    await supabase.from('usage_credit_grants').delete().eq('org_id', orgId)
    await resetAppData(appId)
    await supabase.from('org_users').delete().eq('org_id', orgId)
    await supabase.from('orgs').delete().eq('id', orgId)
    await supabase.from('stripe_info').delete().eq('customer_id', stripeCustomerId)
  })

  it('blocks /updates for expired or exhausted credits', async () => {
    const baseData = getBaseData(appId)

    const responseBlocked = await postUpdate(baseData)
    expect(responseBlocked.status).toBe(429)
    const jsonBlocked = await responseBlocked.json<{ error?: string }>()
    expect(jsonBlocked.error).toBe('on_premise_app')

    await executeSQL(`
      INSERT INTO public.usage_credit_grants (
        org_id,
        credits_total,
        credits_consumed,
        expires_at,
        source,
        notes
      )
      VALUES ($1, 1, 0, now() - interval '1 day', 'manual', 'expired grant regression')
    `, [orgId])

    const expiredGrantRows = await executeSQL('SELECT has_usage_credits FROM public.orgs WHERE id = $1', [orgId])
    expect(expiredGrantRows[0]?.has_usage_credits).toBe(false)

    const responseExpiredGrant = await postUpdate({
      ...baseData,
      device_id: randomUUID().toLowerCase(),
    })
    expect(responseExpiredGrant.status).toBe(429)
    const jsonExpiredGrant = await responseExpiredGrant.json<{ error?: string }>()
    expect(jsonExpiredGrant.error).toBe('on_premise_app')

    await executeSQL(`
      UPDATE public.usage_credit_grants
      SET
        credits_consumed = credits_total,
        expires_at = now() + interval '1 day'
      WHERE org_id = $1
    `, [orgId])

    const exhaustedGrantRows = await executeSQL('SELECT has_usage_credits FROM public.orgs WHERE id = $1', [orgId])
    expect(exhaustedGrantRows[0]?.has_usage_credits).toBe(false)

    const responseExhaustedGrant = await postUpdate({
      ...baseData,
      device_id: randomUUID().toLowerCase(),
    })
    expect(responseExhaustedGrant.status).toBe(429)
    const jsonExhaustedGrant = await responseExhaustedGrant.json<{ error?: string }>()
    expect(jsonExhaustedGrant.error).toBe('on_premise_app')

    await executeSQL(`
      UPDATE public.usage_credit_grants
      SET
        credits_consumed = 0,
        expires_at = now() + interval '1 day'
      WHERE org_id = $1
    `, [orgId])

    const activeGrantRows = await executeSQL('SELECT has_usage_credits FROM public.orgs WHERE id = $1', [orgId])
    expect(activeGrantRows[0]?.has_usage_credits).toBe(true)

    const responseAllowed = await postUpdate({
      ...baseData,
      // Avoid any device-side caching behavior by changing device id.
      device_id: randomUUID().toLowerCase(),
    })
    expect(responseAllowed.status).toBe(200)
  })
})
