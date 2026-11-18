import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'
import { getSupabaseClient, TEST_EMAIL, USER_ID } from './test-utils.ts'

const MAKER_PRODUCT_ID = 'prod_LQIs1Yucml9ChU'
const TEAM_PRODUCT_ID = 'prod_LQIugvJcPrxhda'
const MAKER_MONTHLY_PRICE_ID = 'price_1KjSGyGH46eYKnWwL4h14DsK'
const TEAM_MONTHLY_PRICE_ID = 'price_1KjSIUGH46eYKnWwWHvg8XYs'

const testRunId = randomUUID()
const ORG_ID = testRunId
const STRIPE_CUSTOMER_ID = `cus_build_upgrade_${testRunId.slice(0, 8)}`
const APPNAME = `com.build.upgrade.${testRunId.slice(0, 8)}`

const mockContext = {
  get: () => 'test-request-id',
} as any

function makeSubscriptionItem(priceId: string, productId: string) {
  return {
    current_period_end: Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60,
    current_period_start: Math.floor(Date.now() / 1000) - 15 * 24 * 60 * 60,
    plan: {
      id: priceId,
      interval: 'month',
      product: productId,
      usage_type: 'licensed',
    },
  } as const
}

beforeAll(async () => {
  const supabase = getSupabaseClient()

  const { error: stripeError } = await supabase.from('stripe_info').insert({
    bandwidth_exceeded: false,
    build_time_exceeded: false,
    customer_id: STRIPE_CUSTOMER_ID,
    is_good_plan: true,
    mau_exceeded: false,
    plan_usage: 50,
    product_id: MAKER_PRODUCT_ID,
    status: 'succeeded' as const,
    storage_exceeded: false,
    subscription_anchor_end: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    subscription_anchor_start: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
    subscription_id: `sub_build_upgrade_${testRunId.slice(0, 8)}`,
    trial_at: new Date(0).toISOString(),
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await supabase.from('orgs').insert({
    created_by: USER_ID,
    customer_id: STRIPE_CUSTOMER_ID,
    id: ORG_ID,
    management_email: TEST_EMAIL,
    name: `Build upgrade org ${testRunId.slice(0, 8)}`,
  })
  if (orgError)
    throw orgError

  const { error: orgUserError } = await supabase.from('org_users').insert({
    org_id: ORG_ID,
    rbac_role_name: 'org_super_admin',
    user_id: USER_ID,
  })
  if (orgUserError)
    throw orgUserError

  const { error: appError } = await supabase.from('apps').insert({
    app_id: APPNAME,
    icon_url: 'https://example.com/icon.png',
    name: 'Build upgrade app',
    owner_org: ORG_ID,
  })
  if (appError)
    throw appError
})

beforeEach(async () => {
  const supabase = getSupabaseClient()
  const today = new Date().toISOString().split('T')[0]

  await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)
  await supabase.from('build_logs').delete().eq('org_id', ORG_ID)
  await supabase.from('app_metrics_cache').delete().eq('org_id', ORG_ID)

  const { error: stripeError } = await supabase.from('stripe_info').update({
    bandwidth_exceeded: false,
    build_time_exceeded: true,
    is_good_plan: true,
    mau_exceeded: false,
    product_id: MAKER_PRODUCT_ID,
    storage_exceeded: false,
  }).eq('customer_id', STRIPE_CUSTOMER_ID)
  if (stripeError)
    throw stripeError

  const { error: buildTimeError } = await supabase.from('daily_build_time').insert({
    app_id: APPNAME,
    build_count: 3,
    build_time_unit: 4_435,
    date: today,
  })
  if (buildTimeError)
    throw buildTimeError
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)
  await supabase.from('apps').delete().eq('app_id', APPNAME)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)
  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
})

async function applySubscriptionWebhookStripeInfo() {
  const stripeData = extractDataEvent(mockContext, {
    data: {
      object: {
        customer: STRIPE_CUSTOMER_ID,
        id: `sub_build_upgrade_${testRunId.slice(0, 8)}`,
        items: {
          data: [makeSubscriptionItem(TEAM_MONTHLY_PRICE_ID, TEAM_PRODUCT_ID)],
        },
        status: 'active',
      },
      previous_attributes: {
        items: {
          data: [makeSubscriptionItem(MAKER_MONTHLY_PRICE_ID, MAKER_PRODUCT_ID)],
        },
      },
    },
    type: 'customer.subscription.updated',
  } as any)

  const { data } = stripeData
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('stripe_info').update({
    bandwidth_exceeded: data.bandwidth_exceeded,
    build_time_exceeded: data.build_time_exceeded,
    is_good_plan: data.is_good_plan,
    mau_exceeded: data.mau_exceeded,
    price_id: data.price_id,
    product_id: data.product_id,
    storage_exceeded: data.storage_exceeded,
    subscription_anchor_end: data.subscription_anchor_end,
    subscription_anchor_start: data.subscription_anchor_start,
    subscription_id: data.subscription_id,
  }).eq('customer_id', STRIPE_CUSTOMER_ID)
  if (error)
    throw error
}

describe('build_time_exceeded after plan upgrade', () => {
  it('clears build_time_exceeded on subscription upgrade webhook payload and allows native builds', async () => {
    const supabase = getSupabaseClient()

    const { data: stuckState } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded, is_good_plan, product_id')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(stuckState?.build_time_exceeded).toBe(true)
    expect(stuckState?.is_good_plan).toBe(true)
    expect(stuckState?.product_id).toBe(MAKER_PRODUCT_ID)

    await applySubscriptionWebhookStripeInfo()

    const { data: stripeInfoAfterUpgrade } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded, is_good_plan, product_id')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfoAfterUpgrade?.product_id).toBe(TEAM_PRODUCT_ID)
    expect(stripeInfoAfterUpgrade?.is_good_plan).toBe(true)
    expect(stripeInfoAfterUpgrade?.build_time_exceeded).toBe(false)

    const { data: buildAllowed, error: buildAllowedError } = await supabase.rpc('is_allowed_action_org_action', {
      actions: ['build_time'],
      orgid: ORG_ID,
    })
    expect(buildAllowedError).toBeFalsy()
    expect(buildAllowed).toBe(true)
  })
})