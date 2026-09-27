import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { BASE_URL, ORG_ID_CRON_APP, STRIPE_CUSTOMER_ID_CRON_APP, executeSQL, getSupabaseClient, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats, warmEdgeEndpoint } from './test-utils.ts'

const appId = `com.cron.${randomUUID().slice(0, 8)}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

describe('[POST] /triggers/cron_stat_app', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(appId, {
      orgId: ORG_ID_CRON_APP,
      stripeCustomerId: STRIPE_CUSTOMER_ID_CRON_APP,
    })
    await resetAndSeedAppDataStats(appId)

    const supabase = getSupabaseClient()
    const { error } = await supabase
      .from('orgs')
      .update({ stats_updated_at: null })
      .eq('id', ORG_ID_CRON_APP)
    if (error)
      throw error

    await warmEdgeEndpoint('/triggers/cron_stat_app', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId, orgId: ORG_ID_CRON_APP }),
    })
  })

  beforeEach(async () => {
    const requestedAt = new Date(Date.now() - 60 * 1000).toISOString()
    await getSupabaseClient().from('orgs').update({ stats_updated_at: null }).eq('id', ORG_ID_CRON_APP).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: requestedAt,
      stats_updated_at: null,
    }).eq('app_id', appId).throwOnError()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = NULL, stats_refresh_requested_at = NULL
      WHERE org_id = $1
    `, [ORG_ID_CRON_APP])
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [ORG_ID_CRON_APP])
  })

  afterAll(async () => {
    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  it('marks the app fresh, lets the producer request the org, and completes it in cron_stat_org', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        appId,
        orgId: ORG_ID_CRON_APP,
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as { status?: string }
    expect(json.status).toBe('Stats saved')

    const supabase = getSupabaseClient()
    const { data: appState, error: appStateError } = await supabase
      .from('app_stats_refresh_state')
      .select('stats_updated_at')
      .eq('app_id', appId)
      .single()
    expect(appStateError).toBeNull()
    expect(appState?.stats_updated_at).toBeTruthy()

    const { data: orgBeforeProducer, error: orgBeforeProducerError } = await supabase
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', ORG_ID_CRON_APP)
      .single()
    expect(orgBeforeProducerError).toBeNull()
    expect(orgBeforeProducer?.stats_updated_at).toBeNull()

    await executeSQL('SELECT public.process_cron_stat_org_jobs(500, $1)', [ORG_ID_CRON_APP])

    const [pendingOrgState] = await executeSQL<{
      stats_refresh_requested_at: string
      stats_updated_at: string | null
    }>(`
      SELECT stats_refresh_requested_at::text AS stats_refresh_requested_at,
             stats_updated_at::text AS stats_updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [ORG_ID_CRON_APP])
    expect(pendingOrgState?.stats_refresh_requested_at).toBeTruthy()
    expect(pendingOrgState?.stats_updated_at).toBeNull()

    const orgResponse = await fetch(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        orgId: ORG_ID_CRON_APP,
        customerId: STRIPE_CUSTOMER_ID_CRON_APP,
        statsTargetAt: pendingOrgState?.stats_refresh_requested_at,
      }),
    })
    expect(orgResponse.status).toBe(200)

    const { data: org, error } = await supabase
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', ORG_ID_CRON_APP)
      .single()
    expect(error).toBeNull()
    expect(org?.stats_updated_at).toBeTruthy()

    const timestamp = org?.stats_updated_at
    expect(timestamp).toBeTruthy()

    const updatedAtMs = Date.parse(`${timestamp}Z`)
    expect(Number.isNaN(updatedAtMs)).toBe(false)

    const diffMs = Math.abs(Date.now() - updatedAtMs)
    expect(diffMs).toBeLessThan(60_000)

    const [completedOrgState] = await executeSQL<{
      stats_refresh_requested_at: string
      stats_updated_at: string
    }>(`
      SELECT stats_refresh_requested_at::text AS stats_refresh_requested_at,
             stats_updated_at::text AS stats_updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [ORG_ID_CRON_APP])
    expect(completedOrgState?.stats_updated_at).toBe(completedOrgState?.stats_refresh_requested_at)
  })

  it('queues plan processing through the producer after successful app stats', async () => {
    const supabase = getSupabaseClient()

    // Reset plan_calculated_at to ensure we can detect if it gets queued
    await supabase
      .from('stripe_info')
      .update({ plan_calculated_at: null })
      .eq('customer_id', STRIPE_CUSTOMER_ID_CRON_APP)
      .throwOnError()

    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({
        appId,
        orgId: ORG_ID_CRON_APP,
      }),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as { status?: string }
    expect(json.status).toBe('Stats saved')

    await executeSQL('SELECT public.process_cron_stat_org_jobs(500, $1)', [ORG_ID_CRON_APP])

    const [{ count }] = await executeSQL<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`,
      [ORG_ID_CRON_APP],
    )
    expect(count).toBe(1)
  })
})
