import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BASE_URL, executeSQL, fetchTestRequest, getBaseData, getSupabaseClient, postUpdate, PRODUCT_ID, TEST_EMAIL, USER_ID, warmEdgeEndpoint } from './test-utils.ts'

// Create unique IDs for this test file to avoid parallel test interference
const id = randomUUID()
const APPNAME = `com.cron.stat.${id}`
const TEST_ORG_ID = randomUUID()
const TEST_STRIPE_CUSTOMER_ID = `cus_cron_stat_${id.slice(0, 8)}`

const headers = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

// Setup unique org and stripe_info once for all tests in this file
beforeAll(async () => {
  const supabase = getSupabaseClient()

  // Create unique stripe_info FIRST (orgs has FK constraint on customer_id)
  const { error: stripeError } = await supabase.from('stripe_info').insert({
    subscription_id: `sub_cron_${id.slice(0, 8)}`,
    customer_id: TEST_STRIPE_CUSTOMER_ID,
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
  })
  if (stripeError)
    throw stripeError

  // Create unique org AFTER stripe_info
  const { error: orgError } = await supabase.from('orgs').insert({
    id: TEST_ORG_ID,
    customer_id: TEST_STRIPE_CUSTOMER_ID,
    name: `Test Org Cron Stat ${id}`,
    created_by: USER_ID,
    management_email: TEST_EMAIL,
  })
  if (orgError)
    throw orgError

  // Create unique app for this test file
  const { error: appError } = await supabase.from('apps').insert({
    owner_org: TEST_ORG_ID,
    name: `Test App Cron Stat ${id}`,
    app_id: APPNAME,
    icon_url: 'https://example.com/icon.png',
  })
  if (appError)
    throw appError

  // Cold first POST to cron_stat_org can 502 under Deno load; warm before assertions.
  await warmEdgeEndpoint('/triggers/cron_stat_org')
})

// Reset state before each test
beforeEach(async () => {
  const supabase = getSupabaseClient()

  // Reset stripe_info to default state
  const { error } = await supabase
    .from('stripe_info')
    .update({
      is_good_plan: true,
      mau_exceeded: false,
      storage_exceeded: false,
      bandwidth_exceeded: false,
    })
    .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
  if (error)
    throw error

  // Delete old app_versions and create a fresh one
  await supabase.from('app_versions').delete().eq('app_id', APPNAME)

  const { error: appVersionsError, data: appVersionsData } = await supabase.from('app_versions').insert([{
    app_id: APPNAME,
    name: `1.0.0-${Date.now()}`,
    owner_org: TEST_ORG_ID,
  }]).select('*')
  if (appVersionsError)
    throw appVersionsError

  // Create app_versions_meta with 0 size
  const { error: appVersionMetaError } = await supabase.from('app_versions_meta').upsert(appVersionsData.map((version) => {
    return {
      id: version.id,
      app_id: APPNAME,
      size: 0,
      checksum: '',
      owner_org: TEST_ORG_ID,
    }
  }), { onConflict: 'id' })
  if (appVersionMetaError)
    throw appVersionMetaError

  // Reset daily_mau for this app
  await supabase.from('daily_mau').delete().eq('app_id', APPNAME)
  const today = new Date().toISOString().split('T')[0]
  await supabase.from('daily_mau').insert({ app_id: APPNAME, date: today, mau: 0 })

  // Reset daily_bandwidth for this app
  await supabase.from('daily_bandwidth').delete().eq('app_id', APPNAME)
  await supabase.from('daily_bandwidth').insert({ app_id: APPNAME, date: today, bandwidth: 0 })

  // Clear app_metrics_cache for this org
  await supabase.from('app_metrics_cache').delete().eq('org_id', TEST_ORG_ID)
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  // Clean up all data created by this test file
  await supabase.from('app_metrics_cache').delete().eq('org_id', TEST_ORG_ID)
  await supabase.from('daily_mau').delete().eq('app_id', APPNAME)
  await supabase.from('daily_bandwidth').delete().eq('app_id', APPNAME)
  await supabase.from('app_versions_meta').delete().eq('app_id', APPNAME)
  await supabase.from('app_versions').delete().eq('app_id', APPNAME)
  await supabase.from('channels').delete().eq('app_id', APPNAME)
  await supabase.from('apps').delete().eq('app_id', APPNAME)
  await supabase.from('stripe_info').delete().eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
  await supabase.from('orgs').delete().eq('id', TEST_ORG_ID)
})

