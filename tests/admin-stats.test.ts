import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { Hono } from 'hono/tiny'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { logsnagInsightsTestUtils } from '../supabase/functions/_backend/triggers/logsnag_insights.ts'
import { REQUIRED_GLOBAL_STATS_SHARDS } from '../supabase/functions/_backend/utils/global_stats.ts'
import { getAdminGlobalStatsTrend, getAdminOnboardingFunnel } from '../supabase/functions/_backend/utils/pg.ts'
import { BASE_URL, executeSQL, fetchTestRequest, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, POSTGRES_URL, PRODUCT_ID, resetAndSeedAppData, resetAppData, TEST_EMAIL, USER_ADMIN_EMAIL, USER_ID, USER_PASSWORD_HASH } from './test-utils.ts'

const DAY_IN_MS = 24 * 60 * 60 * 1000
const NOW = Date.now()

const TRIAL_ORG_ID = randomUUID()
const TRIAL_CUSTOMER_ID = `cus_admin_stats_trial_${TRIAL_ORG_ID.slice(0, 8)}`
const TRIAL_APP_ID = `com.admin.stats.trial.${TRIAL_ORG_ID.slice(0, 8)}`
const TRIAL_ORG_CREATED_AT = new Date(NOW).toISOString()
const TRIAL_END_DATE = new Date(NOW + (45 * DAY_IN_MS)).toISOString()
const TRIAL_LAST_UPLOAD_AT = new Date(NOW - DAY_IN_MS).toISOString()
const TRIAL_BUILTIN_UPLOAD_AT = new Date(NOW - (12 * 60 * 60 * 1000)).toISOString()
const INSIGHTS_DATE = '2026-04-10'
const INSIGHTS_START = '2026-04-01T00:00:00.000Z'
const INSIGHTS_END = '2026-04-30T23:59:59.000Z'
const INSIGHTS_UPLOAD_AT = '2026-04-10T10:00:00.000Z'
const INSIGHTS_LAST_BUILD_AT = '2026-04-11T12:00:00.000Z'
const INSIGHTS_BUILD_ID = `admin-stats-build-${TRIAL_ORG_ID.slice(0, 8)}`
const ATTENTION_SORT_HEALTHY_ORG_ID = randomUUID()
const ATTENTION_SORT_HEALTHY_CUSTOMER_ID = `cus_admin_stats_attention_sort_${ATTENTION_SORT_HEALTHY_ORG_ID.slice(0, 8)}`
const ATTENTION_SORT_TOKEN = `attention-sort-${TRIAL_ORG_ID.slice(0, 8)}`
const ATTENTION_SORT_HEALTHY_ORG_CREATED_AT = new Date(NOW + DAY_IN_MS).toISOString()

const CANCELLED_YEARLY_ORG_ID = randomUUID()
const CANCELLED_YEARLY_CUSTOMER_ID = `cus_admin_stats_cancelled_yearly_${CANCELLED_YEARLY_ORG_ID.slice(0, 8)}`
const CANCELLED_YEARLY_PAID_AT = '2025-02-10T12:00:00.000Z'

const CANCELLED_MONTHLY_ORG_ID = randomUUID()
const CANCELLED_MONTHLY_CUSTOMER_ID = `cus_admin_stats_cancelled_monthly_${CANCELLED_MONTHLY_ORG_ID.slice(0, 8)}`

const ONBOARDING_ORG_ID = randomUUID()
const ONBOARDING_CUSTOMER_ID = `cus_admin_stats_onboarding_${ONBOARDING_ORG_ID.slice(0, 8)}`
const ONBOARDING_APP_ID = `com.admin.stats.onboarding.${ONBOARDING_ORG_ID.slice(0, 8)}`
const ONBOARDING_ORG_CREATED_AT = '2026-02-01T10:00:00.000Z'
const ONBOARDING_APP_CREATED_AT = '2026-02-02T10:00:00.000Z'
const ONBOARDING_CHANNEL_CREATED_AT = '2026-02-03T10:00:00.000Z'
const ONBOARDING_BUNDLE_CREATED_AT = '2026-02-04T10:00:00.000Z'
const ONBOARDING_PAID_AT = '2026-02-05T10:00:00.000Z'

const ONBOARDING_NO_BUNDLE_ORG_ID = randomUUID()
const ONBOARDING_NO_BUNDLE_CUSTOMER_ID = `cus_admin_stats_onboarding_nobundle_${ONBOARDING_NO_BUNDLE_ORG_ID.slice(0, 8)}`
const ONBOARDING_NO_BUNDLE_CREATED_AT = '2026-02-01T12:00:00.000Z'
const ONBOARDING_NO_BUNDLE_PAID_AT = '2026-02-06T10:00:00.000Z'

const ONBOARDING_LATE_SUBSCRIPTION_ORG_ID = randomUUID()
const ONBOARDING_LATE_SUBSCRIPTION_CUSTOMER_ID = `cus_admin_stats_onboarding_latesub_${ONBOARDING_LATE_SUBSCRIPTION_ORG_ID.slice(0, 8)}`
const ONBOARDING_LATE_SUBSCRIPTION_APP_ID = `com.admin.stats.onboarding.latesub.${ONBOARDING_LATE_SUBSCRIPTION_ORG_ID.slice(0, 8)}`
const ONBOARDING_LATE_SUBSCRIPTION_CREATED_AT = '2026-02-01T14:00:00.000Z'
const ONBOARDING_LATE_SUBSCRIPTION_APP_CREATED_AT = '2026-02-02T14:00:00.000Z'
const ONBOARDING_LATE_SUBSCRIPTION_CHANNEL_CREATED_AT = '2026-02-03T14:00:00.000Z'
const ONBOARDING_LATE_SUBSCRIPTION_BUNDLE_CREATED_AT = '2026-02-04T14:00:00.000Z'
const ONBOARDING_LATE_SUBSCRIPTION_PAID_AT = '2026-02-10T14:00:00.000Z'
const ONBOARDING_REGISTER_USER_IDS = [
  randomUUID(),
  randomUUID(),
  randomUUID(),
  randomUUID(),
] as const
const ONBOARDING_INVITE_USER_ID = randomUUID()
const ONBOARDING_WITHOUT_PROFILE_USER_ID = randomUUID()
const ONBOARDING_END_BOUNDARY_USER_ID = randomUUID()
const ONBOARDING_INVITE_ORG_ID = randomUUID()
const ONBOARDING_INVITE_CUSTOMER_ID = `cus_admin_stats_onboarding_invite_${ONBOARDING_INVITE_ORG_ID.slice(0, 8)}`
const ONBOARDING_REGISTER_CREATED_AT = '2026-02-01T09:00:00.000Z'
const ONBOARDING_WITHOUT_PROFILE_CREATED_AT = '2026-02-01T09:30:00.000Z'
const ONBOARDING_END_BOUNDARY_CREATED_AT = '2026-02-02T00:00:00.000Z'
const GLOBAL_STATS_TREND_DATES = ['2099-12-30', '2099-12-31', '2100-01-01'] as const

type AdminStatsTestApp = Hono<{ Bindings: { SUPABASE_DB_URL: string } }>

async function requestDirectAdminStats<T>(registerRoute: (app: AdminStatsTestApp) => void): Promise<T> {
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
    expect(response.status).toBe(200)
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
  return requestDirectAdminStats<{
    abovePlanWithCredits: number
    abovePlanWithoutCredits: number
  }>(app => {
    app.get('/', async c => c.json(await logsnagInsightsTestUtils.getCoreSnapshotCounts(c, snapshotExclusiveEnd)))
  })
}

