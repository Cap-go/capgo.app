import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fetchTestRequest, getEndpointUrl, getSupabaseClient, PRODUCT_ID, resetAppData, resetAppDataStats, TEST_EMAIL, USER_ID } from './test-utils.ts'

// Generate unique IDs per test run to avoid conflicts with parallel test runs
const testRunId = randomUUID()
const ORG_ID = testRunId // Use UUID directly as org_id
const STRIPE_CUSTOMER_ID = `cus_build_time_${testRunId.slice(0, 8)}`
const APPNAME = `com.build_time.${testRunId.slice(0, 8)}`
const headers = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

beforeAll(async () => {
  const supabase = getSupabaseClient()

  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)

  const { error: stripeError } = await supabase
    .from('stripe_info')
    .insert({
      subscription_id: `sub_build_time_test_${testRunId.slice(0, 8)}`,
      customer_id: STRIPE_CUSTOMER_ID,
      status: 'succeeded' as const,
      product_id: PRODUCT_ID,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_anchor_end: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      mau_exceeded: false,
      storage_exceeded: false,
      bandwidth_exceeded: false,
      build_time_exceeded: false,
    })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await supabase.from('orgs').insert({
    id: ORG_ID,
    customer_id: STRIPE_CUSTOMER_ID,
    name: `Build Time Test Org ${testRunId.slice(0, 8)}`,
    created_by: USER_ID,
    management_email: TEST_EMAIL,
  })
  if (orgError)
    throw orgError

  const { error: orgUserError } = await supabase.from('org_users').insert({
    org_id: ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin',
  })
  if (orgUserError)
    throw orgUserError
})

beforeEach(async () => {
  const supabase = getSupabaseClient()

  await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)
  await supabase.from('build_logs').delete().eq('org_id', ORG_ID)
  await supabase.from('app_metrics_cache').delete().eq('org_id', ORG_ID)
  await supabase.from('usage_credit_consumptions').delete().eq('org_id', ORG_ID)
  await supabase.from('usage_overage_events').delete().eq('org_id', ORG_ID)
  await supabase.from('usage_credit_transactions').delete().eq('org_id', ORG_ID)
  await supabase.from('usage_credit_grants').delete().eq('org_id', ORG_ID)
  await supabase.from('app_versions').delete().eq('app_id', APPNAME)
  await supabase.from('apps').delete().eq('app_id', APPNAME)

  // Reset stripe_info to clean state before each test
  const { error } = await supabase
    .from('stripe_info')
    .update({
      status: 'succeeded' as const,
      product_id: PRODUCT_ID,
      trial_at: new Date(0).toISOString(),
      is_good_plan: true,
      plan_usage: 2,
      subscription_anchor_start: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString(),
      subscription_anchor_end: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      mau_exceeded: false,
      storage_exceeded: false,
      bandwidth_exceeded: false,
      build_time_exceeded: false,
      plan_calculated_at: null,
    })
    .eq('customer_id', STRIPE_CUSTOMER_ID)
  if (error)
    throw error

  // Create app for this test
  const { error: appError } = await supabase.from('apps').insert([
    {
      owner_org: ORG_ID,
      name: 'Test App Build Time',
      app_id: APPNAME,
      icon_url: 'https://example.com/icon.png',
    },
  ])
  if (appError)
    throw appError

  // Create an app_version to make the org "onboarded"
  const { error: versionError } = await supabase.from('app_versions').insert([
    {
      app_id: APPNAME,
      name: '1.0.0',
      owner_org: ORG_ID,
      user_id: USER_ID,
      storage_provider: 'r2-direct',
    },
  ])
  if (versionError)
    throw versionError
})

afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
  const supabase = getSupabaseClient()

  // Clean up all data for dedicated org
  await supabase.from('build_logs').delete().eq('org_id', ORG_ID)
  await supabase.from('daily_build_time').delete().eq('app_id', APPNAME)
  await supabase.from('app_versions').delete().eq('owner_org', ORG_ID)
  await supabase.from('apps').delete().eq('owner_org', ORG_ID)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)
  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
})

