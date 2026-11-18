import type { Context } from 'hono'
import type Stripe from 'stripe'
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { stripeEventTestUtils } from '../supabase/functions/_backend/triggers/stripe_event.ts'
import { extractDataEvent } from '../supabase/functions/_backend/utils/stripe_event.ts'
import { cleanupPostgresClient, getSupabaseClient, POSTGRES_URL, TEST_EMAIL, USER_ID } from './test-utils.ts'

vi.mock('../supabase/functions/_backend/utils/tracking.ts', () => ({
  sendEventToTracking: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/posthog.ts', () => ({
  groupIdentifyPosthog: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare_cache_purge.ts', () => ({
  purgeOnPremCacheForOrg: vi.fn().mockResolvedValue(undefined),
  purgePlanCacheForOrg: vi.fn().mockResolvedValue(undefined),
}))

const { createdOrUpdated, shouldRecomputePlanStatusAfterStripeSubscriptionChange } = stripeEventTestUtils

const MAKER_PRODUCT_ID = 'prod_LQIs1Yucml9ChU'
const TEAM_PRODUCT_ID = 'prod_LQIugvJcPrxhda'
const MAKER_MONTHLY_PRICE_ID = 'price_1KjSGyGH46eYKnWwL4h14DsK'
const TEAM_MONTHLY_PRICE_ID = 'price_1KjSIUGH46eYKnWwWHvg8XYs'
const MAKER_BUILD_LIMIT = 7_200
const TEAM_BUILD_LIMIT = 36_000
const USAGE_OVER_MAKER_UNDER_TEAM = 8_000

const testRunId = randomUUID()
const ORG_ID = testRunId
const SUBSCRIPTION_ID = `sub_build_upgrade_${testRunId.slice(0, 8)}`
const STRIPE_CUSTOMER_ID = `cus_build_upgrade_${testRunId.slice(0, 8)}`
const APPNAME = `com.build.upgrade.${testRunId.slice(0, 8)}`

function resolveBackendDbUrl(): string {
  const raw = process.env.SUPABASE_DB_URL ?? POSTGRES_URL
  if (!raw.includes('tinbase-no-tcp'))
    return POSTGRES_URL
  const pidFile = resolve(process.cwd(), '.tinbase', 'pgdata', 'postmaster.pid')
  if (!existsSync(pidFile))
    throw new Error(`Tinbase Postgres socket not found (${pidFile} is missing)`)
  const socketDir = readFileSync(pidFile, 'utf8').split('\n')[4]?.trim()
  if (!socketDir)
    throw new Error(`Tinbase postmaster.pid has no socket directory: ${pidFile}`)
  return `postgresql://postgres@/postgres?host=${encodeURIComponent(socketDir)}`
}

const BACKEND_DB_URL = resolveBackendDbUrl()

function createBackendContext(stripeEventId: string): Context {
  const variables = new Map<string, unknown>([
    ['requestId', 'build-time-exceeded-plan-upgrade'],
    ['stripeEvent', { id: stripeEventId, type: 'customer.subscription.updated' }],
  ])
  return {
    env: {
      SUPABASE_DB_URL: BACKEND_DB_URL,
      CAPGO_PREVENT_BACKGROUND_FUNCTIONS: 'true',
    },
    get: (key: string) => variables.get(key),
    set: (key: string, value: unknown) => {
      variables.set(key, value)
    },
    req: { header: () => undefined, raw: { headers: new Headers() } },
    res: { headers: new Headers() },
  } as unknown as Context
}

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
  }
}

function makeSubscriptionUpdatedEvent(
  currentPriceId: string,
  currentProductId: string,
  previousPriceId: string,
  previousProductId: string,
): Stripe.CustomerSubscriptionUpdatedEvent {
  return {
    data: {
      object: {
        customer: STRIPE_CUSTOMER_ID,
        id: SUBSCRIPTION_ID,
        items: {
          data: [makeSubscriptionItem(currentPriceId, currentProductId)],
        },
        status: 'active',
      },
      previous_attributes: {
        items: {
          data: [makeSubscriptionItem(previousPriceId, previousProductId)],
        },
      },
    },
    type: 'customer.subscription.updated',
  } as Stripe.CustomerSubscriptionUpdatedEvent
}

