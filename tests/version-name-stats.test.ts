/**
 * Tests for version_name-based statistics tracking
 *
 * These tests verify that:
 * 1. daily_version is correctly populated with version_name after cron_stat_app
 * 2. read_version_usage function returns version_name instead of version_id
 * 3. The system correctly handles both old (numeric version_id) and new (string version_name) data
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getEndpointUrl, getSupabaseClient, PRODUCT_ID } from './test-utils.ts'

// Use dedicated org for this test to avoid interference
const globalId = randomUUID()
const ORG_ID_VERSION_NAME = `a1b2c3d4-e5f6-7a8b-9c0d-${globalId.slice(24)}`
const STRIPE_CUSTOMER_ID_VERSION_NAME = `cus_version_name_${globalId.slice(0, 8)}`
const appId = `com.version.name.test.${globalId.slice(0, 8)}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

describe('version_name statistics tracking', () => {
  let versionId: number
  let channelId: number
  const versionName = '2.5.0-test'

  beforeAll(async () => {
    const supabase = getSupabaseClient()

    // Create stripe_info first (needed for org foreign key)
    // Set subscription_anchor_start and subscription_anchor_end for cycle info
    const now = new Date()
    const anchorStart = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000) // 15 days ago
    const anchorEnd = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000) // 15 days from now

    await supabase
      .from('stripe_info')
      .insert({
        customer_id: STRIPE_CUSTOMER_ID_VERSION_NAME,
        product_id: PRODUCT_ID,
        subscription_id: `sub_version_${globalId.slice(0, 8)}`,
        status: 'succeeded',
        trial_at: anchorEnd.toISOString(),
        subscription_anchor_start: anchorStart.toISOString(),
        subscription_anchor_end: anchorEnd.toISOString(),
      })
      .throwOnError()

    // Create test org
    await supabase
      .from('orgs')
      .insert({
        id: ORG_ID_VERSION_NAME,
        name: 'Version Name Test Org',
        management_email: 'version-name-test@test.com',
        created_by: '6aa76066-55ef-4238-ade6-0b32334a4097',
        customer_id: STRIPE_CUSTOMER_ID_VERSION_NAME,
      })
      .throwOnError()

    // Create test app
    await supabase
      .from('apps')
      .insert({
        app_id: appId,
        name: 'Version Name Test App',
        owner_org: ORG_ID_VERSION_NAME,
        icon_url: 'https://example.com/icon.png',
      })
      .throwOnError()

    // Create test version
    const { data: version } = await supabase
      .from('app_versions')
      .insert({
        app_id: appId,
        name: versionName,
        owner_org: ORG_ID_VERSION_NAME,
      })
      .select('id')
      .single()
      .throwOnError()

    versionId = version!.id

    // Create channel for the app
    const { data: channel } = await supabase
      .from('channels')
      .insert({
        name: 'production',
        app_id: appId,
        version: versionId,
        created_by: '6aa76066-55ef-4238-ade6-0b32334a4097',
        owner_org: ORG_ID_VERSION_NAME,
      })
      .select('id')
      .single()
      .throwOnError()

    channelId = channel!.id
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()

    // Clean up in reverse order of creation
    await supabase.from('daily_version').delete().eq('app_id', appId)
    await supabase.from('version_usage').delete().eq('app_id', appId)
    await supabase.from('channels').delete().eq('app_id', appId)
    await supabase.from('app_versions').delete().eq('app_id', appId)
    await supabase.from('apps').delete().eq('app_id', appId)
    await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID_VERSION_NAME)
    await supabase.from('orgs').delete().eq('id', ORG_ID_VERSION_NAME)
  })

  it('should store version_name in version_usage when stats are recorded', async () => {
    const supabase = getSupabaseClient()

    // Insert version_usage data with version_name directly
    const { error } = await supabase
      .from('version_usage')
      .insert({
        app_id: appId,
        version_name: versionName,
        action: 'get',
        timestamp: new Date().toISOString(),
      })

    expect(error).toBeNull()

    // Verify version_name is stored
    const { data, error: selectError } = await supabase
      .from('version_usage')
      .select('version_name')
      .eq('app_id', appId)
      .single()

    expect(selectError).toBeNull()
    expect(data?.version_name).toBe(versionName)
  })

  it('should populate daily_version with version_name after cron_stat_app', async () => {
    const supabase = getSupabaseClient()

    // Add more version_usage entries
    const now = new Date()
    const actions = ['get', 'install', 'fail', 'uninstall'] as const
    for (const action of actions) {
      await supabase
        .from('version_usage')
        .insert({
          app_id: appId,
          version_name: versionName,
          action,
          timestamp: now.toISOString(),
        })
        .throwOnError()
    }

    // Trigger cron_stat_app
    const response = await fetch(getEndpointUrl('/triggers/cron_stat_app'), {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        appId,
        orgId: ORG_ID_VERSION_NAME,
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as { status?: string }
    expect(json.status).toBe('Stats saved')

    // Verify daily_version has version_name
    const { data: dailyVersion, error: dailyError } = await supabase
      .from('daily_version')
      .select('*')
      .eq('app_id', appId)

    expect(dailyError).toBeNull()
    expect(dailyVersion).toBeTruthy()
    expect(dailyVersion!.length).toBeGreaterThan(0)

    // Check that version_name is set correctly
    const entry = dailyVersion![0]
    expect(entry.version_name).toBe(versionName)
  })

  it('should return version_name from read_version_usage function', async () => {
    const supabase = getSupabaseClient()

    // Get date range for the query
    const now = new Date()
    const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000) // 1 day ago
    const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000) // 1 day in future

    // Call read_version_usage function
    const { data, error } = await supabase.rpc('read_version_usage', {
      p_app_id: appId,
      p_period_start: startDate.toISOString().replace('T', ' ').replace('Z', ''),
      p_period_end: endDate.toISOString().replace('T', ' ').replace('Z', ''),
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data!.length).toBeGreaterThan(0)

    // Verify result contains version_name (not version_id)
    const result = data![0]
    expect(result.version_name).toBe(versionName)
    expect(result.app_id).toBe(appId)
  })

  it('should filter read_version_usage by channel_name', async () => {
    const supabase = getSupabaseClient()
    const now = new Date()
    const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    await supabase
      .from('version_usage')
      .insert([
        {
          app_id: appId,
          version_name: versionName,
          action: 'install',
          timestamp: now.toISOString(),
          channel_name: 'production',
        },
        {
          app_id: appId,
          version_name: versionName,
          action: 'install',
          timestamp: now.toISOString(),
          channel_name: 'beta',
        },
        {
          app_id: appId,
          version_name: versionName,
          action: 'fail',
          timestamp: now.toISOString(),
          channel_name: 'beta',
        },
      ])
      .throwOnError()

    const { data, error } = await supabase.rpc('read_version_usage', {
      p_app_id: appId,
      p_period_start: startDate.toISOString().replace('T', ' ').replace('Z', ''),
      p_period_end: endDate.toISOString().replace('T', ' ').replace('Z', ''),
      p_channel_name: 'production',
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data!.length).toBeGreaterThan(0)

    const installs = data!.reduce((total, row) => total + Number(row.install ?? 0), 0)
    const failures = data!.reduce((total, row) => total + Number(row.fail ?? 0), 0)
    expect(installs).toBe(1)
    expect(failures).toBe(0)
  })

  it('should filter read_version_usage by channel_id after channel rename', async () => {
    const supabase = getSupabaseClient()
    const now = new Date()
    const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    const endDate = new Date(now.getTime() + 24 * 60 * 60 * 1000)

    await supabase
      .from('version_usage')
      .insert([
        {
          app_id: appId,
          version_name: versionName,
          action: 'install',
          timestamp: now.toISOString(),
          channel_id: channelId,
          channel_name: 'production',
        },
        {
          app_id: appId,
          version_name: versionName,
          action: 'fail',
          timestamp: now.toISOString(),
          channel_id: channelId,
          channel_name: 'production-renamed',
        },
        {
          app_id: appId,
          version_name: versionName,
          action: 'fail',
          timestamp: now.toISOString(),
          channel_id: channelId + 9999,
          channel_name: 'production',
        },
      ])
      .throwOnError()

    const { data, error } = await supabase.rpc('read_version_usage', {
      p_app_id: appId,
      p_period_start: startDate.toISOString().replace('T', ' ').replace('Z', ''),
      p_period_end: endDate.toISOString().replace('T', ' ').replace('Z', ''),
      p_channel_id: channelId,
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()

    const installs = data!.reduce((total, row) => total + Number(row.install ?? 0), 0)
    const failures = data!.reduce((total, row) => total + Number(row.fail ?? 0), 0)
    expect(installs).toBe(1)
    expect(failures).toBe(1)
  })

  it('should handle daily_version upsert with version_name correctly', async () => {
    const supabase = getSupabaseClient()

    // Clear existing daily_version for this app
    await supabase
      .from('daily_version')
      .delete()
      .eq('app_id', appId)
      .throwOnError()

    // Insert a new daily_version entry with version_name only (no version_id)
    const today = new Date().toISOString().split('T')[0]

    // First insert
    const { error: insertError1 } = await supabase.from('daily_version')
      .upsert({
        app_id: appId,
        date: today,
        version_name: versionName,
        get: 10,
        fail: 1,
        install: 5,
        uninstall: 2,
      }, { onConflict: 'app_id,date,version_name' })

    expect(insertError1).toBeNull()

    // Second upsert with same key should update
    const { error: insertError2 } = await supabase.from('daily_version')
      .upsert({
        app_id: appId,
        date: today,
        version_name: versionName,
        get: 20,
        fail: 2,
        install: 10,
        uninstall: 4,
      }, { onConflict: 'app_id,date,version_name' })

    expect(insertError2).toBeNull()

    // Verify only one entry exists (upsert worked)
    const { data, error } = await supabase
      .from('daily_version')
      .select('*')
      .eq('app_id', appId)
      .eq('version_name', versionName)

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].get).toBe(20) // Should have the updated value
  })

  it('should handle multiple versions with different version_names', async () => {
    const supabase = getSupabaseClient()

    const version2Name = '3.0.0-beta'
    const today = new Date().toISOString().split('T')[0]

    // Create second version
    await supabase
      .from('app_versions')
      .insert({
        app_id: appId,
        name: version2Name,
        owner_org: ORG_ID_VERSION_NAME,
      })
      .throwOnError()

    // Insert daily_version for version 2
    await supabase.from('daily_version')
      .upsert({
        app_id: appId,
        date: today,
        version_name: version2Name,
        get: 15,
        fail: 0,
        install: 8,
        uninstall: 1,
      }, { onConflict: 'app_id,date,version_name' })
      .throwOnError()

    // Verify both versions exist
    const { data, error } = await supabase
      .from('daily_version')
      .select('version_name, get')
      .eq('app_id', appId)
      .eq('date', today)
      .order('version_name')

    expect(error).toBeNull()
    expect(data).toHaveLength(2)
    expect(data!.map(d => d.version_name).sort()).toEqual([version2Name, versionName].sort())
  })
})