async function getBillingSnapshotCountsAt(snapshotExclusiveEnd: Date) {
  return requestDirectAdminStats<{
    plans: Record<string, number>
  }>(app => {
    app.get('/', async c => c.json(await logsnagInsightsTestUtils.getBillingSnapshotCounts(c, snapshotExclusiveEnd)))
  })
}

async function getOnboardingFunnelDirect(startDate: string, endDate: string) {
  return requestDirectAdminStats<Awaited<ReturnType<typeof getAdminOnboardingFunnel>>>(app => {
    app.get('/', async c => c.json(await getAdminOnboardingFunnel(c, startDate, endDate)))
  })
}

async function getGlobalStatsTrendDirect(startDate: string, endDate: string) {
  return requestDirectAdminStats<Awaited<ReturnType<typeof getAdminGlobalStatsTrend>>>(app => {
    app.get('/', async c => c.json(await getAdminGlobalStatsTrend(c, startDate, endDate)))
  })
}

let adminHeaders: Record<string, string>
let soloPlan: {
  name: string
  price_m_id: string
  price_y_id: string
  stripe_id: string
} | null = null
let creatorUserCreatedAt = ''

beforeAll(async () => {
  const supabase = getSupabaseClient()

  adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, 'adminadmin')

  const [{ data: planRow, error: planError }, { data: userRow, error: userError }] = await Promise.all([
    supabase.from('plans').select('name, price_m_id, price_y_id, stripe_id').eq('stripe_id', PRODUCT_ID).single(),
    supabase.from('users').select('created_at').eq('id', USER_ID).single(),
  ])

  if (planError)
    throw planError
  if (userError)
    throw userError
  if (!planRow)
    throw new Error('Expected Solo plan to exist for admin stats tests')
  if (!userRow?.created_at)
    throw new Error('Expected creator user to exist for admin stats tests')

  soloPlan = planRow
  creatorUserCreatedAt = new Date(userRow.created_at).toISOString()

  const { error: globalStatsError } = await supabase.from('global_stats').upsert([
    {
      date_id: GLOBAL_STATS_TREND_DATES[0],
      apps: 10,
      apps_created: 2,
      versions_created: 5,
      apps_with_cli_onboarding_builds_24h: 1,
      apps_with_manual_builds_24h: 0,
      apps_active: 7,
      users: 20,
      users_active: 8,
      paying: 4,
      org_conversion_rate: 20,
      trial: 2,
      not_paying: 14,
      updates: 100,
      updates_external: 5,
      success_rate: 98.5,
      bundle_storage_gb: 1.25,
      plan_solo: 1,
      plan_maker: 2,
      plan_team: 1,
      plan_enterprise: 0,
      plan_credits: 1,
      registers_today: 3,
      devices_last_month: 9,
      stars: 1,
      need_upgrade: 0,
      above_plan_with_credits: null,
      above_plan_without_credits: null,
      paying_yearly: 1,
      paying_monthly: 3,
      new_paying_orgs: 1,
      canceled_orgs: 0,
      upgraded_orgs: 0,
      trial_extended_orgs: 1,
      trial_extended_subscribed_orgs: 0,
      past_due_orgs: 1,
      past_due_orgs_average_days: 2.5,
      mrr: 120,
      total_revenue: 1440,
      revenue_solo: 120,
      revenue_maker: 240,
      revenue_team: 1080,
      revenue_enterprise: 0,
    },
    {
      date_id: GLOBAL_STATS_TREND_DATES[1],
      apps: 11,
      apps_created: 3,
      versions_created: 8,
      apps_with_cli_onboarding_builds_24h: 2,
      apps_with_manual_builds_24h: 1,
      apps_active: 8,
      users: 22,
      users_active: 9,
      paying: 5,
      org_conversion_rate: 22.7,
      trial: 2,
      not_paying: 15,
      updates: 150,
      updates_external: 10,
      success_rate: 99.1,
      bundle_storage_gb: 1.5,
      plan_solo: 2,
      plan_maker: 2,
      plan_team: 1,
      plan_enterprise: 0,
      plan_credits: 3,
      registers_today: 4,
      devices_last_month: 12,
      stars: 2,
      need_upgrade: 1,
      above_plan_with_credits: 4,
      above_plan_without_credits: 2,
      paying_yearly: 2,
      paying_monthly: 3,
      new_paying_orgs: 2,
      canceled_orgs: 1,
      upgraded_orgs: 1,
      trial_extended_orgs: 3,
      trial_extended_subscribed_orgs: 2,
      past_due_orgs: 2,
      past_due_orgs_average_days: 3.75,
      mrr: 240,
      total_revenue: 2880,
      revenue_solo: 240,
      revenue_maker: 480,
      revenue_team: 2160,
      revenue_enterprise: 0,
    },
    {
      date_id: GLOBAL_STATS_TREND_DATES[2],
      apps: 12,
      apps_created: 0,
      versions_created: 0,
      apps_with_cli_onboarding_builds_24h: 0,
      apps_with_manual_builds_24h: 0,
      apps_active: 0,
      users: 0,
      users_active: 0,
      paying: 0,
      org_conversion_rate: 0,
      trial: 0,
      not_paying: 0,
      updates: 160,
      updates_external: 0,
      success_rate: 0,
      bundle_storage_gb: 0,
      plan_solo: 0,
      plan_maker: 0,
      plan_team: 0,
      plan_enterprise: 0,
      plan_credits: 0,
      registers_today: 0,
      devices_last_month: 0,
      stars: 3,
      need_upgrade: 0,
      above_plan_with_credits: null,
      above_plan_without_credits: null,
      paying_yearly: 0,
      paying_monthly: 0,
      new_paying_orgs: 0,
      canceled_orgs: 0,
      upgraded_orgs: 0,
      trial_extended_orgs: 0,
      trial_extended_subscribed_orgs: 0,
      past_due_orgs: 0,
      past_due_orgs_average_days: 0,
      mrr: 0,
      total_revenue: 0,
      revenue_solo: 0,
      revenue_maker: 0,
      revenue_team: 0,
      revenue_enterprise: 0,
    },
  ], { onConflict: 'date_id' })
  if (globalStatsError)
    throw globalStatsError

  await executeSQL(
    'UPDATE public.global_stats SET completed_shards = $1::jsonb WHERE date_id = ANY($2::varchar[])',
    [JSON.stringify(REQUIRED_GLOBAL_STATS_SHARDS), [...GLOBAL_STATS_TREND_DATES]],
  )

  const { error: stripeError } = await supabase.from('stripe_info').insert([
    {
      customer_id: TRIAL_CUSTOMER_ID,
      status: 'created',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      trial_at: TRIAL_END_DATE,
      is_good_plan: false,
      plan_usage: 2,
      subscription_anchor_start: '2026-04-01T00:00:00.000Z',
      subscription_anchor_end: '2026-05-01T00:00:00.000Z',
    },
    {
      customer_id: ATTENTION_SORT_HEALTHY_CUSTOMER_ID,
      status: 'created',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      trial_at: TRIAL_END_DATE,
      is_good_plan: false,
      plan_usage: 2,
      subscription_anchor_start: '2026-04-01T00:00:00.000Z',
      subscription_anchor_end: '2026-05-01T00:00:00.000Z',
    },
    {
      customer_id: CANCELLED_YEARLY_CUSTOMER_ID,
      status: 'canceled',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_y_id,
      subscription_id: null,
      trial_at: '2025-03-01T00:00:00.000Z',
      canceled_at: '2026-03-25T14:00:00.000Z',
      paid_at: CANCELLED_YEARLY_PAID_AT,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2025-02-10T00:00:00.000Z',
      subscription_anchor_end: '2025-03-10T00:00:00.000Z',
    },
    {
      customer_id: CANCELLED_MONTHLY_CUSTOMER_ID,
      status: 'canceled',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      subscription_id: null,
      trial_at: '2026-03-01T00:00:00.000Z',
      canceled_at: '2026-03-20T08:00:00.000Z',
      churn_reason: 'past_due_unresolved',
      paid_at: null,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2026-02-15T00:00:00.000Z',
      subscription_anchor_end: '2026-03-15T00:00:00.000Z',
    },
    {
      customer_id: ONBOARDING_CUSTOMER_ID,
      status: 'succeeded',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      subscription_id: null,
      trial_at: '2026-02-20T00:00:00.000Z',
      paid_at: ONBOARDING_PAID_AT,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2026-02-05T00:00:00.000Z',
      subscription_anchor_end: '2026-03-05T00:00:00.000Z',
    },
    {
      customer_id: ONBOARDING_NO_BUNDLE_CUSTOMER_ID,
      status: 'succeeded',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      subscription_id: null,
      trial_at: '2026-02-20T00:00:00.000Z',
      paid_at: ONBOARDING_NO_BUNDLE_PAID_AT,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2026-02-06T00:00:00.000Z',
      subscription_anchor_end: '2026-03-06T00:00:00.000Z',
    },
    {
      customer_id: ONBOARDING_LATE_SUBSCRIPTION_CUSTOMER_ID,
      status: 'succeeded',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      subscription_id: null,
      trial_at: '2026-02-20T00:00:00.000Z',
      paid_at: ONBOARDING_LATE_SUBSCRIPTION_PAID_AT,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2026-02-10T00:00:00.000Z',
      subscription_anchor_end: '2026-03-10T00:00:00.000Z',
    },
    {
      customer_id: ONBOARDING_INVITE_CUSTOMER_ID,
      status: 'succeeded',
      product_id: soloPlan.stripe_id,
      price_id: soloPlan.price_m_id,
      subscription_id: null,
      trial_at: '2026-02-20T00:00:00.000Z',
      paid_at: null,
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: '2026-02-01T00:00:00.000Z',
      subscription_anchor_end: '2026-03-01T00:00:00.000Z',
    },
  ])
  if (stripeError)
    throw stripeError

  for (const [index, userId] of ONBOARDING_REGISTER_USER_IDS.entries()) {
    const email = `admin-stats-onboarding-register-${index}-${userId.slice(0, 8)}@capgo.app`
    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [userId, email, USER_PASSWORD_HASH, ONBOARDING_REGISTER_CREATED_AT],
    )
    await executeSQL(
      `INSERT INTO public.users (id, email, created_at, updated_at, created_via_invite)
       VALUES ($1, $2, $3::timestamptz, $3::timestamptz, false)
       ON CONFLICT (id) DO UPDATE SET
         email = EXCLUDED.email,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         created_via_invite = EXCLUDED.created_via_invite`,
      [userId, email, ONBOARDING_REGISTER_CREATED_AT],
    )
  }

  const inviteEmail = `admin-stats-onboarding-invite-${ONBOARDING_INVITE_USER_ID.slice(0, 8)}@capgo.app`
  await executeSQL(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
     VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [ONBOARDING_INVITE_USER_ID, inviteEmail, USER_PASSWORD_HASH, ONBOARDING_REGISTER_CREATED_AT],
  )
  await executeSQL(
    `INSERT INTO public.users (id, email, created_at, updated_at, created_via_invite)
     VALUES ($1, $2, $3::timestamptz, $3::timestamptz, true)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       created_at = EXCLUDED.created_at,
       updated_at = EXCLUDED.updated_at,
       created_via_invite = EXCLUDED.created_via_invite`,
    [ONBOARDING_INVITE_USER_ID, inviteEmail, ONBOARDING_REGISTER_CREATED_AT],
  )

  for (const [userId, email, createdAt] of [
    [ONBOARDING_WITHOUT_PROFILE_USER_ID, `admin-stats-onboarding-without-profile-${ONBOARDING_WITHOUT_PROFILE_USER_ID.slice(0, 8)}@capgo.app`, ONBOARDING_WITHOUT_PROFILE_CREATED_AT],
    [ONBOARDING_END_BOUNDARY_USER_ID, `admin-stats-onboarding-end-boundary-${ONBOARDING_END_BOUNDARY_USER_ID.slice(0, 8)}@capgo.app`, ONBOARDING_END_BOUNDARY_CREATED_AT],
  ] as const) {
    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [userId, email, USER_PASSWORD_HASH, createdAt],
    )
  }

  const { error: orgError } = await supabase.from('orgs').insert([
    {
      id: TRIAL_ORG_ID,
      name: `Admin Stats Trial ${ATTENTION_SORT_TOKEN}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: TRIAL_CUSTOMER_ID,
      created_at: TRIAL_ORG_CREATED_AT,
    },
    {
      id: ATTENTION_SORT_HEALTHY_ORG_ID,
      name: `Admin Stats Healthy ${ATTENTION_SORT_TOKEN}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: ATTENTION_SORT_HEALTHY_CUSTOMER_ID,
      created_at: ATTENTION_SORT_HEALTHY_ORG_CREATED_AT,
    },
    {
      id: CANCELLED_YEARLY_ORG_ID,
      name: `Admin Stats Cancelled Yearly ${CANCELLED_YEARLY_ORG_ID.slice(0, 8)}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: CANCELLED_YEARLY_CUSTOMER_ID,
    },
    {
      id: CANCELLED_MONTHLY_ORG_ID,
      name: `Admin Stats Cancelled Monthly ${CANCELLED_MONTHLY_ORG_ID.slice(0, 8)}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: CANCELLED_MONTHLY_CUSTOMER_ID,
    },
    {
      id: ONBOARDING_ORG_ID,
      name: `Admin Stats Onboarding ${ONBOARDING_ORG_ID.slice(0, 8)}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: ONBOARDING_CUSTOMER_ID,
      created_at: ONBOARDING_ORG_CREATED_AT,
    },
    {
      id: ONBOARDING_NO_BUNDLE_ORG_ID,
      name: `Admin Stats Onboarding No Bundle ${ONBOARDING_NO_BUNDLE_ORG_ID.slice(0, 8)}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: ONBOARDING_NO_BUNDLE_CUSTOMER_ID,
      created_at: ONBOARDING_NO_BUNDLE_CREATED_AT,
    },
    {
      id: ONBOARDING_LATE_SUBSCRIPTION_ORG_ID,
      name: `Admin Stats Onboarding Late Subscription ${ONBOARDING_LATE_SUBSCRIPTION_ORG_ID.slice(0, 8)}`,
      created_by: USER_ID,
      management_email: TEST_EMAIL,
      customer_id: ONBOARDING_LATE_SUBSCRIPTION_CUSTOMER_ID,
      created_at: ONBOARDING_LATE_SUBSCRIPTION_CREATED_AT,
    },
    {
      id: ONBOARDING_INVITE_ORG_ID,
      name: `Admin Stats Onboarding Invite ${ONBOARDING_INVITE_ORG_ID.slice(0, 8)}`,
      created_by: ONBOARDING_INVITE_USER_ID,
      management_email: inviteEmail,
      customer_id: ONBOARDING_INVITE_CUSTOMER_ID,
      created_at: ONBOARDING_ORG_CREATED_AT,
    },
  ])
  if (orgError)
    throw orgError

  const { error: onboardingAnswerError } = await supabase
    .from('orgs')
    .update({ onboarding: { starting_out: false } })
    .eq('id', ONBOARDING_ORG_ID)
  if (onboardingAnswerError)
    throw onboardingAnswerError

  const { error: inviteOnboardingAnswerError } = await supabase
    .from('orgs')
    .update({ onboarding: { starting_out: true } })
    .eq('id', ONBOARDING_INVITE_ORG_ID)
  if (inviteOnboardingAnswerError)
    throw inviteOnboardingAnswerError

  const { error: appError } = await supabase.from('apps').insert({
    owner_org: TRIAL_ORG_ID,
    name: 'Admin Stats Trial App',
    app_id: TRIAL_APP_ID,
    icon_url: 'https://example.com/icon.png',
  })
  if (appError)
    throw appError

  const { error: onboardingAppError } = await supabase.from('apps').insert({
    owner_org: ONBOARDING_ORG_ID,
    name: 'Admin Stats Onboarding App',
    app_id: ONBOARDING_APP_ID,
    icon_url: 'https://example.com/icon.png',
    created_at: ONBOARDING_APP_CREATED_AT,
  })
  if (onboardingAppError)
    throw onboardingAppError

  const { error: onboardingLateSubscriptionAppError } = await supabase.from('apps').insert({
    owner_org: ONBOARDING_LATE_SUBSCRIPTION_ORG_ID,
    name: 'Admin Stats Onboarding Late Subscription App',
    app_id: ONBOARDING_LATE_SUBSCRIPTION_APP_ID,
    icon_url: 'https://example.com/icon.png',
    created_at: ONBOARDING_LATE_SUBSCRIPTION_APP_CREATED_AT,
  })
  if (onboardingLateSubscriptionAppError)
    throw onboardingLateSubscriptionAppError

  const { data: versionRows, error: versionError } = await supabase.from('app_versions').insert([
    {
      app_id: TRIAL_APP_ID,
      name: '1.0.0',
      owner_org: TRIAL_ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      created_at: TRIAL_LAST_UPLOAD_AT,
    },
    {
      app_id: TRIAL_APP_ID,
      name: 'builtin',
      owner_org: TRIAL_ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      created_at: TRIAL_BUILTIN_UPLOAD_AT,
    },
    {
      app_id: TRIAL_APP_ID,
      name: '2.0.0',
      owner_org: TRIAL_ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      created_at: INSIGHTS_UPLOAD_AT,
    },
    {
      app_id: ONBOARDING_APP_ID,
      name: '1.0.0',
      owner_org: ONBOARDING_ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      created_at: ONBOARDING_BUNDLE_CREATED_AT,
    },
    {
      app_id: ONBOARDING_LATE_SUBSCRIPTION_APP_ID,
      name: '1.0.0',
      owner_org: ONBOARDING_LATE_SUBSCRIPTION_ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      created_at: ONBOARDING_LATE_SUBSCRIPTION_BUNDLE_CREATED_AT,
    },
  ]).select('id, app_id, name')
  if (versionError)
    throw versionError

  const onboardingVersion = versionRows?.find(version => version.app_id === ONBOARDING_APP_ID && version.name === '1.0.0')
  if (!onboardingVersion)
    throw new Error('Expected onboarding app version to be created')

  const onboardingLateSubscriptionVersion = versionRows?.find(version => version.app_id === ONBOARDING_LATE_SUBSCRIPTION_APP_ID && version.name === '1.0.0')
  if (!onboardingLateSubscriptionVersion)
    throw new Error('Expected onboarding late subscription app version to be created')

  const insightsVersion = versionRows?.find(version => version.app_id === TRIAL_APP_ID && version.name === '2.0.0')
  if (!insightsVersion)
    throw new Error('Expected organization insights app version to be created')

  const { error: channelError } = await supabase.from('channels').insert([
    {
      name: 'production',
      app_id: ONBOARDING_APP_ID,
      version: onboardingVersion.id,
      created_by: USER_ID,
      owner_org: ONBOARDING_ORG_ID,
      created_at: ONBOARDING_CHANNEL_CREATED_AT,
    },
    {
      name: 'production',
      app_id: ONBOARDING_LATE_SUBSCRIPTION_APP_ID,
      version: onboardingLateSubscriptionVersion.id,
      created_by: USER_ID,
      owner_org: ONBOARDING_LATE_SUBSCRIPTION_ORG_ID,
      created_at: ONBOARDING_LATE_SUBSCRIPTION_CHANNEL_CREATED_AT,
    },
  ])
  if (channelError)
    throw channelError

  const { error: dailyMauError } = await supabase.from('daily_mau').insert({
    app_id: TRIAL_APP_ID,
    date: INSIGHTS_DATE,
    mau: 7,
  })
  if (dailyMauError)
    throw dailyMauError

  const { error: dailyVersionError } = await supabase.from('daily_version').insert({
    app_id: TRIAL_APP_ID,
    date: INSIGHTS_DATE,
    version_id: insightsVersion.id,
    version_name: '2.0.0',
    get: 5,
    fail: 2,
    install: 8,
    uninstall: 0,
  })
  if (dailyVersionError)
    throw dailyVersionError

  const { error: buildLogError } = await supabase.from('build_logs').insert({
    org_id: TRIAL_ORG_ID,
    user_id: USER_ID,
    build_id: INSIGHTS_BUILD_ID,
    platform: 'ios',
    billable_seconds: 180,
    build_time_unit: 180,
    app_id: TRIAL_APP_ID,
    created_at: INSIGHTS_LAST_BUILD_AT,
  })
  if (buildLogError)
    throw buildLogError

  const { error: orgUserError } = await supabase.from('org_users').insert({
    org_id: TRIAL_ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_admin',
  })
  if (orgUserError)
    throw orgUserError

  await executeSQL(
    `INSERT INTO public.role_bindings (
       principal_type, principal_id, role_id, scope_type, org_id,
       granted_by, granted_at, reason, is_direct
     )
     SELECT
       public.rbac_principal_user(),
       $1::uuid,
       roles.id,
       public.rbac_scope_org(),
       $2::uuid,
       $1::uuid,
       $3::timestamptz,
       'Accepted invitation',
       true
     FROM public.roles
     WHERE roles.name = public.rbac_role_org_member()
       AND roles.scope_type = public.rbac_scope_org()
     LIMIT 1
     ON CONFLICT DO NOTHING`,
    [ONBOARDING_INVITE_USER_ID, ONBOARDING_ORG_ID, ONBOARDING_REGISTER_CREATED_AT],
  )

  await executeSQL(
    `INSERT INTO public.role_bindings (
       principal_type, principal_id, role_id, scope_type, org_id,
       granted_by, granted_at, reason, is_direct
     )
     SELECT
       public.rbac_principal_user(),
       $1::uuid,
       roles.id,
       public.rbac_scope_org(),
       $2::uuid,
       $1::uuid,
       $3::timestamptz,
       'Accepted invitation',
       true
     FROM public.roles
     WHERE roles.name = public.rbac_role_org_member()
       AND roles.scope_type = public.rbac_scope_org()
     LIMIT 1
     ON CONFLICT DO NOTHING`,
    [USER_ID, ONBOARDING_INVITE_ORG_ID, ONBOARDING_REGISTER_CREATED_AT],
  )
}, 90000)

