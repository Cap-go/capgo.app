import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
  resetAndSeedAppDataStats,
  resetAppDataStats,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_EMAIL,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const orgId = randomUUID()
const staleAppId = `com.chart.refresh.stale.${randomUUID().slice(0, 8)}`
const freshAppId = `com.chart.refresh.fresh.${randomUUID().slice(0, 8)}`

function createAuthClient() {
  return createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
  })
}

async function clearCronStatAppMessages(appIds: string[]) {
  await executeSQL(
    `DELETE FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = ANY($1::text[])`,
    [appIds],
  )
}

async function countCronStatAppMessages(appId: string): Promise<number> {
  const rows = await executeSQL(
    `SELECT COUNT(*)::integer AS count FROM pgmq.q_cron_stat_app WHERE message->'payload'->>'appId' = $1`,
    [appId],
  )
  return rows[0]?.count ?? 0
}

async function countStatsRefreshAuditLogs(): Promise<number> {
  const rows = await executeSQL(
    `SELECT COUNT(*)::integer AS count
     FROM public.audit_logs
     WHERE org_id = $1::uuid
       AND operation = 'UPDATE'
       AND table_name IN ('apps', 'orgs')
       AND changed_fields && ARRAY['stats_refresh_requested_at', 'stats_updated_at']::text[]
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(changed_fields) AS changed_field(field_name)
         WHERE changed_field.field_name <> ALL(ARRAY['stats_refresh_requested_at', 'stats_updated_at', 'updated_at']::text[])
       )`,
    [orgId],
  )
  return rows[0]?.count ?? 0
}

async function getAppRefreshState(appId: string) {
  const { data, error } = await getSupabaseClient()
    .from('app_stats_refresh_state')
    .select('stats_refresh_requested_at,stats_updated_at')
    .eq('app_id', appId)
    .single()

  if (error)
    throw error

  return data
}

async function getOrgRefreshState() {
  const [state] = await executeSQL<{
    manual_refresh_requested_at: string | null
    stats_refresh_requested_at: string | null
    stats_updated_at: string | null
  }>(`
    SELECT manual_refresh_requested_at::text AS manual_refresh_requested_at,
           stats_refresh_requested_at::text AS stats_refresh_requested_at,
           stats_updated_at::text AS stats_updated_at
    FROM public.org_stats_refresh_state
    WHERE org_id = $1
  `, [orgId])

  return state
}

async function getLegacyOrgRefreshState() {
  const [state] = await executeSQL<{
    last_stats_updated_at: string | null
    stats_refresh_requested_at: string | null
    stats_updated_at: string | null
    xmin: string
  }>(`
    SELECT xmin::text AS xmin,
           last_stats_updated_at::text AS last_stats_updated_at,
           stats_refresh_requested_at::text AS stats_refresh_requested_at,
           stats_updated_at::text AS stats_updated_at
    FROM public.orgs
    WHERE id = $1
  `, [orgId])

  return state
}

async function getDateRangeMetrics(scope: 'app' | 'org', metricDateText: string) {
  if (scope === 'app') {
    return getSupabaseClient().rpc('get_app_metrics', {
      p_app_id: staleAppId,
      p_end_date: metricDateText,
      p_org_id: orgId,
      p_start_date: metricDateText,
    })
  }

  return getSupabaseClient().rpc('get_app_metrics', {
    end_date: metricDateText,
    org_id: orgId,
    start_date: metricDateText,
  })
}

