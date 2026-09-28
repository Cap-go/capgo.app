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

    await warmEdgeEndpoint('/triggers/cron_stat_app', {
      method: 'POST',
      headers: triggerHeaders,
      body: JSON.stringify({ appId, orgId: ORG_ID_CRON_APP }),
    })
  })

  beforeEach(async () => {
    const requestedAt = new Date(Date.now() - 60 * 1000).toISOString()
    await getSupabaseClient().from('orgs').update({ stats_updated_at: '2001-01-01T00:00:00Z' }).eq('id', ORG_ID_CRON_APP).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: requestedAt,
      stats_updated_at: null,
    }).eq('app_id', appId).throwOnError()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = NULL,
          stats_refresh_requested_at = NULL,
          manual_refresh_requested_at = NULL,
          plan_calculated_at = NULL
      WHERE org_id = $1
    `, [ORG_ID_CRON_APP])
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [ORG_ID_CRON_APP])
  })

  afterAll(async () => {
    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  it('marks the app fresh, lets the producer request the org, and completes it in cron_stat_org', async () => {
    const [orgBeforeRefresh] = await executeSQL<{
      stats_updated_at: string
      row_version: string
    }>(`
      SELECT stats_updated_at::text AS stats_updated_at,
             xmin::text AS row_version
      FROM public.orgs
      WHERE id = $1
    `, [ORG_ID_CRON_APP])

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
    expect(Date.parse(orgBeforeProducer?.stats_updated_at ?? '')).toBe(Date.parse(orgBeforeRefresh?.stats_updated_at ?? ''))

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

    const updatedAtMs = Date.parse(`${completedOrgState?.stats_updated_at}Z`)
    expect(Number.isNaN(updatedAtMs)).toBe(false)
    expect(Math.abs(Date.now() - updatedAtMs)).toBeLessThan(60_000)

    const [orgAfterRefresh] = await executeSQL<{
      stats_updated_at: string
      row_version: string
    }>(`
      SELECT stats_updated_at::text AS stats_updated_at,
             xmin::text AS row_version
      FROM public.orgs
      WHERE id = $1
    `, [ORG_ID_CRON_APP])
    expect(orgAfterRefresh).toEqual(orgBeforeRefresh)
  })

  it('queues plan processing through the producer after successful app stats', async () => {
    // Reset the org plan timestamp to ensure the producer can be exercised independently.
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET plan_calculated_at = NULL
      WHERE org_id = $1
    `, [ORG_ID_CRON_APP])

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