afterAll(async () => {
  const supabase = getSupabaseClient()

  await executeSQL(
    `DELETE FROM public.role_bindings
     WHERE reason = 'Accepted invitation'
       AND (
         (principal_id = $1::uuid AND org_id = $2::uuid)
         OR (principal_id = $3::uuid AND org_id = $4::uuid)
       )`,
    [ONBOARDING_INVITE_USER_ID, ONBOARDING_ORG_ID, USER_ID, ONBOARDING_INVITE_ORG_ID],
  )
  await supabase.from('org_users').delete().eq('org_id', TRIAL_ORG_ID).eq('user_id', USER_ID)
  await supabase.from('build_logs').delete().eq('org_id', TRIAL_ORG_ID).eq('build_id', INSIGHTS_BUILD_ID)
  await supabase.from('daily_build_time').delete().eq('app_id', TRIAL_APP_ID).eq('date', INSIGHTS_DATE)
  await supabase.from('daily_version').delete().eq('app_id', TRIAL_APP_ID).eq('date', INSIGHTS_DATE)
  await supabase.from('daily_mau').delete().eq('app_id', TRIAL_APP_ID).eq('date', INSIGHTS_DATE)
  await supabase.from('global_stats').delete().in('date_id', [...GLOBAL_STATS_TREND_DATES])
  await supabase.from('channels').delete().in('app_id', [ONBOARDING_APP_ID, ONBOARDING_LATE_SUBSCRIPTION_APP_ID])
  await supabase.from('app_versions').delete().in('app_id', [TRIAL_APP_ID, ONBOARDING_APP_ID, ONBOARDING_LATE_SUBSCRIPTION_APP_ID])
  await supabase.from('apps').delete().in('app_id', [TRIAL_APP_ID, ONBOARDING_APP_ID, ONBOARDING_LATE_SUBSCRIPTION_APP_ID])
  await supabase.from('orgs').delete().in('id', [TRIAL_ORG_ID, ATTENTION_SORT_HEALTHY_ORG_ID, CANCELLED_YEARLY_ORG_ID, CANCELLED_MONTHLY_ORG_ID, ONBOARDING_ORG_ID, ONBOARDING_NO_BUNDLE_ORG_ID, ONBOARDING_LATE_SUBSCRIPTION_ORG_ID, ONBOARDING_INVITE_ORG_ID])
  await supabase.from('stripe_info').delete().in('customer_id', [TRIAL_CUSTOMER_ID, ATTENTION_SORT_HEALTHY_CUSTOMER_ID, CANCELLED_YEARLY_CUSTOMER_ID, CANCELLED_MONTHLY_CUSTOMER_ID, ONBOARDING_CUSTOMER_ID, ONBOARDING_NO_BUNDLE_CUSTOMER_ID, ONBOARDING_LATE_SUBSCRIPTION_CUSTOMER_ID, ONBOARDING_INVITE_CUSTOMER_ID])
  await executeSQL(
    'DELETE FROM public.users WHERE id = ANY($1::uuid[])',
    [[...ONBOARDING_REGISTER_USER_IDS, ONBOARDING_INVITE_USER_ID, ONBOARDING_WITHOUT_PROFILE_USER_ID, ONBOARDING_END_BOUNDARY_USER_ID]],
  )
  await executeSQL(
    'DELETE FROM auth.users WHERE id = ANY($1::uuid[])',
    [[...ONBOARDING_REGISTER_USER_IDS, ONBOARDING_INVITE_USER_ID, ONBOARDING_WITHOUT_PROFILE_USER_ID, ONBOARDING_END_BOUNDARY_USER_ID]],
  )
}, 90000)