type UsageKind = 'mau' | 'storage' | 'bandwidth'

// Solo plan limits: MAU ~ thousands, storage 1073741824 (1GB), bandwidth 13958643712 (~13GB).
const OVER_LIMIT: Record<UsageKind, number> = { mau: 1_000_000, storage: 2_000_000_000, bandwidth: 20_000_000_000 }
const USAGE_KINDS = Object.keys(OVER_LIMIT) as UsageKind[]

async function setUsage(kind: UsageKind, value: number) {
  const supabase = getSupabaseClient()
  // beforeEach leaves exactly one daily_mau/daily_bandwidth row (today) per app.
  const { error } = kind === 'mau'
    ? await supabase.from('daily_mau').update({ mau: value }).eq('app_id', APPNAME)
    : kind === 'bandwidth'
      ? await supabase.from('daily_bandwidth').update({ bandwidth: value }).eq('app_id', APPNAME)
      : await supabase.from('app_versions_meta').update({ size: value }).eq('app_id', APPNAME)
  expect(error).toBeFalsy()
}

async function runCronStatOrg(body: Record<string, unknown> = { orgId: TEST_ORG_ID }) {
  return fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function readStripeInfoVersion() {
  const [row] = await executeSQL<{ row_version: string, updated_at: string }>(`
    SELECT xmin::text AS row_version,
           updated_at::text AS updated_at
    FROM public.stripe_info
    WHERE customer_id = $1
  `, [TEST_STRIPE_CUSTOMER_ID])
  return row
}

async function isExceeded(kind: UsageKind) {
  const { data, error } = await getSupabaseClient().rpc(`is_${kind}_exceeded_by_org`, { org_id: TEST_ORG_ID })
  expect(error).toBeFalsy()
  return data
}

async function isAllowed(kind: UsageKind) {
  const { data, error } = await getSupabaseClient().rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: [kind] })
  expect(error).toBeFalsy()
  return data
}

async function markGoodPlan(extra: { trial_at?: string } = {}) {
  const { error } = await getSupabaseClient()
    .from('stripe_info')
    .update({ is_good_plan: true, ...extra })
    .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
  if (error)
    throw error
}

describe('[POST] /triggers/cron_stat_org', () => {
  it('should return 400 when orgId is missing', async () => {
    const response = await runCronStatOrg({})
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_orgId')
  })

  it('does not rewrite stripe_info when the calculated plan state is unchanged', async () => {
    expect((await runCronStatOrg()).status).toBe(200)
    const before = await readStripeInfoVersion()

    expect((await runCronStatOrg()).status).toBe(200)
    expect(await readStripeInfoVersion()).toEqual(before)
  })

  it.each(USAGE_KINDS)('flags only the exceeded %s usage and blocks only that action', async (kind) => {
    await setUsage(kind, OVER_LIMIT[kind])
    await markGoodPlan({ trial_at: new Date(0).toISOString() })

    expect((await runCronStatOrg()).status).toBe(200)

    const { data: stripeInfoData } = await getSupabaseClient()
      .from('stripe_info')
      .select('*')
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfoData?.is_good_plan).toBe(false)

    for (const other of USAGE_KINDS) {
      expect(await isExceeded(other), `${other} exceeded`).toBe(other === kind)
      expect(await isAllowed(other), `${other} allowed`).toBe(other !== kind)
    }

    if (kind === 'mau') {
      const updateResponse = await postUpdate(getBaseData(APPNAME))
      expect(updateResponse.status).toBe(429)
      expect(await updateResponse.json<{ error: string }>().then(data => data.error)).toEqual('on_premise_app')
    }
  })

  it.each(USAGE_KINDS)('clears the %s exceeded flag once usage drops back under the limit', async (kind) => {
    await setUsage(kind, OVER_LIMIT[kind])
    await markGoodPlan()
    await runCronStatOrg()
    expect(await isExceeded(kind)).toBe(true)

    await setUsage(kind, 0)
    await markGoodPlan()
    expect((await runCronStatOrg()).status).toBe(200)
    expect(await isExceeded(kind)).toBe(false)
  })
})
