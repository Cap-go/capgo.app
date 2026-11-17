import type { Database } from '../src/types/database.types'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { createClient } from './sql-data-client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
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
    // A storage refresh of the former owner is running: replace_app_storage_hourly holds a share
    // lock on the app row and has written the former owner's rows and watermark. The transfer must
    // wait for it and record its time after, so those hours never extend past transferred_at and
    // the new owner's refresh still finalizes the former owner (its watermark is older).
    const refresh = new Client({ connectionString: POSTGRES_URL })
    await refresh.connect()
    const today = new Date().toISOString().slice(0, 10)
    let refreshWrittenAt = 0
    try {
      await refresh.query('BEGIN')
      const [{ written_at }] = (await refresh.query<{ written_at: string }>(
        `SELECT pg_catalog.clock_timestamp()::text AS written_at,
           public.replace_app_storage_hourly(
             p_app_id => $1::varchar,
             p_owner_org => $2::uuid,
             p_cycle_start_day => $3::date,
             p_cycle_end_day => ($3::date + 30),
             p_end_exclusive_day => ($3::date + 30),
             p_segment_start => '-infinity'::timestamptz,
             p_rows => pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('cycle_start', $3::text, 'date', $3::text, 'storage_byte_hours', 1000)),
             p_written_at => pg_catalog.clock_timestamp(),
             p_require_current_owner => true
           )`,
        [appId, ORG_ID, today],
      )).rows
      refreshWrittenAt = Date.parse(written_at)

      // .then() sends the request now: the RPC builder is lazy.
      const transferPromise = authClient.rpc('transfer_app', {
        p_app_id: appId,
        p_new_org_id: destinationOrgId,
      }).then(result => result)

      // The transfer is blocked on the refresh's lock.
      let waiting = false
      for (let attempt = 0; attempt < 50 && !waiting; attempt++) {
        const { rows } = await refresh.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_catalog.pg_stat_activity
             WHERE pid <> pg_catalog.pg_backend_pid()
               AND wait_event_type = 'Lock'
               AND query ILIKE '%transfer_app%'
           ) AS waiting`,
        )
        waiting = rows[0]?.waiting ?? false
        if (!waiting)
          await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(waiting).toBe(true)

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
    const transferredAt = Date.parse(String((appRow.transfer_history![0] as { transferred_at: string }).transferred_at))
    expect(transferredAt).toBeGreaterThan(refreshWrittenAt)
    expect(transferredAt).toBeGreaterThan(Date.parse(watermark.written_at))
    expect(versionRows.length).toBeGreaterThan(0)
    expect(versionRows.every(version => version.owner_org === destinationOrgId)).toBe(true)
  })
})