describe('build Time Tracking System', () => {
  it('should reject unauthenticated calls to record_build_time RPC', async () => {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey)
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for this test')

    const publicSupabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
      },
    })

    const { error } = await publicSupabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: randomUUID(),
      p_platform: 'ios',
      p_build_time_unit: 30,
      p_app_id: APPNAME,
    })
    expect(error).toBeTruthy()
  })

  it('should reject direct REST POST to record_build_time without auth privileges', async () => {
    const supabaseUrl = process.env.SUPABASE_URL
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY
    if (!supabaseUrl || !supabaseAnonKey)
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for this test')

    const supabase = getSupabaseClient()
    const before = await supabase
      .from('build_logs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', ORG_ID)
    if (before.error)
      throw before.error
    const beforeCount = before.count ?? 0

    const buildId = `poc_buildtime_${randomUUID()}`
    const response = await fetch(new URL('/rest/v1/rpc/record_build_time', supabaseUrl), {
      method: 'POST',
      headers: {
        'apikey': supabaseAnonKey,
        'authorization': `Bearer ${supabaseAnonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        p_org_id: ORG_ID,
        p_user_id: USER_ID,
        p_build_id: buildId,
        p_platform: 'ios',
        p_build_time_unit: 30,
        p_app_id: APPNAME,
      }),
    })
    const after = await supabase
      .from('build_logs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', ORG_ID)
    if (after.error)
      throw after.error

    expect(response.status).not.toBe(200)
    expect(after.count).toBe(beforeCount)
  })

  it('should handle too big build time correctly', async () => {
    const supabase = getSupabaseClient()

    // Insert high build time usage directly into daily_build_time
    // Solo plan limit is 3600 seconds (60 min), so we insert way over that
    const today = new Date().toISOString().split('T')[0]
    const { error: buildTimeInsertError } = await supabase
      .from('daily_build_time')
      .insert({
        app_id: APPNAME,
        date: today,
        build_time_unit: 36000, // 10 hours in seconds (way over Solo plan limit of 3600 seconds)
        build_count: 10,
      })
    expect(buildTimeInsertError).toBeFalsy()

    const { error } = await supabase
      .from('stripe_info')
      .update({ is_good_plan: true, trial_at: new Date(0).toISOString() })
      .eq('customer_id', STRIPE_CUSTOMER_ID)
    if (error)
      throw error

    // First verify the metrics can be retrieved and show excessive build time
    const { data: totalMetrics, error: totalMetricsError } = await supabase
      .rpc('get_total_metrics', { org_id: ORG_ID })
    expect(totalMetricsError).toBeFalsy()
    console.log('Total metrics before cron:', totalMetrics)
    // Verify our inserted build time is the only one (should be exactly 36000)
    expect((totalMetrics as any)?.[0]?.build_time_unit).toBe(36000)

    const response = await fetchTestRequest(getEndpointUrl('/triggers/cron_stat_org'), {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: ORG_ID }),
    })
    if (response.status !== 200) {
      const errorText = await response.text()
      console.error('Cron endpoint error:', response.status, errorText)
    }
    expect(response.status).toBe(200)

    const { data: stripeInfoData } = await supabase
      .from('stripe_info')
      .select('*')
      .eq('customer_id', STRIPE_CUSTOMER_ID)
      .single()
    console.log('Stripe info after cron:', stripeInfoData)
    expect(stripeInfoData?.is_good_plan).toBe(false)

    const { data: buildTimeExceeded, error: buildTimeExceededError } = await supabase
      .rpc('is_build_time_exceeded_by_org', { org_id: ORG_ID })
    expect(buildTimeExceededError).toBeFalsy()
    expect(buildTimeExceeded).toBe(true)

    // These tests verify build time exceeded is blocking build actions
    const { data: isAllowedActionBuildTime, error: isAllowedActionBuildTimeError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: ORG_ID, actions: ['build_time'] as const })
    expect(isAllowedActionBuildTimeError).toBeFalsy()
    expect(isAllowedActionBuildTime).toBe(false) // Build time should be blocked
  })

  it('should correctly reset build_time_exceeded flag directly', async () => {
    const supabase = getSupabaseClient()

    // First set high build time using build_logs
    const excessiveBuildId = `${randomUUID()}-excessive-reset`
    const { error: rpcError } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: excessiveBuildId,
      p_platform: 'ios',
      p_build_time_unit: 18000, // 5 hours, 2x multiplier = 10 hours billable
      p_app_id: APPNAME,
    })
    expect(rpcError).toBeFalsy()

    // Set build_time_exceeded to true directly (simulating what cron would do)
    const { error: setExceededError } = await supabase
      .from('stripe_info')
      .update({ build_time_exceeded: true })
      .eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(setExceededError).toBeFalsy()

    // Verify build time is exceeded
    const { data: buildTimeExceededBefore, error: buildTimeExceededErrorBefore } = await supabase
      .rpc('is_build_time_exceeded_by_org', { org_id: ORG_ID })
    expect(buildTimeExceededErrorBefore).toBeFalsy()
    expect(buildTimeExceededBefore).toBe(true)

    // Reset build time by deleting build logs
    const { error: resetBuildTimeError } = await supabase
      .from('build_logs')
      .delete()
      .eq('org_id', ORG_ID)
    expect(resetBuildTimeError).toBeFalsy()

    // Reset stripe_info build_time_exceeded flag directly
    const { error: resetFlagError } = await supabase
      .from('stripe_info')
      .update({ build_time_exceeded: false })
      .eq('customer_id', STRIPE_CUSTOMER_ID)
    expect(resetFlagError).toBeFalsy()

    // Verify build time is no longer exceeded
    const { data: buildTimeExceededAfter, error: buildTimeExceededErrorAfter } = await supabase
      .rpc('is_build_time_exceeded_by_org', { org_id: ORG_ID })
    expect(buildTimeExceededErrorAfter).toBeFalsy()
    expect(buildTimeExceededAfter).toBe(false)
  })

  // Note: get_total_metrics reads from daily_build_time, which is now
  // automatically populated via a trigger on build_logs inserts/updates.

  it('should correctly record build time using RPC function (iOS 2x multiplier)', async () => {
    const supabase = getSupabaseClient()
    const buildId = randomUUID()

    const { error: rpcError } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'ios',
      p_build_time_unit: 600, // 10 minutes
      p_app_id: APPNAME,
    })
    expect(rpcError).toBeFalsy()

    const { data: buildLog, error } = await supabase
      .from('build_logs')
      .select('*')
      .eq('build_id', buildId)
      .single()
    expect(error).toBeFalsy()
    expect(buildLog?.build_time_unit).toBe(600)
    expect(buildLog?.billable_seconds).toBe(1200) // iOS 2x multiplier
  })

  it('should correctly apply Android 1x multiplier', async () => {
    const supabase = getSupabaseClient()
    const buildId = randomUUID()

    const { error: rpcError } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'android',
      p_build_time_unit: 150,
      p_app_id: APPNAME,
    })
    expect(rpcError).toBeFalsy()

    const { data: buildLog, error } = await supabase
      .from('build_logs')
      .select('*')
      .eq('build_id', buildId)
      .single()
    expect(error).toBeFalsy()
    expect(buildLog?.build_time_unit).toBe(150)
    expect(buildLog?.billable_seconds).toBe(150) // Android 1x multiplier
  })

  it('should upsert on duplicate build_id', async () => {
    const supabase = getSupabaseClient()
    const buildId = randomUUID()

    // First call
    await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'ios',
      p_build_time_unit: 600,
      p_app_id: APPNAME,
    })

    // Second call with updated time
    const { error: rpcError } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'ios',
      p_build_time_unit: 700,
      p_app_id: APPNAME,
    })
    expect(rpcError).toBeFalsy()

    // Should have updated, not created duplicate
    const { data: logs, error } = await supabase
      .from('build_logs')
      .select('*')
      .eq('build_id', buildId)
    expect(error).toBeFalsy()
    expect(logs?.length).toBe(1)
    expect(logs?.[0]?.build_time_unit).toBe(700)
    expect(logs?.[0]?.billable_seconds).toBe(1400)
  })

  it('should reject invalid platform', async () => {
    const supabase = getSupabaseClient()
    const buildId = randomUUID()

    const { error } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'windows' as any,
      p_build_time_unit: 600,
      p_app_id: APPNAME,
    })
    expect(error).toBeTruthy()
  })

  it('should reject negative build time', async () => {
    const supabase = getSupabaseClient()
    const buildId = randomUUID()

    const { error } = await supabase.rpc('record_build_time', {
      p_org_id: ORG_ID,
      p_user_id: USER_ID,
      p_build_id: buildId,
      p_platform: 'ios',
      p_build_time_unit: -100,
      p_app_id: APPNAME,
    })
    expect(error).toBeTruthy()
  })
})
