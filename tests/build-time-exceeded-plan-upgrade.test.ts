import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { getDrizzleClient } from '../supabase/functions/_backend/utils/pg.ts'
import { checkPlanStatusOnly } from '../supabase/functions/_backend/utils/plans.ts'
import { cleanupPostgresClient, getPostgresClient, getSupabaseClient, TEST_EMAIL, USER_ID } from './test-utils.ts'

const MAKER_PRODUCT_ID = 'prod_LQIs1Yucml9ChU'
const TEAM_PRODUCT_ID = 'prod_LQIugvJcPrxhda'
const MAKER_BUILD_LIMIT = 7_200
const TEAM_BUILD_LIMIT = 36_000
const USAGE_OVER_MAKER_UNDER_TEAM = 8_000

const testRunId = randomUUID()
const ORG_ID = testRunId
const STRIPE_CUSTOMER_ID = `cus_build_upgrade_${testRunId.slice(0, 8)}`
const APPNAME = `com.build.upgrade.${testRunId.slice(0, 8)}`

function createContext(): Context {
  return {
    get: (key: string) => key === 'requestId' ? 'test-request-id' : undefined,
  } as Context
}

async function recomputePlanStatus() {
  const pool = await getPostgresClient()
  const client = await pool.connect()
  try {
    const drizzleClient = getDrizzleClient(client, { logger: false })
    await checkPlanStatusOnly(createContext(), ORG_ID, drizzleClient)
  }
  finally {
    client.release()
  }
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
  await supabase.from('app_metrics_cache').delete().eq('org_id', ORG_ID)

  const { error: buildTimeError } = await supabase.from('daily_build_time').insert({
    app_id: APPNAME,
    build_count: 3,
    build_time_unit: USAGE_OVER_MAKER_UNDER_TEAM,
    date: today,
  })
  if (buildTimeError)
    throw buildTimeError
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  const errors: unknown[] = []
  const track = (error: unknown) => {
    if (error)
      errors.push(error)
  }
  track((await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)).error)
  track((await supabase.from('apps').delete().eq('app_id', APPNAME)).error)
  track((await supabase.from('org_users').delete().eq('org_id', ORG_ID)).error)
  track((await supabase.from('orgs').delete().eq('id', ORG_ID)).error)
  track((await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)).error)
  await cleanupPostgresClient()
  if (errors.length)
    throw new AggregateError(errors, 'build-time-exceeded-plan-upgrade teardown failed')
})

async function isBuildTimeAllowed() {
  const { data, error } = await getSupabaseClient().rpc('is_allowed_action_org_action', {
    actions: ['build_time'],
    orgid: ORG_ID,
  })
  expect(error).toBeFalsy()
  return data
}

describe('build_time_exceeded after plan change recompute', () => {
  it('clears build_time_exceeded when usage fits the upgraded plan', async () => {
    const supabase = getSupabaseClient()

    expect(USAGE_OVER_MAKER_UNDER_TEAM).toBeGreaterThan(MAKER_BUILD_LIMIT)
    expect(USAGE_OVER_MAKER_UNDER_TEAM).toBeLessThan(TEAM_BUILD_LIMIT)

    const { error: makerStateError } = await supabase.from('stripe_info').update({
      is_good_plan: true,
      product_id: MAKER_PRODUCT_ID,
    }).eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(makerStateError).toBeFalsy()

    await recomputePlanStatus()

    const { data: makerFit } = await supabase.rpc('get_plan_usage_and_fit', { orgid: ORG_ID })
    expect(makerFit?.is_good_plan).toBe(false)

    const { data: onMakerBeforeUpgrade } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded, is_good_plan')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(onMakerBeforeUpgrade?.build_time_exceeded).toBe(true)
    expect(onMakerBeforeUpgrade?.is_good_plan).toBe(false)
    expect(await isBuildTimeAllowed()).toBe(false)

    const { error: upgradeError } = await supabase.from('stripe_info').update({
      product_id: TEAM_PRODUCT_ID,
    }).eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(upgradeError).toBeFalsy()

    const { data: teamFit } = await supabase.rpc('get_plan_usage_and_fit', { orgid: ORG_ID })
    expect(teamFit?.is_good_plan).toBe(true)

    await recomputePlanStatus()

    const { data: stripeInfo } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded, is_good_plan, product_id')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfo?.product_id).toBe(TEAM_PRODUCT_ID)
    expect(stripeInfo?.build_time_exceeded).toBe(false)
    expect(stripeInfo?.is_good_plan).toBe(true)
    expect(await isBuildTimeAllowed()).toBe(true)
  })

  it('keeps build_time_exceeded when usage is still over the new plan', async () => {
    const supabase = getSupabaseClient()
    const today = new Date().toISOString().split('T')[0]

    await supabase.from('daily_build_time').update({ build_time_unit: 10_000 }).eq('app_id', APPNAME).eq('date', today)

    const { error: teamStateError } = await supabase.from('stripe_info').update({
      build_time_exceeded: false,
      is_good_plan: true,
      product_id: TEAM_PRODUCT_ID,
    }).eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(teamStateError).toBeFalsy()

    const { error: downgradeError } = await supabase.from('stripe_info').update({
      product_id: MAKER_PRODUCT_ID,
    }).eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(downgradeError).toBeFalsy()

    await recomputePlanStatus()

    const { data: stripeInfo } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded, is_good_plan, product_id')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfo?.product_id).toBe(MAKER_PRODUCT_ID)
    expect(stripeInfo?.build_time_exceeded).toBe(true)
    expect(stripeInfo?.is_good_plan).toBe(false)
    expect(await isBuildTimeAllowed()).toBe(false)
  })
})