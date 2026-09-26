import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getEndpointUrl,
  getSupabaseClient,
  resetAndSeedAppData,
  resetAndSeedAppDataStats,
  resetAppData,
  resetAppDataStats,
} from './test-utils.ts'

const orgId = randomUUID()
const customerId = `cus_cron_refresh_${randomUUID().replace(/-/g, '').slice(0, 18)}`
const firstAppId = `com.cron.refresh.first.${randomUUID().slice(0, 8)}`
const secondAppId = `com.cron.refresh.second.${randomUUID().slice(0, 8)}`

const triggerHeaders = {
  'Content-Type': 'application/json',
  'apisecret': 'testsecret',
}

describe('cron_stat_app refresh completion', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(firstAppId, {
      orgId,
      stripeCustomerId: customerId,
    })
    await resetAndSeedAppData(secondAppId, {
      orgId,
      stripeCustomerId: customerId,
    })
    await resetAndSeedAppDataStats(firstAppId)
    await resetAndSeedAppDataStats(secondAppId)
  }, 60000)

  beforeEach(async () => {
    const requestedAt = new Date(Date.now() - 60 * 1000).toISOString()

    await getSupabaseClient().from('orgs').update({
      last_stats_updated_at: null,
      stats_refresh_requested_at: requestedAt,
      stats_updated_at: null,
    }).eq('id', orgId).throwOnError()

    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: requestedAt,
      stats_updated_at: null,
    }).in('app_id', [firstAppId, secondAppId]).throwOnError()

    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = NULL, stats_refresh_requested_at = NULL
      WHERE org_id = $1
    `, [orgId])
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [orgId])
  }, 30000)

  afterAll(async () => {
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [orgId])
    await resetAppDataStats(firstAppId)
    await resetAppDataStats(secondAppId)
    await resetAppData(firstAppId)
    await resetAppData(secondAppId)
    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId)
    await getSupabaseClient().from('org_users').delete().eq('org_id', orgId)
    await getSupabaseClient().from('orgs').delete().eq('id', orgId)
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  }, 60000)

  it('lets the minute producer queue org stats only after every requested app finishes', { timeout: 30000 }, async () => {
    const { data: appsBefore, error: appsBeforeError } = await getSupabaseClient()
      .from('apps')
      .select('app_id,updated_at')
      .in('app_id', [firstAppId, secondAppId])
      .order('app_id')
    expect(appsBeforeError).toBeNull()

    const firstResponse = await fetch(getEndpointUrl('/triggers/cron_stat_app'), {
      body: JSON.stringify({
        appId: firstAppId,
        orgId,
      }),
      headers: triggerHeaders,
      method: 'POST',
    })

    expect(firstResponse.status).toBe(200)

    const { data: firstAppState, error: firstAppError } = await getSupabaseClient()
      .from('app_stats_refresh_state')
      .select('stats_updated_at')
      .eq('app_id', firstAppId)
      .single()
    expect(firstAppError).toBeNull()
    expect(firstAppState?.stats_updated_at).toBeTruthy()

    const { data: secondAppStateBefore, error: secondAppBeforeError } = await getSupabaseClient()
      .from('app_stats_refresh_state')
      .select('stats_updated_at')
      .eq('app_id', secondAppId)
      .single()
    expect(secondAppBeforeError).toBeNull()
    expect(secondAppStateBefore?.stats_updated_at).toBeNull()

    const { data: orgBeforeCompletion, error: orgBeforeError } = await getSupabaseClient()
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', orgId)
      .single()
    expect(orgBeforeError).toBeNull()
    expect(orgBeforeCompletion?.stats_updated_at).toBeNull()

    const [pendingResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(pendingResult?.queued).toBe(0)

    const secondResponse = await fetch(getEndpointUrl('/triggers/cron_stat_app'), {
      body: JSON.stringify({
        appId: secondAppId,
        orgId,
      }),
      headers: triggerHeaders,
      method: 'POST',
    })

    expect(secondResponse.status).toBe(200)

    const { data: secondAppStateAfter, error: secondAppAfterError } = await getSupabaseClient()
      .from('app_stats_refresh_state')
      .select('stats_updated_at')
      .eq('app_id', secondAppId)
      .single()
    expect(secondAppAfterError).toBeNull()
    expect(secondAppStateAfter?.stats_updated_at).toBeTruthy()

    const { data: orgBeforeProducer, error: orgBeforeProducerError } = await getSupabaseClient()
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', orgId)
      .single()
    expect(orgBeforeProducerError).toBeNull()
    expect(orgBeforeProducer?.stats_updated_at).toBeNull()

    const [completedResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(completedResult?.queued).toBe(1)

    const [pendingOrgState] = await executeSQL<{
      stats_refresh_requested_at: string
      stats_updated_at: string | null
    }>(`
      SELECT stats_refresh_requested_at::text AS stats_refresh_requested_at,
             stats_updated_at::text AS stats_updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [orgId])
    expect(pendingOrgState?.stats_refresh_requested_at).toBeTruthy()
    expect(pendingOrgState?.stats_updated_at).toBeNull()

    const { data: orgAfterProducer, error: orgAfterProducerError } = await getSupabaseClient()
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', orgId)
      .single()
    expect(orgAfterProducerError).toBeNull()
    expect(orgAfterProducer?.stats_updated_at).toBeNull()

    const queuedMessages = await executeSQL<{ count: number }>(
      `SELECT COUNT(*)::integer AS count FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`,
      [orgId],
    )
    expect(queuedMessages[0]?.count).toBe(1)

    const orgResponse = await fetch(getEndpointUrl('/triggers/cron_stat_org'), {
      body: JSON.stringify({
        customerId,
        orgId,
        statsTargetAt: pendingOrgState?.stats_refresh_requested_at,
      }),
      headers: triggerHeaders,
      method: 'POST',
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
    `, [orgId])
    expect(completedOrgState?.stats_updated_at).toBe(completedOrgState?.stats_refresh_requested_at)

    const [repeatResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(repeatResult?.queued).toBe(0)

    const { data: appsAfter, error: appsAfterError } = await getSupabaseClient()
      .from('apps')
      .select('app_id,updated_at')
      .in('app_id', [firstAppId, secondAppId])
      .order('app_id')
    expect(appsAfterError).toBeNull()
    expect(appsAfter).toEqual(appsBefore)
  })

  it('keeps an org pending when an app was requested again after its latest completion', async () => {
    const orgWatermark = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const firstCompletedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const secondCompletedAt = new Date(Date.now() - 4 * 60 * 1000).toISOString()
    const secondRequestedAt = new Date(Date.now() - 60 * 1000).toISOString()

    await getSupabaseClient().from('orgs').update({ stats_updated_at: orgWatermark }).eq('id', orgId).throwOnError()
    await executeSQL(
      `UPDATE public.org_stats_refresh_state
       SET stats_updated_at = $2, stats_refresh_requested_at = $2
       WHERE org_id = $1`,
      [orgId, orgWatermark],
    )
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: firstCompletedAt,
      stats_updated_at: firstCompletedAt,
    }).eq('app_id', firstAppId).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: secondRequestedAt,
      stats_updated_at: secondCompletedAt,
    }).eq('app_id', secondAppId).throwOnError()

    const [pendingResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(pendingResult?.queued).toBe(0)

    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_updated_at: new Date().toISOString(),
    }).eq('app_id', secondAppId).throwOnError()

    const [completedResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(completedResult?.queued).toBe(1)
  })

  it('queues another org refresh when an app finishes during the previous org job', async () => {
    const orgWatermark = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const firstTarget = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const olderAppTarget = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    const laterTarget = new Date(Date.now() - 60 * 1000).toISOString()

    await getSupabaseClient().from('orgs').update({ stats_updated_at: orgWatermark }).eq('id', orgId).throwOnError()
    await executeSQL(
      `UPDATE public.org_stats_refresh_state
       SET stats_updated_at = $2, stats_refresh_requested_at = $2
       WHERE org_id = $1`,
      [orgId, orgWatermark],
    )
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: firstTarget,
      stats_updated_at: firstTarget,
    }).eq('app_id', firstAppId).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: olderAppTarget,
      stats_updated_at: olderAppTarget,
    }).eq('app_id', secondAppId).throwOnError()

    const [firstProducer] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(firstProducer?.queued).toBe(1)

    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: laterTarget,
      stats_updated_at: laterTarget,
    }).eq('app_id', secondAppId).throwOnError()

    const orgResponse = await fetch(getEndpointUrl('/triggers/cron_stat_org'), {
      body: JSON.stringify({ customerId, orgId, statsTargetAt: firstTarget }),
      headers: triggerHeaders,
      method: 'POST',
    })
    expect(orgResponse.status).toBe(200)
    await executeSQL(`DELETE FROM pgmq.q_cron_stat_org WHERE message->'payload'->>'orgId' = $1`, [orgId])

    const [afterFirstJob] = await executeSQL<{
      requested_at: string
      updated_at: string
    }>(`
      SELECT stats_refresh_requested_at::text AS requested_at,
             stats_updated_at::text AS updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [orgId])
    expect(new Date(`${afterFirstJob?.updated_at}Z`).toISOString()).toBe(firstTarget)
    expect(new Date(`${afterFirstJob?.requested_at}Z`).toISOString()).toBe(firstTarget)

    const [secondProducer] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(secondProducer?.queued).toBe(1)

    const [afterSecondProducer] = await executeSQL<{
      requested_at: string
      updated_at: string
    }>(`
      SELECT stats_refresh_requested_at::text AS requested_at,
             stats_updated_at::text AS updated_at
      FROM public.org_stats_refresh_state
      WHERE org_id = $1
    `, [orgId])
    expect(new Date(`${afterSecondProducer?.updated_at}Z`).toISOString()).toBe(firstTarget)
    expect(new Date(`${afterSecondProducer?.requested_at}Z`).toISOString()).toBe(laterTarget)
  })

  it('requeues an unfinished org target when its live queue message is gone', async () => {
    const completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const requestedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    await executeSQL(
      `UPDATE public.org_stats_refresh_state
       SET stats_updated_at = $2, stats_refresh_requested_at = $3
       WHERE org_id = $1`,
      [orgId, completedAt, requestedAt],
    )

    const [producerResult] = await executeSQL<{ queued: number }>(
      'SELECT public.process_cron_stat_org_jobs(500, $1) AS queued',
      [orgId],
    )
    expect(producerResult?.queued).toBe(1)

    const [message] = await executeSQL<{ target_at: string }>(`
      SELECT message->'payload'->>'statsTargetAt' AS target_at
      FROM pgmq.q_cron_stat_org
      WHERE message->'payload'->>'orgId' = $1
    `, [orgId])
    expect(new Date(`${message?.target_at}Z`).toISOString()).toBe(requestedAt)
  })

  it('registers the producer to run once per minute', async () => {
    const rows = await executeSQL<{
      enabled: boolean
      minute_interval: number
      target: string
    }>(`SELECT enabled, minute_interval, target FROM public.cron_tasks WHERE name = 'produce_org_stats_jobs'`)

    expect(rows).toEqual([{
      enabled: true,
      minute_interval: 1,
      target: 'public.process_cron_stat_org_jobs()',
    }])
  })

  it('keeps org refresh coordination private and off replication', async () => {
    const [result] = await executeSQL<{
      anon_select: boolean
      authenticated_select: boolean
      published: boolean
      state_exists: boolean
    }>(`
      SELECT
        has_table_privilege('anon', 'public.org_stats_refresh_state', 'SELECT') AS anon_select,
        has_table_privilege('authenticated', 'public.org_stats_refresh_state', 'SELECT') AS authenticated_select,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_publication_tables
          WHERE schemaname = 'public' AND tablename = 'org_stats_refresh_state'
        ) AS published,
        EXISTS (
          SELECT 1 FROM public.org_stats_refresh_state WHERE org_id = $1
        ) AS state_exists
    `, [orgId])

    expect(result).toEqual({
      anon_select: false,
      authenticated_select: false,
      published: false,
      state_exists: true,
    })
  })
})
