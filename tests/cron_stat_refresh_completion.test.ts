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
  }, 30000)

  afterAll(async () => {
    await resetAppDataStats(firstAppId)
    await resetAppDataStats(secondAppId)
    await resetAppData(firstAppId)
    await resetAppData(secondAppId)
    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId)
    await getSupabaseClient().from('org_users').delete().eq('org_id', orgId)
    await getSupabaseClient().from('orgs').delete().eq('id', orgId)
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = $1', [customerId])
  }, 60000)

  it('updates app freshness immediately and only marks the org fresh after the last pending app completes', { timeout: 30000 }, async () => {
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

    const { data: orgAfterCompletion, error: orgAfterError } = await getSupabaseClient()
      .from('orgs')
      .select('stats_updated_at')
      .eq('id', orgId)
      .single()
    expect(orgAfterError).toBeNull()
    expect(orgAfterCompletion?.stats_updated_at).toBeTruthy()

    const { data: appsAfter, error: appsAfterError } = await getSupabaseClient()
      .from('apps')
      .select('app_id,updated_at')
      .in('app_id', [firstAppId, secondAppId])
      .order('app_id')
    expect(appsAfterError).toBeNull()
    expect(appsAfter).toEqual(appsBefore)
  })
})
