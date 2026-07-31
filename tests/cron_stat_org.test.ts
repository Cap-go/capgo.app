import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BASE_URL, fetchTestRequest, getBaseData, getSupabaseClient, PRODUCT_ID, postUpdate, TEST_EMAIL, USER_ID } from './test-utils.ts'

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

describe('[POST] /triggers/cron_stat_org', () => {
  it('should return 400 when orgId is missing', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_orgId')
  })

  it('should handle too big MAU correctly', async () => {
    const supabase = getSupabaseClient()
    const { error: latestMauError, data: latestMauData } = await supabase
      .from('daily_mau')
      .select('*')
      .eq('app_id', APPNAME)
      .order('date', { ascending: false })
      .limit(1)
      .single()
    expect(latestMauError).toBeFalsy()

    const { error: setMauError } = await supabase
      .from('daily_mau')
      .update({ mau: 1000000 })
      .eq('app_id', APPNAME)
      .eq('date', latestMauData?.date ?? '')
    expect(setMauError).toBeFalsy()

    const { error } = await supabase
      .from('stripe_info')
      .update({ is_good_plan: true, trial_at: new Date(0).toISOString() })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
    if (error)
      throw error

    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    const { data: stripeInfoData } = await supabase
      .from('stripe_info')
      .select('*')
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfoData?.is_good_plan).toBe(false)

    const { data: mauExceeded, error: mauExceededError } = await supabase
      .rpc('is_mau_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(mauExceededError).toBeFalsy()
    expect(mauExceeded).toBe(true)

    const { data: storageExceeded, error: storageExceededError } = await supabase
      .rpc('is_storage_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(storageExceededError).toBeFalsy()
    expect(storageExceeded).toBe(false)

    const { data: bandwidthExceeded, error: bandwidthExceededError } = await supabase
      .rpc('is_bandwidth_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(bandwidthExceededError).toBeFalsy()
    expect(bandwidthExceeded).toBe(false)

    const { data: isAllowedActionMau, error: isAllowedActionMauError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['mau'] as const })
    expect(isAllowedActionMauError).toBeFalsy()
    expect(isAllowedActionMau).toBe(false)

    const { data: isAllowedActionStorage, error: isAllowedActionStorageError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['storage'] as const })
    expect(isAllowedActionStorageError).toBeFalsy()
    expect(isAllowedActionStorage).toBe(true)

    const { data: isAllowedActionBandwidth, error: isAllowedActionBandwidthError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['bandwidth'] as const })
    expect(isAllowedActionBandwidthError).toBeFalsy()
    expect(isAllowedActionBandwidth).toBe(true)

    const baseData = getBaseData(APPNAME)
    const updateResponse = await postUpdate(baseData)

    expect(updateResponse.status).toBe(429)
    expect(await updateResponse.json<{ error: string }>().then(data => data.error)).toEqual('on_premise_app')
  })

  it('should handle too big storage correctly', async () => {
    const supabase = getSupabaseClient()

    // Solo plan storage limit is 1073741824 (1GB), so we need to exceed that
    const { error: setStorageError } = await supabase
      .from('app_versions_meta')
      .update({ size: 2000000000 })
      .eq('app_id', APPNAME)
    expect(setStorageError).toBeFalsy()

    const { error } = await supabase
      .from('stripe_info')
      .update({ is_good_plan: true, trial_at: new Date(0).toISOString() })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
    if (error)
      throw error

    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    const { data: stripeInfoData } = await supabase
      .from('stripe_info')
      .select('*')
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfoData?.is_good_plan).toBe(false)

    const { data: mauExceeded, error: mauExceededError } = await supabase
      .rpc('is_mau_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(mauExceededError).toBeFalsy()
    expect(mauExceeded).toBe(false)

    const { data: storageExceeded, error: storageExceededError } = await supabase
      .rpc('is_storage_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(storageExceededError).toBeFalsy()
    expect(storageExceeded).toBe(true)

    const { data: bandwidthExceeded, error: bandwidthExceededError } = await supabase
      .rpc('is_bandwidth_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(bandwidthExceededError).toBeFalsy()
    expect(bandwidthExceeded).toBe(false)

    const { data: isAllowedActionStorage, error: isAllowedActionStorageError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['storage'] as const })
    expect(isAllowedActionStorageError).toBeFalsy()
    expect(isAllowedActionStorage).toBe(false)

    const { data: isAllowedActionMau, error: isAllowedActionMauError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['mau'] as const })
    expect(isAllowedActionMauError).toBeFalsy()
    expect(isAllowedActionMau).toBe(true)

    const { data: isAllowedActionBandwidth, error: isAllowedActionBandwidthError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['bandwidth'] as const })
    expect(isAllowedActionBandwidthError).toBeFalsy()
    expect(isAllowedActionBandwidth).toBe(true)
  })

  it('should handle too big bandwidth correctly', async () => {
    const supabase = getSupabaseClient()
    const { error: latestBandwidthError, data: latestBandwidthData } = await supabase
      .from('daily_bandwidth')
      .select('*')
      .eq('app_id', APPNAME)
      .order('date', { ascending: false })
      .limit(1)
      .single()
    expect(latestBandwidthError).toBeFalsy()

    // Solo plan bandwidth limit is 13958643712 (~13GB), so we need to exceed that
    const { error: setBandwidthError } = await supabase
      .from('daily_bandwidth')
      .update({ bandwidth: 20000000000 })
      .eq('app_id', APPNAME)
      .eq('date', latestBandwidthData?.date ?? '')
    expect(setBandwidthError).toBeFalsy()

    const { error } = await supabase
      .from('stripe_info')
      .update({ is_good_plan: true, trial_at: new Date(0).toISOString() })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
    if (error)
      throw error

    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    const { data: stripeInfoData } = await supabase
      .from('stripe_info')
      .select('*')
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)
      .single()
    expect(stripeInfoData?.is_good_plan).toBe(false)

    const { data: mauExceeded, error: mauExceededError } = await supabase
      .rpc('is_mau_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(mauExceededError).toBeFalsy()
    expect(mauExceeded).toBe(false)

    const { data: storageExceeded, error: storageExceededError } = await supabase
      .rpc('is_storage_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(storageExceededError).toBeFalsy()
    expect(storageExceeded).toBe(false)

    const { data: bandwidthExceeded, error: bandwidthExceededError } = await supabase
      .rpc('is_bandwidth_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(bandwidthExceededError).toBeFalsy()
    expect(bandwidthExceeded).toBe(true)

    const { data: isAllowedActionBandwidth, error: isAllowedActionBandwidthError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['bandwidth'] as const })
    expect(isAllowedActionBandwidthError).toBeFalsy()
    expect(isAllowedActionBandwidth).toBe(false)

    const { data: isAllowedActionMau, error: isAllowedActionMauError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['mau'] as const })
    expect(isAllowedActionMauError).toBeFalsy()
    expect(isAllowedActionMau).toBe(true)

    const { data: isAllowedActionStorage, error: isAllowedActionStorageError } = await supabase
      .rpc('is_allowed_action_org_action', { orgid: TEST_ORG_ID, actions: ['storage'] as const })
    expect(isAllowedActionStorageError).toBeFalsy()
    expect(isAllowedActionStorage).toBe(true)
  })

  it('should correctly handle MAU reset', async () => {
    const supabase = getSupabaseClient()

    // First set MAU to exceeded
    const { error: latestMauError, data: latestMauData } = await supabase
      .from('daily_mau')
      .select('*')
      .eq('app_id', APPNAME)
      .order('date', { ascending: false })
      .limit(1)
      .single()
    expect(latestMauError).toBeFalsy()

    await supabase
      .from('daily_mau')
      .update({ mau: 1000000 })
      .eq('app_id', APPNAME)
      .eq('date', latestMauData?.date ?? '')

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron to set mau_exceeded
    await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })

    // Verify MAU is exceeded
    const { data: mauExceeded } = await supabase
      .rpc('is_mau_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(mauExceeded).toBe(true)

    // Now reset MAU to 0
    await supabase
      .from('daily_mau')
      .update({ mau: 0 })
      .eq('app_id', APPNAME)
      .eq('date', latestMauData?.date ?? '')

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron again
    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    // Verify MAU is no longer exceeded
    const { data: mauExceededAfter, error: mauExceededErrorAfter } = await supabase
      .rpc('is_mau_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(mauExceededErrorAfter).toBeFalsy()
    expect(mauExceededAfter).toBe(false)
  })

  it('should correctly handle storage reset', async () => {
    const supabase = getSupabaseClient()

    // First set storage to exceeded (Solo plan limit is 1073741824, so use 2GB)
    await supabase
      .from('app_versions_meta')
      .update({ size: 2000000000 })
      .eq('app_id', APPNAME)

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron to set storage_exceeded
    await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })

    // Verify storage is exceeded
    const { data: storageExceeded } = await supabase
      .rpc('is_storage_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(storageExceeded).toBe(true)

    // Now reset storage to 0
    await supabase
      .from('app_versions_meta')
      .update({ size: 0 })
      .eq('app_id', APPNAME)

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron again
    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    // Verify storage is no longer exceeded
    const { data: storageExceededAfter, error: storageExceededErrorAfter } = await supabase
      .rpc('is_storage_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(storageExceededErrorAfter).toBeFalsy()
    expect(storageExceededAfter).toBe(false)
  })

  it('should correctly handle bandwidth reset', async () => {
    const supabase = getSupabaseClient()

    // First set bandwidth to exceeded
    const { data: latestBandwidthData } = await supabase
      .from('daily_bandwidth')
      .select('*')
      .eq('app_id', APPNAME)
      .order('date', { ascending: false })
      .limit(1)
      .single()

    // Solo plan bandwidth limit is 13958643712 (~13GB), so use 20GB
    await supabase
      .from('daily_bandwidth')
      .update({ bandwidth: 20000000000 })
      .eq('app_id', APPNAME)
      .eq('date', latestBandwidthData?.date ?? '')

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron to set bandwidth_exceeded
    await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })

    // Verify bandwidth is exceeded
    const { data: bandwidthExceeded } = await supabase
      .rpc('is_bandwidth_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(bandwidthExceeded).toBe(true)

    // Now reset bandwidth to 0
    await supabase
      .from('daily_bandwidth')
      .update({ bandwidth: 0 })
      .eq('app_id', APPNAME)
      .eq('date', latestBandwidthData?.date ?? '')

    await supabase
      .from('stripe_info')
      .update({ is_good_plan: true })
      .eq('customer_id', TEST_STRIPE_CUSTOMER_ID)

    // Trigger cron again
    const response = await fetchTestRequest(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ orgId: TEST_ORG_ID }),
    })
    expect(response.status).toBe(200)

    // Verify bandwidth is no longer exceeded
    const { data: bandwidthExceededAfter, error: bandwidthExceededErrorAfter } = await supabase
      .rpc('is_bandwidth_exceeded_by_org', { org_id: TEST_ORG_ID })
    expect(bandwidthExceededErrorAfter).toBeFalsy()
    expect(bandwidthExceededAfter).toBe(false)
  })
})
