import type { Database } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { createClient } from './sql-data-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
  BASE_URL,
  ORG_ID,
  POSTGRES_URL,
  resetAndSeedAppData,
  resetAppData,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_EMAIL,
  USER_ID,
  USER_PASSWORD,
} from './test-utils.ts'

const appId = `com.transfer.security.${randomUUID()}`
const destinationOrgId = randomUUID()
const destinationOrgName = `Transfer Destination ${destinationOrgId}`
const destinationOrgEmail = `transfer-${destinationOrgId}@capgo.app`

function createAuthClient() {
  return createClient<Database>(SUPABASE_BASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
    },
  })
}

async function createUserOrgBinding(orgId: string, userId: string, roleName: string) {
  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_user(),
      $1::uuid,
      roles.id,
      public.rbac_scope_org(),
      $2::uuid,
      $1::uuid,
      'App transfer test binding',
      true
    FROM public.roles roles
    WHERE roles.name = $3
      AND roles.scope_type = public.rbac_scope_org()
    ON CONFLICT DO NOTHING
  `, [userId, orgId, roleName])
}

describe('app transfer security', () => {
  const authClient = createAuthClient()

  beforeAll(async () => {
    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })

    if (signInError)
      throw signInError

    await resetAndSeedAppData(appId)

    const capgo = getSupabaseClient()

    await capgo.from('orgs').insert({
      id: destinationOrgId,
      created_by: USER_ID,
      management_email: destinationOrgEmail,
      name: destinationOrgName,
      updated_at: new Date().toISOString(),
    }).throwOnError()

    await capgo.from('org_users').insert({
      org_id: destinationOrgId,
      user_id: USER_ID,
      rbac_role_name: 'org_super_admin',
    }).throwOnError()
    await createUserOrgBinding(destinationOrgId, USER_ID, 'org_super_admin')
  })

  afterAll(async () => {
    const capgo = getSupabaseClient()

    await executeSQL('DELETE FROM public.daily_storage_hourly WHERE app_id = $1', [appId])
    await executeSQL('DELETE FROM public.daily_storage_hourly_refreshes WHERE app_id = $1', [appId])
    await resetAppData(appId)
    await capgo.from('org_users').delete().eq('org_id', destinationOrgId).eq('user_id', USER_ID)
    await capgo.from('orgs').delete().eq('id', destinationOrgId)
  })

  it('rejects raw PostgREST owner_org updates on apps', async () => {
    const updateAttempt = await authClient
      .from('apps')
      .update({ owner_org: destinationOrgId })
      .eq('app_id', appId)
      .select('owner_org,transfer_history')
      .single()

    expect(updateAttempt.error).toBeTruthy()
    expect(updateAttempt.error?.message).toContain('owner_org must be changed through public.transfer_app()')

    const capgo = getSupabaseClient()
    const { data: appRow, error: appError } = await capgo
      .from('apps')
      .select('owner_org,transfer_history')
      .eq('app_id', appId)
      .single()

    if (appError)
      throw appError

    const { data: versionRows, error: versionError } = await capgo
      .from('app_versions')
      .select('owner_org')
      .eq('app_id', appId)

    if (versionError)
      throw versionError

    expect(appRow.owner_org).toBe(ORG_ID)
    expect(appRow.transfer_history ?? []).toHaveLength(0)
    expect(versionRows.every(version => version.owner_org === ORG_ID)).toBe(true)
  })

  it('still allows the approved transfer_app RPC to move ownership consistently', async () => {
    // One known bundle, stored since 30 minutes ago, is the app's only storage.
    const bundleSize = 1_000_000
    await executeSQL('DELETE FROM public.version_meta WHERE app_id = $1', [appId])
    await executeSQL(
      `INSERT INTO public.version_meta (timestamp, app_id, version_id, size)
       VALUES (pg_catalog.timezone('UTC', pg_catalog.now() - interval '30 minutes'), $1, $2, $3)`,
      [appId, 990_000_000 + Math.floor(Math.random() * 1_000_000), bundleSize],
    )
    // The former owner's real ownership segment (the app creation) and billing cycle.
    const [former] = await executeSQL<{ segment_start: string, cycle_day: string, cycle_end_day: string, end_exclusive_day: string }>(
      `SELECT apps.created_at::text AS segment_start,
         (cycle.cycle_start AT TIME ZONE 'UTC')::date::text AS cycle_day,
         (cycle.cycle_end AT TIME ZONE 'UTC')::date::text AS cycle_end_day,
         (((cycle.cycle_end - interval '1 microsecond') AT TIME ZONE 'UTC')::date + 1)::text AS end_exclusive_day
       FROM public.apps, public.get_org_billing_cycle($2::uuid) AS cycle
       WHERE apps.app_id = $1`,
      [appId, ORG_ID],
    )

    // A storage refresh of the former owner is running: replace_app_storage_hourly holds a share
    // lock on the app row and has written the former owner's rows and watermark for its real
    // segment and cycle. The transfer must wait for it and record its time after, so those hours
    // never extend past transferred_at and the new owner's refresh still finalizes the former owner.
    const refresh = new Client({ connectionString: POSTGRES_URL })
    await refresh.connect()
    const today = new Date().toISOString().slice(0, 10)
    let refreshWrittenAtText = ''
    let refreshCommittingAtText = ''
    try {
      await refresh.query('BEGIN')
      const [{ written_at }] = (await refresh.query<{ written_at: string }>(
        `SELECT pg_catalog.clock_timestamp()::text AS written_at,
           public.replace_app_storage_hourly(
             p_app_id => $1::varchar,
             p_owner_org => $2::uuid,
             p_cycle_start_day => $3::date,
             p_cycle_end_day => $4::date,
             p_end_exclusive_day => $5::date,
             p_segment_start => $6::timestamptz,
             p_rows => pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('cycle_start', $3::text, 'date', $7::text, 'storage_byte_hours', 1000)),
             p_written_at => pg_catalog.clock_timestamp(),
             p_require_current_owner => true,
             p_calculated_until => pg_catalog.clock_timestamp()
           )`,
        [appId, ORG_ID, former.cycle_day, former.cycle_end_day, former.end_exclusive_day, former.segment_start, today],
      )).rows
      refreshWrittenAtText = written_at

      // .then() sends the request now: the RPC builder is lazy.
      const transferPromise = authClient.rpc('transfer_app', {
        p_app_id: appId,
        p_new_org_id: destinationOrgId,
      }).then(result => result)

      // The transfer blocks on this refresh's lock: a backend is blocked by this connection (only
      // the transfer touches this app), and the transfer has not answered meanwhile.
      let waiting = false
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const { rows } = await refresh.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_stat_activity activity
             WHERE pg_catalog.pg_backend_pid() = ANY (pg_catalog.pg_blocking_pids(activity.pid))
           ) AS waiting`,
        )
        waiting = rows[0]?.waiting ?? false
        if (!waiting)
          await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!waiting) {
        const early = await Promise.race([transferPromise, new Promise(resolve => setTimeout(resolve, 2000, 'still pending'))])
        throw new Error(`transfer_app did not wait on the refresh lock: ${JSON.stringify(early)}`)
      }
      const settled = await Promise.race([
        transferPromise.then(() => 'answered'),
        new Promise(resolve => setTimeout(resolve, 300, 'pending')),
      ])
      expect(settled).toBe('pending')

      // The last instant of the refresh, just before it commits: the transfer started earlier
      // (it is waiting), so its transaction-start now() would be before this.
      const [{ committing_at }] = (await refresh.query<{ committing_at: string }>('SELECT pg_catalog.clock_timestamp()::text AS committing_at')).rows
      refreshCommittingAtText = committing_at
      await refresh.query('COMMIT')
      const transferResult = await transferPromise
      expect(transferResult.error).toBeNull()
    }
    finally {
      await refresh.end()
    }

    const storageRows = await executeSQL<{ owner_org: string, storage_byte_hours: number }>(
      'SELECT owner_org, storage_byte_hours FROM public.daily_storage_hourly WHERE app_id = $1',
      [appId],
    )
    // The former owner's refresh committed before the transfer; the new owner has no hours yet.
    expect(storageRows.map(row => [row.owner_org, Number(row.storage_byte_hours)])).toEqual([[ORG_ID, 1000]])
    const [watermark] = await executeSQL<{ written_at: string }>(
      'SELECT written_at::text FROM public.daily_storage_hourly_refreshes WHERE app_id = $1 AND owner_org = $2::uuid',
      [appId, ORG_ID],
    )
    expect(watermark).toBeDefined()

    const capgo = getSupabaseClient()
    const { data: appRow, error: appError } = await capgo
      .from('apps')
      .select('owner_org,transfer_history')
      .eq('app_id', appId)
      .single()

    if (appError)
      throw appError

    const { data: versionRows, error: versionError } = await capgo
      .from('app_versions')
      .select('owner_org')
      .eq('app_id', appId)

    if (versionError)
      throw versionError

    expect(appRow.owner_org).toBe(destinationOrgId)
    expect(appRow.transfer_history ?? []).toHaveLength(1)
    // Recorded after the lock, so later than every hour and the watermark the former owner's
    // refresh wrote (now() would be the transaction start, before the refresh committed).
    // Compared in the database: these instants can share a millisecond, JS Dates drop microseconds.
    const [order] = await executeSQL<{ after_write: boolean, after_watermark: boolean, after_commit: boolean }>(
      `SELECT ((apps.transfer_history[1] ->> 'transferred_at')::timestamptz > $2::timestamptz) AS after_write,
         ((apps.transfer_history[1] ->> 'transferred_at')::timestamptz > $3::timestamptz) AS after_watermark,
         ((apps.transfer_history[1] ->> 'transferred_at')::timestamptz > $4::timestamptz) AS after_commit
       FROM public.apps
       WHERE apps.app_id = $1`,
      [appId, refreshWrittenAtText, watermark.written_at, refreshCommittingAtText],
    )
    expect(order).toEqual({ after_write: true, after_watermark: true, after_commit: true })

    // The new owner's refresh finalizes the former owner exactly up to the transfer, including the
    // transfer day, and the new owner accrues only from it.
    const refreshResponse = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apisecret': 'testsecret' },
      body: JSON.stringify({ appId, orgId: destinationOrgId }),
    })
    expect(refreshResponse.status, await refreshResponse.clone().text()).toBe(200)

    const [accounting] = await executeSQL<{
      former_watermark_at_transfer: boolean
      former_byte_hours: number
      former_expected: number
      new_byte_hours: number
      new_expected: number
    }>(
      `WITH transfer AS (
         SELECT pg_catalog.date_trunc('milliseconds', (apps.transfer_history[1] ->> 'transferred_at')::timestamptz) AS at,
           apps.created_at
         FROM public.apps
         WHERE apps.app_id = $1
       ),
       bundle AS (
         SELECT (version_meta.timestamp AT TIME ZONE 'UTC') AS added_at, version_meta.size
         FROM public.version_meta
         WHERE version_meta.app_id = $1 AND version_meta.size > 0
       ),
       new_owner AS (
         SELECT max(refresh.calculated_until) AS calculated_until
         FROM public.daily_storage_hourly_refreshes refresh
         WHERE refresh.app_id = $1 AND refresh.owner_org = $3::uuid
       )
       SELECT
         EXISTS (
           SELECT 1 FROM public.daily_storage_hourly_refreshes refresh
           WHERE refresh.app_id = $1
             AND refresh.owner_org = $2::uuid
             AND refresh.cycle_start = $4::date
             AND refresh.segment_start = $5::timestamptz
             AND refresh.calculated_until = transfer.at
         ) AS former_watermark_at_transfer,
         (SELECT COALESCE(sum(storage_byte_hours), 0) FROM public.daily_storage_hourly WHERE app_id = $1 AND owner_org = $2::uuid) AS former_byte_hours,
         bundle.size * EXTRACT(EPOCH FROM (transfer.at - GREATEST(bundle.added_at, transfer.created_at))) / 3600 AS former_expected,
         (SELECT COALESCE(sum(storage_byte_hours), 0) FROM public.daily_storage_hourly WHERE app_id = $1 AND owner_org = $3::uuid) AS new_byte_hours,
         bundle.size * EXTRACT(EPOCH FROM (new_owner.calculated_until - transfer.at)) / 3600 AS new_expected
       FROM transfer, bundle, new_owner`,
      [appId, ORG_ID, destinationOrgId, former.cycle_day, former.segment_start],
    )
    expect(accounting.former_watermark_at_transfer).toBe(true)
    // Within a millisecond of byte-hours: hours run from the bundle (or the app creation) to the
    // transfer for the former owner, and from the transfer for the new owner.
    expect(Number(accounting.former_byte_hours)).toBeCloseTo(Number(accounting.former_expected), -1)
    expect(Number(accounting.new_byte_hours)).toBeCloseTo(Number(accounting.new_expected), -1)
    expect(Number(accounting.new_byte_hours)).toBeGreaterThan(0)
    expect(versionRows.length).toBeGreaterThan(0)
    expect(versionRows.every(version => version.owner_org === destinationOrgId)).toBe(true)
  })
})