describe('global stats core snapshots', () => {
  it.concurrent('counts just-over-limit orgs after plan usage rounds to 100', async () => {
    const snapshotExclusiveEnd = new Date('2030-01-02T00:00:00.000Z')
    const beforeSnapshot = '2029-12-01T00:00:00.000Z'
    const afterSnapshot = '2030-02-01T00:00:00.000Z'
    const withCreditsOrgId = randomUUID()
    const withoutCreditsOrgId = randomUUID()
    const withCreditsAppId = `com.admin.stats.credit.with.${withCreditsOrgId.slice(0, 8)}`
    const withoutCreditsAppId = `com.admin.stats.credit.without.${withoutCreditsOrgId.slice(0, 8)}`
    const withCreditsCustomerId = `cus_admin_stats_credit_with_${withCreditsOrgId.slice(0, 8)}`
    const withoutCreditsCustomerId = `cus_admin_stats_credit_without_${withoutCreditsOrgId.slice(0, 8)}`
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
            plan_calculated_at = $2::timestamptz,
            paid_at = $2::timestamptz,
            canceled_at = NULL,
            subscription_anchor_end = $3::timestamptz
        WHERE customer_id = ANY($1::text[])
      `, [customerIds, beforeSnapshot, afterSnapshot])

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
    const creditOnlyAppId = `com.admin.stats.plan.credits.only.${creditOnlyOrgId.slice(0, 8)}`
    const planPlusCreditsAppId = `com.admin.stats.plan.credits.sub.${planPlusCreditsOrgId.slice(0, 8)}`
    const consumedAppId = `com.admin.stats.plan.credits.consumed.${consumedOrgId.slice(0, 8)}`
    const trialPlusCreditsAppId = `com.admin.stats.plan.credits.trial.${trialPlusCreditsOrgId.slice(0, 8)}`
    const creditOnlyCustomerId = `cus_admin_stats_plan_credits_only_${creditOnlyOrgId.slice(0, 8)}`
    const planPlusCreditsCustomerId = `cus_admin_stats_plan_credits_sub_${planPlusCreditsOrgId.slice(0, 8)}`
    const consumedCustomerId = `cus_admin_stats_plan_credits_consumed_${consumedOrgId.slice(0, 8)}`
    const trialPlusCreditsCustomerId = `cus_admin_stats_plan_credits_trial_${trialPlusCreditsOrgId.slice(0, 8)}`
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

  it.concurrent('exposes plan_credits on global stats trend rows', async () => {
    const data = await getGlobalStatsTrendDirect('2099-12-30T00:00:00.000Z', '2099-12-31T23:59:59.000Z')
    const historical = data.find(row => row.date === GLOBAL_STATS_TREND_DATES[0])
    const latest = data.find(row => row.date === GLOBAL_STATS_TREND_DATES[1])

    expect(historical?.plan_credits).toBe(1)
    expect(latest?.plan_credits).toBe(3)
  })
})

describe('/private/admin_stats', () => {
  it('returns global stats trend rows from the self-joined global_stats table', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'global_stats_trend',
        start_date: '2099-12-30T00:00:00.000Z',
        end_date: '2099-12-31T23:59:59.000Z',
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: Array<{
        date: string
        apps: number
        apps_created: number
        versions_created: number
        apps_with_cli_onboarding_builds_24h: number
        apps_with_manual_builds_24h: number
        app_build_onboarding_finalized: boolean
        updates: number
        updates_external: number
        previous_mrr: number
        trial_extended_orgs: number
        trial_extended_subscribed_orgs: number
        past_due_orgs: number
        past_due_orgs_average_days: number
        above_plan_with_credits: number | null
        above_plan_without_credits: number | null
        plan_credits: number
      }>
    }

    expect(payload.success).toBe(true)
    expect(payload.data).toHaveLength(2)

    const historical = payload.data.find(row => row.date === GLOBAL_STATS_TREND_DATES[0])
    expect(historical?.above_plan_with_credits).toBeNull()
    expect(historical?.above_plan_without_credits).toBeNull()
    expect(historical?.plan_credits).toBe(1)

    const latest = payload.data.find(row => row.date === GLOBAL_STATS_TREND_DATES[1])
    expect(latest).toBeTruthy()
    expect(latest?.apps).toBe(11)
    expect(latest?.apps_created).toBe(3)
    expect(latest?.versions_created).toBe(8)
    expect(latest?.apps_with_cli_onboarding_builds_24h).toBe(2)
    expect(latest?.app_build_onboarding_finalized).toBe(true)
    expect(latest?.apps_with_manual_builds_24h).toBe(1)
    expect(latest?.updates).toBe(150)
    expect(latest?.past_due_orgs).toBe(2)
    expect(latest?.past_due_orgs_average_days).toBe(3.75)
    expect(latest?.updates_external).toBe(10)
    expect(latest?.previous_mrr).toBe(120)
    expect(latest?.trial_extended_orgs).toBe(3)
    expect(latest?.trial_extended_subscribed_orgs).toBe(2)
    expect(latest?.above_plan_with_credits).toBe(4)
    expect(latest?.above_plan_without_credits).toBe(2)
    expect(latest?.plan_credits).toBe(3)
  })

  it('returns last bundle upload for trial organizations and excludes builtin versions', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'trial_organizations',
        start_date: '2026-04-02T00:00:00.000Z',
        end_date: '2026-04-02T00:00:00.000Z',
        limit: 100,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        organizations: Array<{
          org_id: string
          plan_name: string | null
          last_bundle_upload_at: string | null
          trial_extension_count: number
        }>
      }
    }

    expect(payload.success).toBe(true)
    const organization = payload.data.organizations.find(org => org.org_id === TRIAL_ORG_ID)
    expect(organization).toBeTruthy()
    expect(organization?.plan_name).toBe(soloPlan?.name)
    expect(organization?.last_bundle_upload_at).toBe(TRIAL_LAST_UPLOAD_AT)
    expect(organization?.trial_extension_count).toBe(2)
  })

  it('returns organization insights with plan filtering and preprocessed period usage', async () => {
    if (!soloPlan)
      throw new Error('Expected Solo plan to be loaded')

    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'organization_insights',
        start_date: INSIGHTS_START,
        end_date: INSIGHTS_END,
        plan_name: soloPlan.name,
        billing_type: 'monthly',
        limit: 100,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        organizations: Array<{
          org_id: string
          plan_name: string | null
          billing_type: 'monthly' | 'yearly' | null
          upload_count: number
          build_count: number
          failed_update_count: number
          install_count: number
          update_attempt_count: number
          needs_attention: boolean
          fail_rate: number
          mau: number
          members_count: number
          last_build_at: string | null
        }>
        plan_options: string[]
      }
    }

    expect(payload.success).toBe(true)
    expect(payload.data.plan_options).toContain(soloPlan.name)

    const organization = payload.data.organizations.find(org => org.org_id === TRIAL_ORG_ID)
    expect(organization).toBeTruthy()
    expect(organization?.plan_name).toBe(soloPlan.name)
    expect(organization?.billing_type).toBe('monthly')
    expect(organization?.upload_count).toBe(1)
    expect(organization?.build_count).toBe(1)
    expect(organization?.failed_update_count).toBe(2)
    expect(organization?.install_count).toBe(8)
    expect(organization?.update_attempt_count).toBe(10)
    expect(organization?.needs_attention).toBe(true)
    expect(organization?.fail_rate).toBe(20)
    expect(organization?.mau).toBe(7)
    expect(organization?.members_count).toBe(1)
    expect(organization?.last_build_at).toBe(INSIGHTS_LAST_BUILD_AT)

    const paidOnlyResponse = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'organization_insights',
        start_date: INSIGHTS_START,
        end_date: INSIGHTS_END,
        plan_name: soloPlan.name,
        billing_type: 'monthly',
        paid_only: true,
        search: TRIAL_ORG_ID,
        limit: 100,
        offset: 0,
      }),
    })

    expect(paidOnlyResponse.status).toBe(200)
    const paidOnlyPayload = await paidOnlyResponse.json() as {
      success: boolean
      data: {
        organizations: Array<{ org_id: string }>
        total: number
      }
    }

    expect(paidOnlyPayload.success).toBe(true)
    expect(paidOnlyPayload.data.organizations).toEqual([])
    expect(paidOnlyPayload.data.total).toBe(0)
  })

  it('prioritizes organizations needing attention before pagination', async () => {
    if (!soloPlan)
      throw new Error('Expected Solo plan to be loaded')

    const response = await fetchTestRequest(getEndpointUrl('/private/admin_stats'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'organization_insights',
        start_date: INSIGHTS_START,
        end_date: INSIGHTS_END,
        plan_name: soloPlan.name,
        billing_type: 'monthly',
        search: ATTENTION_SORT_TOKEN,
        limit: 1,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        organizations: Array<{
          org_id: string
          needs_attention: boolean
        }>
        total: number
      }
    }

    expect(payload.success).toBe(true)
    expect(payload.data.total).toBe(2)
    expect(payload.data.organizations).toHaveLength(1)
    expect(payload.data.organizations[0]?.org_id).toBe(TRIAL_ORG_ID)
    expect(payload.data.organizations[0]?.needs_attention).toBe(true)
  })

  it('returns cancellation billing metadata and subscription-or-signup dates', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'cancelled_users',
        start_date: '2026-01-01T00:00:00.000Z',
        end_date: '2026-12-31T23:59:59.000Z',
        limit: 100,
        offset: 0,
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        organizations: Array<{
          org_id: string
          plan_name: string | null
          billing_type: 'monthly' | 'yearly' | null
          cancellation_reason: string | null
          subscription_or_signup_date: string
        }>
      }
    }

    expect(payload.success).toBe(true)

    const yearlyOrganization = payload.data.organizations.find(org => org.org_id === CANCELLED_YEARLY_ORG_ID)
    expect(yearlyOrganization).toBeTruthy()
    expect(yearlyOrganization?.plan_name).toBe('Solo')
    expect(yearlyOrganization?.billing_type).toBe('yearly')
    expect(yearlyOrganization?.subscription_or_signup_date).toBe(CANCELLED_YEARLY_PAID_AT)

    const monthlyOrganization = payload.data.organizations.find(org => org.org_id === CANCELLED_MONTHLY_ORG_ID)
    expect(monthlyOrganization).toBeTruthy()
    expect(monthlyOrganization?.plan_name).toBe('Solo')
    expect(monthlyOrganization?.cancellation_reason).toBe('Failed to resolve past due')
    expect(monthlyOrganization?.billing_type).toBe('monthly')
    expect(monthlyOrganization?.subscription_or_signup_date).toBe(creatorUserCreatedAt)
  })

  it('returns subscribed as the last onboarding funnel step without exceeding the bundle cohort', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'onboarding_funnel',
        start_date: '2026-02-01T00:00:00.000Z',
        end_date: '2026-02-02T00:00:00.000Z',
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        total_registrations: number
        total_orgs: number
        orgs_with_app: number
        orgs_with_channel: number
        orgs_with_bundle: number
        orgs_subscribed: number
        orgs_with_production_device: number
        orgs_with_update_download: number
        activation_telemetry_available: boolean
        total_invite_registrations: number
        total_org_joins_invite_register: number
        total_org_joins_existing_account: number
        org_conversion_rate: number
        subscription_conversion_rate: number
        trend: Array<{
          date: string
          new_registrations: number
          new_orgs: number
          orgs_subscribed: number
          orgs_with_production_device: number
          orgs_with_update_download: number
        }>
        invite_trend: Array<{
          date: string
          invite_registrations: number
          org_joins_invite_register: number
          org_joins_existing_account: number
        }>
        registration_source_trend: Array<{
          date: string
          normal_registrations: number
          invite_registrations: number
          without_profile: number
        }>
        starting_out_trend: Array<{
          date: string
          starting_out_true: number
          starting_out_false: number
        }>
      }
    }

    expect(payload.success).toBe(true)
    expect(payload.data.total_registrations).toBe(4)
    expect(payload.data.total_orgs).toBe(3)
    expect(payload.data.orgs_with_app).toBe(2)
    expect(payload.data.orgs_with_channel).toBe(2)
    expect(payload.data.orgs_with_bundle).toBe(2)
    expect(payload.data.orgs_subscribed).toBe(1)
    expect(payload.data.orgs_with_production_device).toBe(0)
    expect(payload.data.orgs_with_update_download).toBe(0)
    expect(payload.data.activation_telemetry_available).toBe(false)
    expect(payload.data.org_conversion_rate).toBe(75)
    expect(payload.data.subscription_conversion_rate).toBe(50)
    expect(payload.data.total_invite_registrations).toBe(1)
    expect(payload.data.total_org_joins_invite_register).toBe(1)
    expect(payload.data.total_org_joins_existing_account).toBe(1)
    expect(payload.data.trend).toHaveLength(1)
    expect(payload.data.trend[0]).toMatchObject({
      date: '2026-02-01',
      new_registrations: 4,
      new_orgs: 3,
      orgs_subscribed: 1,
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
    })
    expect(payload.data.invite_trend).toHaveLength(1)
    expect(payload.data.invite_trend[0]).toMatchObject({
      date: '2026-02-01',
      invite_registrations: 1,
      org_joins_invite_register: 1,
      org_joins_existing_account: 1,
    })
    expect(payload.data.starting_out_trend).toEqual([{
      date: '2026-02-01',
      starting_out_true: 0,
      starting_out_false: 1,
    }])
  })

  it('returns every auth registration in exactly one daily profile bucket', async () => {
    const data = await getOnboardingFunnelDirect(
      '2026-02-01T00:00:00.000Z',
      '2026-02-04T00:00:00.000Z',
    )

    expect(data.registration_source_trend).toEqual([
      {
        date: '2026-02-01',
        normal_registrations: 4,
        invite_registrations: 1,
        without_profile: 1,
      },
      {
        date: '2026-02-02',
        normal_registrations: 0,
        invite_registrations: 0,
        without_profile: 1,
      },
      {
        date: '2026-02-03',
        normal_registrations: 0,
        invite_registrations: 0,
        without_profile: 0,
      },
    ])

    const exclusiveEndData = await getOnboardingFunnelDirect(
      '2026-02-01T00:00:00.000Z',
      ONBOARDING_END_BOUNDARY_CREATED_AT,
    )

    expect(exclusiveEndData.registration_source_trend).toEqual([
      {
        date: '2026-02-01',
        normal_registrations: 4,
        invite_registrations: 1,
        without_profile: 1,
      },
    ])
    expect(exclusiveEndData.registration_source_trend.some(row => row.date === '2026-02-02')).toBe(false)
  })

  it.concurrent('returns daily starting-out answers and excludes missing or non-boolean values', async () => {
    const supabase = getSupabaseClient()
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const orgs = [
      { id: randomUUID(), created_at: '2096-08-14T08:00:00.000Z', onboarding: { starting_out: true } },
      { id: randomUUID(), created_at: '2096-08-14T09:00:00.000Z', onboarding: { starting_out: true } },
      { id: randomUUID(), created_at: '2096-08-14T10:00:00.000Z', onboarding: { starting_out: false } },
      { id: randomUUID(), created_at: '2096-08-14T11:00:00.000Z', onboarding: { intent: 'ota' } },
      { id: randomUUID(), created_at: '2096-08-14T12:00:00.000Z', onboarding: { starting_out: 'true' } },
      { id: randomUUID(), created_at: '2096-08-15T08:00:00.000Z', onboarding: { starting_out: false } },
    ]

    try {
      const { error } = await supabase.from('orgs').insert(orgs.map((org, index) => ({
        ...org,
        created_by: USER_ID,
        name: `Admin starting out ${suffix} ${index}`,
        management_email: `admin-starting-out-${suffix}-${index}@capgo.app`,
      })))
      if (error)
        throw error

      const data = await getOnboardingFunnelDirect(
        '2096-08-14T00:00:00.000Z',
        '2096-08-16T00:00:00.000Z',
      )

      expect(data.starting_out_trend).toEqual([
        {
          date: '2096-08-14',
          starting_out_true: 2,
          starting_out_false: 1,
        },
        {
          date: '2096-08-15',
          starting_out_true: 0,
          starting_out_false: 1,
        },
      ])
    }
    finally {
      await supabase.from('orgs').delete().in('id', orgs.map(org => org.id))
    }
  })

  it('returns a daily breakdown of app onboarding methods and CLI outcomes', async () => {
    const supabase = getSupabaseClient()
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const createdAt = '2097-08-14T10:00:00.000Z'
    const apps = [
      { app_id: `com.admin.onboard.manual.${suffix}`, source: 'manual', outcome: 'in_progress' },
      { app_id: `com.admin.onboard.cli.${suffix}`, source: 'cli', outcome: 'completed' },
      { app_id: `com.admin.onboard.cliwip.${suffix}`, source: 'cli', outcome: 'in_progress' },
      { app_id: `com.admin.onboard.mcp.${suffix}`, source: 'mcp', outcome: 'skipped' },
      { app_id: `com.admin.onboard.ai.${suffix}`, source: 'ai', outcome: 'switched_to_manual' },
    ]

    try {
      const { error } = await supabase.from('apps').insert(apps.map(app => ({
        owner_org: ONBOARDING_ORG_ID,
        name: `Admin onboarding ${app.app_id}`,
        app_id: app.app_id,
        icon_url: 'https://example.com/icon.png',
        created_at: createdAt,
        onboarding: {
          setup: {
            source: app.source,
            outcome: app.outcome,
            steps: {},
          },
        },
      })))
      if (error)
        throw error

      const data = await getOnboardingFunnelDirect(
        '2097-08-14T00:00:00.000Z',
        '2097-08-16T00:00:00.000Z',
      )

      expect(data.onboarding_method_trend).toEqual([
        {
          date: '2097-08-14',
          manual: 1,
          cli: 2,
          mcp: 1,
          ai: 1,
        },
        {
          date: '2097-08-15',
          manual: 0,
          cli: 0,
          mcp: 0,
          ai: 0,
        },
      ])
      expect(data.onboarding_outcome_trend).toEqual([
        {
          date: '2097-08-14',
          completed: 1,
          skipped: 1,
          switched_to_manual: 1,
          in_progress: 1,
        },
        {
          date: '2097-08-15',
          completed: 0,
          skipped: 0,
          switched_to_manual: 0,
          in_progress: 0,
        },
      ])
    }
    finally {
      await supabase.from('apps').delete().in('app_id', apps.map(app => app.app_id))
    }
  })

  it.concurrent('keeps an uploaded bundle in the funnel after a later channel promotion', async () => {
    if (!soloPlan)
      throw new Error('Expected Solo plan to exist for onboarding funnel test')

    const supabase = getSupabaseClient()
    const orgId = randomUUID()
    const registerUserId = randomUUID()
    const suffix = orgId.replaceAll('-', '').slice(0, 12)
    const appId = `com.admin.stats.onboardinghistory.${suffix}`
    const customerId = `cus_admin_stats_onboarding_history_${suffix}`
    const orgCreatedAt = '2098-07-01T10:00:00.000Z'
    const registerCreatedAt = '2098-07-01T09:00:00.000Z'
    const registerEmail = `admin-stats-onboarding-history-${suffix}@capgo.app`

    try {
      await executeSQL(
        `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
         VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $4::timestamptz, '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [registerUserId, registerEmail, USER_PASSWORD_HASH, registerCreatedAt],
      )
      await executeSQL(
        `INSERT INTO public.users (id, email, created_at, updated_at, created_via_invite)
         VALUES ($1, $2, $3::timestamptz, $3::timestamptz, false)
         ON CONFLICT (id) DO UPDATE SET
           email = EXCLUDED.email,
           created_at = EXCLUDED.created_at,
           updated_at = EXCLUDED.updated_at,
           created_via_invite = EXCLUDED.created_via_invite`,
        [registerUserId, registerEmail, registerCreatedAt],
      )

      const { error: stripeError } = await supabase.from('stripe_info').insert({
        customer_id: customerId,
        status: 'succeeded',
        product_id: soloPlan.stripe_id,
        price_id: soloPlan.price_m_id,
        trial_at: '2098-07-20T10:00:00.000Z',
        paid_at: '2098-07-05T10:00:00.000Z',
        is_good_plan: true,
        plan_usage: 2,
        subscription_anchor_start: '2098-07-05T10:00:00.000Z',
        subscription_anchor_end: '2098-08-05T10:00:00.000Z',
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await supabase.from('orgs').insert({
        id: orgId,
        name: `Admin Stats Onboarding History ${suffix}`,
        created_by: registerUserId,
        management_email: registerEmail,
        customer_id: customerId,
        created_at: orgCreatedAt,
      })
      if (orgError)
        throw orgError

      const { error: appError } = await supabase.from('apps').insert({
        owner_org: orgId,
        name: 'Admin Stats Onboarding History App',
        app_id: appId,
        icon_url: 'https://example.com/icon.png',
        created_at: '2098-07-02T10:00:00.000Z',
      })
      if (appError)
        throw appError

      const { data: firstVersion, error: firstVersionError } = await supabase
        .from('app_versions')
        .insert({
          app_id: appId,
          name: '1.0.0',
          owner_org: orgId,
          user_id: registerUserId,
          storage_provider: 'r2-direct',
          created_at: '2098-07-04T10:00:00.000Z',
        })
        .select('id')
        .single()
      if (firstVersionError)
        throw firstVersionError
      if (!firstVersion)
        throw new Error('Expected the initial onboarding bundle to be created')

      const { error: channelError } = await supabase.from('channels').insert({
        name: 'production',
        app_id: appId,
        version: firstVersion.id,
        created_by: registerUserId,
        owner_org: orgId,
        created_at: '2098-07-03T10:00:00.000Z',
      })
      if (channelError)
        throw channelError

      const { data: promotedVersion, error: promotedVersionError } = await supabase
        .from('app_versions')
        .insert({
          app_id: appId,
          name: '2.0.0',
          owner_org: orgId,
          user_id: registerUserId,
          storage_provider: 'r2-direct',
          created_at: '2098-07-12T10:00:00.000Z',
        })
        .select('id')
        .single()
      if (promotedVersionError)
        throw promotedVersionError
      if (!promotedVersion)
        throw new Error('Expected a later onboarding bundle to be created')

      const { error: channelUpdateError } = await supabase
        .from('channels')
        .update({ version: promotedVersion.id })
        .eq('app_id', appId)
        .eq('name', 'production')
      if (channelUpdateError)
        throw channelUpdateError

      const response = await fetchTestRequest(`${BASE_URL}/private/admin_stats`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          metric_category: 'onboarding_funnel',
          start_date: '2098-07-01T00:00:00.000Z',
          end_date: '2098-07-02T00:00:00.000Z',
        }),
      })

      expect(response.status).toBe(200)
      const payload = await response.json() as {
        success: boolean
        data: {
          total_registrations: number
          total_orgs: number
          orgs_with_app: number
          orgs_with_channel: number
          orgs_with_bundle: number
          orgs_subscribed: number
          org_conversion_rate: number
          trend: Array<{
            date: string
            new_registrations: number
            orgs_created_bundle: number
            orgs_subscribed: number
          }>
        }
      }

      expect(payload.success).toBe(true)
      expect(payload.data.total_registrations).toBe(1)
      expect(payload.data.total_orgs).toBe(1)
      expect(payload.data.orgs_with_app).toBe(1)
      expect(payload.data.orgs_with_channel).toBe(1)
      expect(payload.data.orgs_with_bundle).toBe(1)
      expect(payload.data.orgs_subscribed).toBe(1)
      expect(payload.data.org_conversion_rate).toBe(100)
      expect(payload.data.trend).toHaveLength(1)
      expect(payload.data.trend[0]).toMatchObject({
        date: '2098-07-01',
        new_registrations: 1,
        orgs_created_bundle: 1,
        orgs_subscribed: 1,
      })
    }
    finally {
      await supabase.from('channels').delete().eq('app_id', appId)
      await supabase.from('app_versions').delete().eq('app_id', appId)
      await supabase.from('apps').delete().eq('app_id', appId)
      await supabase.from('orgs').delete().eq('id', orgId)
      await supabase.from('stripe_info').delete().eq('customer_id', customerId)
      await executeSQL('DELETE FROM public.users WHERE id = $1', [registerUserId])
      await executeSQL('DELETE FROM auth.users WHERE id = $1', [registerUserId])
    }
  })

  it('returns daily new trial organizations grouped by plan', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/admin_stats'), {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        metric_category: 'trial_plan_breakdown',
        start_date: '2026-02-01T00:00:00.000Z',
        end_date: '2026-02-02T00:00:00.000Z',
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as {
      success: boolean
      data: {
        totals: Array<{ plan_name: string, total: number }>
        trend: Array<{
          date: string
          total: number
          plans: Record<string, number>
        }>
      }
    }

    expect(payload.success).toBe(true)
    expect(payload.data.trend).toHaveLength(1)
    expect(payload.data.trend[0]?.date).toBe('2026-02-01')
    // Counts all trial orgs created that day: ONBOARDING_ORG, ONBOARDING_NO_BUNDLE_ORG,
    // ONBOARDING_LATE_SUBSCRIPTION_ORG, and ONBOARDING_INVITE_ORG (invite orgs are included).
    expect(payload.data.trend[0]?.total).toBe(4)
    expect(payload.data.trend[0]?.plans[soloPlan?.name ?? 'Solo']).toBe(4)
    expect(payload.data.totals.find(plan => plan.plan_name === (soloPlan?.name ?? 'Solo'))?.total).toBe(4)
  })
})