describe('chart refresh RPCs', () => {
  const authorizedClient = createAuthClient()
  const unauthorizedClient = createAuthClient()

  beforeAll(async () => {
    const { error: authorizedSignInError } = await authorizedClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    expect(authorizedSignInError).toBeNull()

    const { error: unauthorizedSignInError } = await unauthorizedClient.auth.signInWithPassword({
      email: USER_EMAIL_NONMEMBER,
      password: USER_PASSWORD_NONMEMBER,
    })
    expect(unauthorizedSignInError).toBeNull()

    await getSupabaseClient().from('orgs').insert({
      created_by: USER_ID,
      id: orgId,
      management_email: USER_EMAIL,
      name: `Chart Refresh Org ${orgId}`,
      updated_at: new Date().toISOString(),
    }).throwOnError()

    await getSupabaseClient().from('org_users').insert({
      org_id: orgId,
      user_id: USER_ID,
      rbac_role_name: 'org_super_admin',
    }).throwOnError()

    await getSupabaseClient().from('apps').insert([
      {
        app_id: staleAppId,
        created_at: new Date().toISOString(),
        icon_url: '',
        last_version: '1.0.0',
        name: 'Stale Chart Refresh App',
        owner_org: orgId,
        updated_at: new Date().toISOString(),
        user_id: USER_ID,
      },
      {
        app_id: freshAppId,
        created_at: new Date().toISOString(),
        icon_url: '',
        last_version: '1.0.0',
        name: 'Fresh Chart Refresh App',
        owner_org: orgId,
        updated_at: new Date().toISOString(),
        user_id: USER_ID,
      },
    ]).throwOnError()

    await resetAndSeedAppDataStats(staleAppId)
  })

  beforeEach(async () => {
    await clearCronStatAppMessages([staleAppId, freshAppId])

    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId).throwOnError()
    await getSupabaseClient().from('orgs').update({
      stats_refresh_requested_at: null,
      stats_updated_at: null,
    }).eq('id', orgId).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: null,
      stats_updated_at: null,
    }).in('app_id', [staleAppId, freshAppId]).throwOnError()
    await executeSQL(`
      INSERT INTO public.org_stats_refresh_state (
        org_id, manual_refresh_requested_at, stats_refresh_requested_at, stats_updated_at
      ) VALUES ($1, NULL, NULL, NULL)
      ON CONFLICT (org_id) DO UPDATE SET
        manual_refresh_requested_at = NULL,
        stats_refresh_requested_at = NULL,
        stats_updated_at = NULL
    `, [orgId])
    await getSupabaseClient().from('audit_logs').delete().eq('org_id', orgId).throwOnError()
  })

  afterAll(async () => {
    await clearCronStatAppMessages([staleAppId, freshAppId])
    await resetAppDataStats(staleAppId)
    await getSupabaseClient().from('app_metrics_cache').delete().eq('org_id', orgId)
    await getSupabaseClient().from('apps').delete().in('app_id', [staleAppId, freshAppId])
    await getSupabaseClient().from('org_users').delete().eq('org_id', orgId)
    await getSupabaseClient().from('orgs').delete().eq('id', orgId)
    await authorizedClient.auth.signOut()
    await unauthorizedClient.auth.signOut()
  })

  it('queue_cron_stat_app_for_app only stamps refresh_requested_at when it enqueues work', async () => {
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }).eq('app_id', staleAppId).throwOnError()

    const { data: appBefore } = await getSupabaseClient()
      .from('apps')
      .select('updated_at')
      .eq('app_id', staleAppId)
      .single()

    await getSupabaseClient().rpc('queue_cron_stat_app_for_app', {
      p_app_id: staleAppId,
      p_org_id: orgId,
    }).throwOnError()

    const queuedState = await getAppRefreshState(staleAppId)
    expect(queuedState?.stats_refresh_requested_at).toBeTruthy()
    expect(await countCronStatAppMessages(staleAppId)).toBe(1)

    const { data: appAfter } = await getSupabaseClient()
      .from('apps')
      .select('updated_at')
      .eq('app_id', staleAppId)
      .single()
    expect(appAfter?.updated_at).toBe(appBefore?.updated_at)

    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: null,
      stats_updated_at: new Date().toISOString(),
    }).eq('app_id', freshAppId).throwOnError()

    await getSupabaseClient().rpc('queue_cron_stat_app_for_app', {
      p_app_id: freshAppId,
      p_org_id: orgId,
    }).throwOnError()

    const skippedState = await getAppRefreshState(freshAppId)
    expect(skippedState?.stats_refresh_requested_at).toBeNull()
    expect(await countCronStatAppMessages(freshAppId)).toBe(0)
  })

  it('only returns app refresh state to users who can read the app', async () => {
    const { data: authorizedState, error: authorizedError } = await authorizedClient
      .rpc('get_app_stats_refresh_state', { p_app_id: staleAppId })
      .single()
    expect(authorizedError).toBeNull()
    expect(authorizedState?.owner_org).toBe(orgId)

    const { data: unauthorizedState, error: unauthorizedError } = await unauthorizedClient
      .rpc('get_app_stats_refresh_state', { p_app_id: staleAppId })
      .maybeSingle()
    expect(unauthorizedError).toBeNull()
    expect(unauthorizedState).toBeNull()
  })

  it('request_app_chart_refresh queues once when stale and rejects users without access', async () => {
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }).eq('app_id', staleAppId).throwOnError()

    const { data: firstResponse, error: firstError } = await authorizedClient.rpc('request_app_chart_refresh', {
      app_id: staleAppId,
    }).single()

    expect(firstError).toBeNull()
    expect(firstResponse?.queued_app_ids).toEqual([staleAppId])
    expect(firstResponse?.queued_count).toBe(1)
    expect(firstResponse?.skipped_count).toBe(0)
    expect(await countCronStatAppMessages(staleAppId)).toBe(1)
    expect(await countStatsRefreshAuditLogs()).toBe(0)

    const { data: secondResponse, error: secondError } = await authorizedClient.rpc('request_app_chart_refresh', {
      app_id: staleAppId,
    }).single()

    expect(secondError).toBeNull()
    expect(secondResponse?.queued_count).toBe(0)
    expect(secondResponse?.skipped_count).toBe(1)
    expect(await countCronStatAppMessages(staleAppId)).toBe(1)

    const { data: deniedData, error: deniedError } = await unauthorizedClient.rpc('request_app_chart_refresh', {
      app_id: staleAppId,
    }).single()

    expect(deniedData).toBeNull()
    expect(deniedError?.message).toContain('App access denied')
  })

  it('request_org_chart_refresh stamps org refresh state and only queues stale apps', async () => {
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_updated_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    }).eq('app_id', staleAppId).throwOnError()
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_updated_at: new Date().toISOString(),
    }).eq('app_id', freshAppId).throwOnError()

    const legacyStateBefore = await getLegacyOrgRefreshState()
    const { data, error } = await authorizedClient.rpc('request_org_chart_refresh', {
      org_id: orgId,
    }).single()

    expect(error).toBeNull()
    expect(data?.queued_app_ids).toEqual([staleAppId])
    expect(data?.queued_count).toBe(1)
    expect(data?.skipped_count).toBe(1)
    expect(data?.requested_at).toBeTruthy()

    const orgState = await getOrgRefreshState()
    expect(orgState?.manual_refresh_requested_at).toBeTruthy()
    expect(orgState?.stats_refresh_requested_at).toBeNull()
    expect(await getLegacyOrgRefreshState()).toEqual(legacyStateBefore)

    const staleState = await getAppRefreshState(staleAppId)
    const freshState = await getAppRefreshState(freshAppId)
    expect(staleState?.stats_refresh_requested_at).toBeTruthy()
    expect(freshState?.stats_refresh_requested_at).toBeNull()
    expect(await countCronStatAppMessages(staleAppId)).toBe(1)
    expect(await countCronStatAppMessages(freshAppId)).toBe(0)
    expect(await countStatsRefreshAuditLogs()).toBe(0)
  })

  it('request_org_chart_refresh preserves the current org request marker when no apps are queued', async () => {
    const inProgressRequestedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString()

    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET manual_refresh_requested_at = $2
      WHERE org_id = $1
    `, [orgId, inProgressRequestedAt])
    await getSupabaseClient().from('app_stats_refresh_state').update({
      stats_refresh_requested_at: inProgressRequestedAt,
      stats_updated_at: new Date().toISOString(),
    }).in('app_id', [staleAppId, freshAppId]).throwOnError()

    const beforeOrgState = await getOrgRefreshState()
    const legacyStateBefore = await getLegacyOrgRefreshState()
    expect(beforeOrgState?.manual_refresh_requested_at).toBeTruthy()

    const { data, error } = await authorizedClient.rpc('request_org_chart_refresh', {
      org_id: orgId,
    }).single()

    expect(error).toBeNull()
    expect(data?.queued_app_ids).toEqual([])
    expect(data?.queued_count).toBe(0)
    expect(data?.skipped_count).toBe(2)
    expect(new Date(`${data?.requested_at}Z`).toISOString()).toBe(inProgressRequestedAt)

    const afterOrgState = await getOrgRefreshState()
    expect(afterOrgState).toEqual(beforeOrgState)
    expect(await getLegacyOrgRefreshState()).toEqual(legacyStateBefore)
    expect(await countCronStatAppMessages(staleAppId)).toBe(0)
    expect(await countCronStatAppMessages(freshAppId)).toBe(0)
  })

  it('returns org refresh state only to callers with org.read access', async () => {
    const updatedAt = new Date(Date.now() - 60_000).toISOString()
    const requestedAt = new Date().toISOString()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = $2, manual_refresh_requested_at = $3
      WHERE org_id = $1
    `, [orgId, updatedAt, requestedAt])

    const { data: authorizedState, error: authorizedError } = await authorizedClient
      .rpc('get_org_stats_refresh_state', { p_org_id: orgId })
      .single()
    expect(authorizedError).toBeNull()
    expect(new Date(`${authorizedState?.stats_updated_at}Z`).toISOString()).toBe(updatedAt)
    expect(new Date(`${authorizedState?.stats_refresh_requested_at}Z`).toISOString()).toBe(requestedAt)

    const { data: unauthorizedState, error: unauthorizedError } = await unauthorizedClient
      .rpc('get_org_stats_refresh_state', { p_org_id: orgId })
      .maybeSingle()
    expect(unauthorizedError).toBeNull()
    expect(unauthorizedState).toBeNull()

    const { error: directReadError } = await authorizedClient
      .from('org_stats_refresh_state')
      .select('org_id')
      .eq('org_id', orgId)
    expect(directReadError).not.toBeNull()
  })

  it('keeps org refresh state private and outside logical replication publications', async () => {
    const [privileges] = await executeSQL<{
      anon_select: boolean
      authenticated_select: boolean
    }>(`
      SELECT
        has_table_privilege('anon', 'public.org_stats_refresh_state', 'SELECT') AS anon_select,
        has_table_privilege('authenticated', 'public.org_stats_refresh_state', 'SELECT') AS authenticated_select
    `)
    const publicationRows = await executeSQL(`
      SELECT pubname
      FROM pg_catalog.pg_publication_tables
      WHERE schemaname = 'public'
        AND tablename = 'org_stats_refresh_state'
    `)

    expect(privileges).toEqual({
      anon_select: false,
      authenticated_select: false,
    })
    expect(publicationRows).toEqual([])
  })

  it('get_orgs_v7 returns state timestamps and falls back only when the state row is missing', async () => {
    const legacyUpdatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const legacyRequestedAt = new Date(Date.now() - 9 * 60 * 1000).toISOString()
    const stateUpdatedAt = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    const stateRequestedAt = new Date(Date.now() - 60 * 1000).toISOString()

    await getSupabaseClient().from('orgs').update({
      stats_refresh_requested_at: legacyRequestedAt,
      stats_updated_at: legacyUpdatedAt,
    }).eq('id', orgId).throwOnError()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = $2, manual_refresh_requested_at = $3,
          stats_refresh_requested_at = $2
      WHERE org_id = $1
    `, [orgId, stateUpdatedAt, stateRequestedAt])

    const { data: stateRows, error: stateError } = await authorizedClient.rpc('get_orgs_v7')
    expect(stateError).toBeNull()
    const stateOrg = stateRows?.find(org => org.gid === orgId)
    expect(new Date(`${stateOrg?.stats_updated_at}Z`).toISOString()).toBe(stateUpdatedAt)
    expect(new Date(`${stateOrg?.stats_refresh_requested_at}Z`).toISOString()).toBe(stateRequestedAt)

    const { data: stateUserRows, error: stateUserError } = await getSupabaseClient().rpc('get_orgs_v7', {
      userid: USER_ID,
    })
    expect(stateUserError).toBeNull()
    const stateUserOrg = stateUserRows?.find(org => org.gid === orgId)
    expect(new Date(`${stateUserOrg?.stats_updated_at}Z`).toISOString()).toBe(stateUpdatedAt)
    expect(new Date(`${stateUserOrg?.stats_refresh_requested_at}Z`).toISOString()).toBe(stateRequestedAt)

    await executeSQL('DELETE FROM public.org_stats_refresh_state WHERE org_id = $1', [orgId])
    const { data: fallbackRows, error: fallbackError } = await authorizedClient.rpc('get_orgs_v7')
    expect(fallbackError).toBeNull()
    const fallbackOrg = fallbackRows?.find(org => org.gid === orgId)
    expect(new Date(`${fallbackOrg?.stats_updated_at}Z`).toISOString()).toBe(legacyUpdatedAt)
    expect(new Date(`${fallbackOrg?.stats_refresh_requested_at}Z`).toISOString()).toBe(legacyRequestedAt)

    const { data: fallbackUserRows, error: fallbackUserError } = await getSupabaseClient().rpc('get_orgs_v7', {
      userid: USER_ID,
    })
    expect(fallbackUserError).toBeNull()
    const fallbackUserOrg = fallbackUserRows?.find(org => org.gid === orgId)
    expect(new Date(`${fallbackUserOrg?.stats_updated_at}Z`).toISOString()).toBe(legacyUpdatedAt)
    expect(new Date(`${fallbackUserOrg?.stats_refresh_requested_at}Z`).toISOString()).toBe(legacyRequestedAt)
  })

  it('preserves the exact get_orgs_v7 output contract for both overloads', async () => {
    const expectedColumns = [
      'gid',
      'created_by',
      'created_at',
      'logo',
      'website',
      'name',
      'role',
      'is_invite',
      'paying',
      'trial_left',
      'can_use_more',
      'is_canceled',
      'app_count',
      'subscription_start',
      'subscription_end',
      'management_email',
      'is_yearly',
      'stats_updated_at',
      'stats_refresh_requested_at',
      'next_stats_update_at',
      'credit_available',
      'credit_total',
      'credit_next_expiration',
      'enforcing_2fa',
      '2fa_has_access',
      'enforce_hashed_api_keys',
      'password_policy_config',
      'password_has_access',
      'require_apikey_expiration',
      'max_apikey_expiration_days',
      'enforce_encrypted_bundles',
      'required_encryption_key',
    ]
    const rows = await executeSQL<{ columns: string[], overload: string }>(`
      SELECT overload, array_agg(arg_name ORDER BY ordinality) AS columns
      FROM (
        SELECT 'no_args' AS overload, args.arg_name, args.ordinality
        FROM pg_catalog.pg_proc proc
        JOIN LATERAL unnest(proc.proallargtypes, proc.proargmodes, proc.proargnames)
          WITH ORDINALITY AS args(type_oid, arg_mode, arg_name, ordinality) ON true
        WHERE proc.oid = 'public.get_orgs_v7()'::regprocedure
          AND args.arg_mode = 't'
        UNION ALL
        SELECT 'userid' AS overload, args.arg_name, args.ordinality
        FROM pg_catalog.pg_proc proc
        JOIN LATERAL unnest(proc.proallargtypes, proc.proargmodes, proc.proargnames)
          WITH ORDINALITY AS args(type_oid, arg_mode, arg_name, ordinality) ON true
        WHERE proc.oid = 'public.get_orgs_v7(uuid)'::regprocedure
          AND args.arg_mode = 't'
      ) output_args
      GROUP BY overload
      ORDER BY overload
    `)

    expect(rows.map(row => row.overload)).toEqual(['no_args', 'userid'])
    for (const row of rows)
      expect(row.columns).toEqual(expectedColumns)
  })

  it.each(['org', 'app'] as const)('get_app_metrics %s date-range overload invalidates only after state completion advances', async (scope) => {
    const metricDate = new Date()
    metricDate.setHours(0, 0, 0, 0)
    const metricDateText = metricDate.toISOString().slice(0, 10)

    await getSupabaseClient().from('daily_mau').upsert({
      app_id: staleAppId,
      date: metricDateText,
      mau: 5,
    }, {
      onConflict: 'app_id,date',
    }).throwOnError()
    await getSupabaseClient().from('daily_bandwidth').upsert({
      app_id: staleAppId,
      bandwidth: 0,
      date: metricDateText,
    }, {
      onConflict: 'app_id,date',
    }).throwOnError()
    await getSupabaseClient().from('daily_storage').upsert({
      app_id: staleAppId,
      date: metricDateText,
      storage: 0,
    }, {
      onConflict: 'app_id,date',
    }).throwOnError()

    const { data: initialMetrics, error: initialError } = await getDateRangeMetrics(scope, metricDateText)

    expect(initialError).toBeNull()
    const initialRow = initialMetrics?.find(row => row.app_id === staleAppId && row.date === metricDateText)
    expect(initialRow?.mau).toBe(5)

    const cacheRows = await executeSQL(
      'SELECT cached_at FROM public.app_metrics_cache WHERE org_id = $1 LIMIT 1',
      [orgId],
    )
    expect(cacheRows).toHaveLength(1)

    await getSupabaseClient().from('daily_mau').update({ mau: 9 }).eq('app_id', staleAppId).eq('date', metricDateText).throwOnError()

    const { data: cachedMetrics, error: cachedError } = await getDateRangeMetrics(scope, metricDateText)

    expect(cachedError).toBeNull()
    const cachedRow = cachedMetrics?.find(row => row.app_id === staleAppId && row.date === metricDateText)
    expect(cachedRow?.mau).toBe(5)
    const cacheAfterFreshRead = await executeSQL(
      'SELECT cached_at FROM public.app_metrics_cache WHERE org_id = $1 LIMIT 1',
      [orgId],
    )
    expect(cacheAfterFreshRead[0]?.cached_at).toEqual(cacheRows[0].cached_at)

    const refreshedAt = new Date(new Date(cacheRows[0].cached_at).getTime() + 60_000).toISOString()
    const legacyStateBefore = await getLegacyOrgRefreshState()
    await executeSQL(`
      UPDATE public.org_stats_refresh_state
      SET stats_updated_at = $2
      WHERE org_id = $1
    `, [orgId, refreshedAt])

    const { data: refreshedMetrics, error: refreshedError } = await getDateRangeMetrics(scope, metricDateText)

    expect(refreshedError).toBeNull()
    const refreshedRow = refreshedMetrics?.find(row => row.app_id === staleAppId && row.date === metricDateText)
    expect(refreshedRow?.mau).toBe(9)
    expect(await getLegacyOrgRefreshState()).toEqual(legacyStateBefore)
  })
})
