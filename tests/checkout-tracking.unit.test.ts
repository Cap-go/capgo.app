import { describe, expect, it } from 'vitest'
import { buildPlanCheckoutStartedBentoEvent, PLAN_CHECKOUT_STARTED_EVENT } from '../supabase/functions/_backend/utils/checkout_tracking.ts'

const base = {
  event: PLAN_CHECKOUT_STARTED_EVENT,
  orgId: 'org-1',
  orgName: 'Demo Org',
  productId: 'prod_demo',
  planName: 'Team',
  recurrence: 'year',
  checkoutSource: 'direct',
  currentPlanName: 'Maker',
  planPrice: 999,
  planPriceMonthly: 99,
  planPriceYearly: 999,
}

describe('buildPlanCheckoutStartedBentoEvent', () => {
  it.concurrent('builds a billing-audience Bento payload for a checkout start', () => {
    const r = buildPlanCheckoutStartedBentoEvent(base)
    expect(r).toBeDefined()
    expect(r!.event).toBe('user:checkout_started')
    expect(r!.preferenceKey).toBe('credit_usage')
    expect(r!.audience).toBe('billing')
    expect(r!.cron).toBe('* * * * *')
    expect(r!.uniqId).toBe('checkout_started:prod_demo:year')
    expect(r!.data).toMatchObject({
      org_id: 'org-1',
      org_name: 'Demo Org',
      product_id: 'prod_demo',
      plan_name: 'Team',
      plan_type: 'yearly',
      recurrence: 'year',
      checkout_source: 'direct',
      current_plan_name: 'Maker',
      plan_price: 999,
      plan_price_monthly: 99,
      plan_price_yearly: 999,
    })
  })

  it.concurrent('returns undefined for other event names or missing org ids', () => {
    expect(buildPlanCheckoutStartedBentoEvent({ ...base, event: 'Checkout Created' })).toBeUndefined()
    expect(buildPlanCheckoutStartedBentoEvent({ ...base, orgId: undefined })).toBeUndefined()
  })

  it.concurrent('normalizes missing optional fields', () => {
    const r = buildPlanCheckoutStartedBentoEvent({
      ...base,
      orgName: undefined,
      productId: undefined,
      planName: undefined,
      recurrence: undefined,
      checkoutSource: undefined,
      currentPlanName: undefined,
      planPrice: undefined,
      planPriceMonthly: undefined,
      planPriceYearly: undefined,
    })
    expect(r).toBeDefined()
    expect(r!.uniqId).toBe('checkout_started::unknown')
    expect(r!.data).toMatchObject({
      org_name: '',
      product_id: '',
      plan_name: '',
      plan_type: 'unknown',
      recurrence: 'unknown',
      checkout_source: 'plans',
      current_plan_name: '',
      plan_price: 0,
      plan_price_monthly: 0,
      plan_price_yearly: 0,
    })
  })
})