async function invokeCreatedOrUpdated(
  currentPriceId: string,
  currentProductId: string,
  previousPriceId: string,
  previousProductId: string,
  stripeEventId = `evt_${randomUUID()}`,
) {
  const c = createBackendContext(stripeEventId)
  const stripeEvent = makeSubscriptionUpdatedEvent(
    currentPriceId,
    currentProductId,
    previousPriceId,
    previousProductId,
  )
  const stripeData = extractDataEvent(c, stripeEvent)
  expect(shouldRecomputePlanStatusAfterStripeSubscriptionChange(stripeData)).toBe(true)
  const supabase = getSupabaseClient()
  const { data: org, error: orgError } = await supabase.from('orgs').select('*').eq('id', ORG_ID).single()
  if (orgError)
    throw orgError
  const { data: currentStripeInfo, error: stripeInfoError } = await supabase
    .from('stripe_info')
    .select('*')
    .eq('customer_id', STRIPE_CUSTOMER_ID)
    .single()
  if (stripeInfoError)
    throw stripeInfoError
  const eventOccurredAtIso = new Date().toISOString()
  await createdOrUpdated(c, stripeData, org!, currentStripeInfo, eventOccurredAtIso, 'updated')
}

beforeAll(async () => {
  process.env.SUPABASE_DB_URL = BACKEND_DB_URL
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
    subscription_id: SUBSCRIPTION_ID,
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

  const { error: versionError } = await supabase.from('app_versions').insert({
    app_id: APPNAME,
    name: '1.0.0',
    owner_org: ORG_ID,
    user_id: USER_ID,
    storage_provider: 'r2-direct',
  })
  if (versionError)
    throw versionError
})

beforeEach(async () => {
  const supabase = getSupabaseClient()
  const today = new Date().toISOString().split('T')[0]

  await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)
  await supabase.from('app_metrics_cache').delete().eq('org_id', ORG_ID)
  await supabase.from('processed_stripe_events').delete().eq('customer_id', STRIPE_CUSTOMER_ID)

  const { error: stripeError } = await supabase.from('stripe_info').update({
    bandwidth_exceeded: false,
    build_time_exceeded: true,
    is_good_plan: false,
    last_stripe_event_at: null,
    mau_exceeded: false,
    price_id: MAKER_MONTHLY_PRICE_ID,
    product_id: MAKER_PRODUCT_ID,
    storage_exceeded: false,
  }).eq('customer_id', STRIPE_CUSTOMER_ID)
  if (stripeError)
    throw stripeError

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
  track((await supabase.from('app_versions').delete().eq('app_id', APPNAME)).error)
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

describe('build_time_exceeded after Stripe createdOrUpdated plan change', () => {
  it('clears build_time_exceeded when usage fits the upgraded plan', async () => {
    const supabase = getSupabaseClient()

    expect(USAGE_OVER_MAKER_UNDER_TEAM).toBeGreaterThan(MAKER_BUILD_LIMIT)
    expect(USAGE_OVER_MAKER_UNDER_TEAM).toBeLessThan(TEAM_BUILD_LIMIT)

    const { data: makerFitRows, error: makerFitError } = await supabase.rpc('get_plan_usage_and_fit', { orgid: ORG_ID })
    expect(makerFitError).toBeFalsy()
    expect(makerFitRows?.[0]?.is_good_plan).toBe(false)
    expect(await isBuildTimeAllowed()).toBe(false)

    const { data: stuckFlags } = await supabase
      .from('stripe_info')
      .select('build_time_exceeded')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    expect(stuckFlags?.build_time_exceeded).toBe(true)

    await invokeCreatedOrUpdated(
      TEAM_MONTHLY_PRICE_ID,
      TEAM_PRODUCT_ID,
      MAKER_MONTHLY_PRICE_ID,
      MAKER_PRODUCT_ID,
    )

    const { data: teamFitRows, error: teamFitError } = await supabase.rpc('get_plan_usage_and_fit', { orgid: ORG_ID })
    expect(teamFitError).toBeFalsy()
    expect(teamFitRows?.[0]?.is_good_plan).toBe(true)

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
      price_id: TEAM_MONTHLY_PRICE_ID,
      product_id: TEAM_PRODUCT_ID,
    }).eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(teamStateError).toBeFalsy()

    await invokeCreatedOrUpdated(
      MAKER_MONTHLY_PRICE_ID,
      MAKER_PRODUCT_ID,
      TEAM_MONTHLY_PRICE_ID,
      TEAM_PRODUCT_ID,
    )

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