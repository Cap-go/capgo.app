import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, ORG_ID_CRON_INTEGRATION, STRIPE_CUSTOMER_ID_CRON_INTEGRATION, USER_ID, executeSQL, getSupabaseClient, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats } from './test-utils.ts'

const appId = `com.cron.${randomUUID().slice(0, 8)}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

describe('[Integration] cron_stat_app -> cron_stat_org flow', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(appId, {
      orgId: ORG_ID_CRON_INTEGRATION,
      stripeCustomerId: STRIPE_CUSTOMER_ID_CRON_INTEGRATION,
    })
    await resetAndSeedAppDataStats(appId)

    const supabase = getSupabaseClient()

    // Reset timestamps
    await supabase
      .from('orgs')
      .update({ stats_updated_at: null })
      .eq('id', ORG_ID_CRON_INTEGRATION)
      .throwOnError()
    await supabase.from('app_stats_refresh_state').update({
      stats_refresh_requested_at: new Date(Date.now() - 60 * 1000).toISOString(),
      stats_updated_at: null,
    }).eq('app_id', appId).throwOnError()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = NULL, stats_refresh_requested_at = NULL
      WHERE org_id = $1
    `, [ORG_ID_CRON_INTEGRATION])
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [ORG_ID_CRON_INTEGRATION])

    // Reset plan calculated timestamp
    await supabase
      .from('stripe_info')
      .update({ plan_calculated_at: null })
      .eq('customer_id', STRIPE_CUSTOMER_ID_CRON_INTEGRATION)
      .throwOnError()
  })

  afterAll(async () => {
    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  it('cron_stat_app triggers plan processing and updates plan_calculated_at', async () => {
    const supabase = getSupabaseClient()

    // First, get the actual customer_id for our test org
    const { data: orgData } = await supabase
      .from('orgs')
      .select('customer_id')
      .eq('id', ORG_ID_CRON_INTEGRATION)
      .single()
      .throwOnError()

    console.log('Test org customer_id:', orgData?.customer_id)

    // Skip test if no customer_id (this org doesn't have stripe setup)
    if (!orgData?.customer_id) {
      console.log('Skipping test - org has no customer_id')
      return
    }

    // Reset plan_calculated_at to null for this customer
    await supabase
      .from('stripe_info')
      .update({ plan_calculated_at: null })
      .eq('customer_id', orgData.customer_id)
      .throwOnError()

    // Verify initial state - no plan_calculated_at
    const { data: initialStripeInfo } = await supabase
      .from('stripe_info')
      .select('plan_calculated_at')
      .eq('customer_id', orgData.customer_id)
      .single()
      .throwOnError()

    expect(initialStripeInfo?.plan_calculated_at).toBeNull()

    // Trigger app aggregation; PostgreSQL produces the org job afterward.
    const statsResponse = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        appId,
        orgId: ORG_ID_CRON_INTEGRATION,
      }),
    })

    expect(statsResponse.status).toBe(200)
    const statsJson = await statsResponse.json() as { status?: string }
    expect(statsJson.status).toBe('Stats saved')

    const [{ queued }] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [ORG_ID_CRON_INTEGRATION],
    )
    expect(queued).toBe(1)

    // The producer requests the org refresh without marking it complete.
    const { data: org } = await supabase
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', ORG_ID_CRON_INTEGRATION)
      .single()
      .throwOnError()

    expect(org?.stats_updated_at).toBeNull()

    const [pendingOrgState] = await executeSQL<{
      stats_refresh_requested_at: string
      stats_updated_at: string | null
    }>(`
      SELECT stats_refresh_requested_at::text AS stats_refresh_requested_at,
             stats_updated_at::text AS stats_updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [ORG_ID_CRON_INTEGRATION])
    expect(pendingOrgState?.stats_refresh_requested_at).toBeTruthy()
    expect(pendingOrgState?.stats_updated_at).toBeNull()

    // Check that a plan job was queued (we can't easily test queue contents, but we can verify the function doesn't error)
    // The plan processing would normally be triggered by the queue processor

    // Manually trigger cron_plan to simulate queue processing
    const planResponse = await fetch(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        orgId: ORG_ID_CRON_INTEGRATION,
        customerId: orgData.customer_id,
        statsTargetAt: pendingOrgState?.stats_refresh_requested_at,
      }),
    })

    expect(planResponse.status).toBe(200)

    const [completedOrgState] = await executeSQL<{
      stats_refresh_requested_at: string
      stats_updated_at: string
    }>(`
      SELECT stats_refresh_requested_at::text AS stats_refresh_requested_at,
             stats_updated_at::text AS stats_updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [ORG_ID_CRON_INTEGRATION])
    expect(completedOrgState?.stats_updated_at).toBe(completedOrgState?.stats_refresh_requested_at)

    // Verify plan_calculated_at was updated
    const { data: updatedStripeInfo } = await supabase
      .from('stripe_info')
      .select('plan_calculated_at')
      .eq('customer_id', orgData.customer_id)
      .single()
      .throwOnError()

    expect(updatedStripeInfo?.plan_calculated_at).toBeTruthy()

    const timestamp = updatedStripeInfo?.plan_calculated_at
    const updatedAtMs = new Date(timestamp!).getTime()
    expect(Number.isNaN(updatedAtMs)).toBe(false)

    const diffMs = Math.abs(Date.now() - updatedAtMs)
    expect(diffMs).toBeLessThan(60_000) // Within last minute
  })

  it('rate limiting prevents duplicate plan processing within 1 hour', async () => {
    const supabase = getSupabaseClient()

    // Get the actual customer_id for our test org
    const { data: orgData } = await supabase
      .from('orgs')
      .select('customer_id')
      .eq('id', ORG_ID_CRON_INTEGRATION)
      .single()
      .throwOnError()

    // Skip test if no customer_id
    if (!orgData?.customer_id) {
      console.log('Skipping test - org has no customer_id')
      return
    }

    // Set plan_calculated_at to 30 minutes ago (within 1 hour)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)
    await supabase
      .from('stripe_info')
      .update({ plan_calculated_at: thirtyMinutesAgo.toISOString() })
      .eq('customer_id', orgData.customer_id)
      .throwOnError()

    // Call the queue function directly (simulating what cron_stat_app does)
    const { error } = await supabase.rpc('queue_cron_stat_org_for_org', {
      org_id: ORG_ID_CRON_INTEGRATION,
      customer_id: orgData.customer_id,
    })

    // Should not error (rate limiting should silently skip)
    expect(error).toBeNull()

    // The timestamp should remain unchanged (not updated)
    const { data: stripeInfo } = await supabase
      .from('stripe_info')
      .select('plan_calculated_at')
      .eq('customer_id', orgData.customer_id)
      .single()
      .throwOnError()

    const actualTimestamp = new Date(stripeInfo?.plan_calculated_at ?? 0).getTime()
    const expectedTimestamp = thirtyMinutesAgo.getTime()

    // Should be within 1 second of the original timestamp (accounting for precision)
    expect(Math.abs(actualTimestamp - expectedTimestamp)).toBeLessThan(1000)
  })

  it('allows plan processing after 1 hour has passed', async () => {
    const supabase = getSupabaseClient()

    // Get the actual customer_id for our test org
    const { data: orgData } = await supabase
      .from('orgs')
      .select('customer_id')
      .eq('id', ORG_ID_CRON_INTEGRATION)
      .single()
      .throwOnError()

    // Skip test if no customer_id
    if (!orgData?.customer_id) {
      console.log('Skipping test - org has no customer_id')
      return
    }

    // Set plan_calculated_at to 2 hours ago (outside 1 hour window)
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await supabase
      .from('stripe_info')
      .update({ plan_calculated_at: twoHoursAgo.toISOString() })
      .eq('customer_id', orgData.customer_id)
      .throwOnError()

    // Call the queue function directly
    const { error } = await supabase.rpc('queue_cron_stat_org_for_org', {
      org_id: ORG_ID_CRON_INTEGRATION,
      customer_id: orgData.customer_id,
    })

    expect(error).toBeNull()

    // Now manually trigger plan processing to simulate queue processing
    const planResponse = await fetch(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        orgId: ORG_ID_CRON_INTEGRATION,
        customerId: orgData.customer_id,
      }),
    })

    expect(planResponse.status).toBe(200)

    // Verify plan_calculated_at was updated to recent time
    const { data: stripeInfo } = await supabase
      .from('stripe_info')
      .select('plan_calculated_at')
      .eq('customer_id', orgData.customer_id)
      .single()
      .throwOnError()

    const timestamp = stripeInfo?.plan_calculated_at
    const updatedAtMs = new Date(timestamp!).getTime()
    const diffMs = Math.abs(Date.now() - updatedAtMs)

    // Should be updated to within the last minute
    expect(diffMs).toBeLessThan(60_000)
  })

  it('handles missing customer_id gracefully', async () => {
    // Trigger cron_stat_app for an org without customer_id
    const supabase = getSupabaseClient()

    // Create a temporary org without customer_id
    const tempOrgId = randomUUID()
    await supabase
      .from('orgs')
      .insert({
        id: tempOrgId,
        name: `Test Org No Customer ${tempOrgId}`,
        management_email: 'test@example.com',
        created_by: USER_ID,
      })
      .throwOnError()

    // Create app for this org
    const tempAppId = `com.test.nocustomer.${randomUUID()}`
    await supabase
      .from('apps')
      .insert({
        app_id: tempAppId,
        owner_org: tempOrgId,
        name: 'Test App No Customer',
        icon_url: 'https://example.com/icon.png',
      })
      .throwOnError()

    // Create app version
    await supabase
      .from('app_versions')
      .insert({
        app_id: tempAppId,
        name: '1.0.0',
        owner_org: tempOrgId,
      })
      .throwOnError()

    // Trigger cron_stat_app - should not error even without customer_id
    const statsResponse = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        appId: tempAppId,
        orgId: tempOrgId,
      }),
    })

    expect(statsResponse.status).toBe(200)

    // Clean up
    await supabase.from('app_versions').delete().eq('app_id', tempAppId).throwOnError()
    await supabase.from('apps').delete().eq('app_id', tempAppId).throwOnError()
    await supabase.from('orgs').delete().eq('id', tempOrgId).throwOnError()
  })
})
