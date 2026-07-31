import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
  ORG_ID,
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

    const supabase = getSupabaseClient()

    await supabase.from('orgs').insert({
      id: destinationOrgId,
      created_by: USER_ID,
      management_email: destinationOrgEmail,
      name: destinationOrgName,
      updated_at: new Date().toISOString(),
    }).throwOnError()

    await supabase.from('org_users').insert({
      org_id: destinationOrgId,
      user_id: USER_ID,
      rbac_role_name: 'org_super_admin',
    }).throwOnError()
    await createUserOrgBinding(destinationOrgId, USER_ID, 'org_super_admin')
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()

    await resetAppData(appId)
    await supabase.from('org_users').delete().eq('org_id', destinationOrgId).eq('user_id', USER_ID)
    await supabase.from('orgs').delete().eq('id', destinationOrgId)
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

    const supabase = getSupabaseClient()
    const { data: appRow, error: appError } = await supabase
      .from('apps')
      .select('owner_org,transfer_history')
      .eq('app_id', appId)
      .single()

    if (appError)
      throw appError

    const { data: versionRows, error: versionError } = await supabase
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
    const transferResult = await authClient.rpc('transfer_app', {
      p_app_id: appId,
      p_new_org_id: destinationOrgId,
    })

    expect(transferResult.error).toBeNull()

    const supabase = getSupabaseClient()
    const { data: appRow, error: appError } = await supabase
      .from('apps')
      .select('owner_org,transfer_history')
      .eq('app_id', appId)
      .single()

    if (appError)
      throw appError

    const { data: versionRows, error: versionError } = await supabase
      .from('app_versions')
      .select('owner_org')
      .eq('app_id', appId)

    if (versionError)
      throw versionError

    expect(appRow.owner_org).toBe(destinationOrgId)
    expect(appRow.transfer_history ?? []).toHaveLength(1)
    expect(versionRows.length).toBeGreaterThan(0)
    expect(versionRows.every(version => version.owner_org === destinationOrgId)).toBe(true)
  })
})
