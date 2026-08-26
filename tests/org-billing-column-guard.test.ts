import type { Database } from '~/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getSupabaseClient,
} from './test-utils.ts'

const SUPABASE_URL = (env.SUPABASE_URL ?? '').replace(/\/$/, '')
const SUPABASE_ANON_KEY = env.SUPABASE_ANON_KEY ?? ''
const USE_CLOUDFLARE_WORKERS = env.USE_CLOUDFLARE_WORKERS === 'true'

if (!SUPABASE_URL)
  throw new Error('SUPABASE_URL is required for org billing column guard tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for org billing column guard tests')

const serviceRoleSupabase = getSupabaseClient()

const fixtureId = randomUUID()
const orgId = randomUUID()
let settingsAdminUserId = randomUUID()
let billingSuperAdminUserId = randomUUID()
const settingsAdminEmail = `org-billing-guard-admin-${fixtureId}@capgo.test`
const billingSuperAdminEmail = `org-billing-guard-super-${fixtureId}@capgo.test`
const testPassword = `Capgo!${fixtureId}`
const originalCustomerId = `cus_org_billing_guard_${fixtureId.replaceAll('-', '').slice(0, 18)}`
const replacementCustomerId = `cus_org_billing_guard_alt_${fixtureId.replaceAll('-', '').slice(0, 14)}`

async function createAuthenticatedClient(email: string, password: string) {
  const client = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error)
    throw error

  return client
}

async function bindOrgRole(userId: string, roleName: string) {
  const [role] = await executeSQL(
    `SELECT id FROM public.roles WHERE name = $1 AND scope_type = public.rbac_scope_org() LIMIT 1`,
    [roleName],
  )
  if (!role?.id)
    throw new Error(`Unable to resolve org role ${roleName}`)

  await executeSQL(
    `INSERT INTO public.role_bindings (
       principal_type, principal_id, role_id, scope_type, org_id,
       granted_by, reason, is_direct
     ) VALUES (
       public.rbac_principal_user(), $1::uuid, $2::uuid, public.rbac_scope_org(), $3::uuid,
       $1::uuid, 'org billing column guard fixture', true
     )
     ON CONFLICT DO NOTHING`,
    [userId, role.id, orgId],
  )
}

describe.skipIf(USE_CLOUDFLARE_WORKERS)('org billing column guard', () => {
  let settingsAdminClient: Awaited<ReturnType<typeof createAuthenticatedClient>>
  let billingSuperAdminClient: Awaited<ReturnType<typeof createAuthenticatedClient>>

  beforeAll(async () => {
    const { data: settingsAdminAuth, error: settingsAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: settingsAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (settingsAdminAuthError)
      throw settingsAdminAuthError

    const { data: billingSuperAdminAuth, error: billingSuperAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: billingSuperAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (billingSuperAdminAuthError)
      throw billingSuperAdminAuthError

    await executeSQL(
      `INSERT INTO public.users (id, email, first_name)
       VALUES ($1::uuid, $2, 'Org Billing Guard Admin'), ($3::uuid, $4, 'Org Billing Guard Super')
       ON CONFLICT (id) DO NOTHING`,
      [settingsAdminAuth.user.id, settingsAdminEmail, billingSuperAdminAuth.user.id, billingSuperAdminEmail],
    )

    settingsAdminUserId = settingsAdminAuth.user.id
    billingSuperAdminUserId = billingSuperAdminAuth.user.id

    await executeSQL(
      `INSERT INTO public.stripe_info (
         customer_id, status, product_id, subscription_id, trial_at, is_good_plan
       ) VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', $2, NOW() + INTERVAL '15 days', true),
                ($3, 'succeeded', 'prod_LQIregjtNduh4q', $4, NOW() + INTERVAL '15 days', true)`,
      [originalCustomerId, `sub_${fixtureId}`, replacementCustomerId, `sub_alt_${fixtureId}`],
    )

    await executeSQL(
      `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [orgId, settingsAdminUserId, `Org billing guard ${fixtureId}`, settingsAdminEmail, originalCustomerId],
    )

    await executeSQL(
      `INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
       VALUES ($1::uuid, $3::uuid, public.rbac_role_org_admin(), false),
              ($2::uuid, $3::uuid, public.rbac_role_org_super_admin(), false)
       ON CONFLICT DO NOTHING`,
      [settingsAdminUserId, billingSuperAdminUserId, orgId],
    )

    await bindOrgRole(settingsAdminUserId, 'org_admin')
    await bindOrgRole(billingSuperAdminUserId, 'org_super_admin')

    settingsAdminClient = await createAuthenticatedClient(settingsAdminEmail, testPassword)
    billingSuperAdminClient = await createAuthenticatedClient(billingSuperAdminEmail, testPassword)
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
    await executeSQL(
      'DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])',
      [[originalCustomerId, replacementCustomerId]],
    )
    await serviceRoleSupabase.auth.admin.deleteUser(settingsAdminUserId)
    await serviceRoleSupabase.auth.admin.deleteUser(billingSuperAdminUserId)
  })

  it('blocks org.update_settings principals from changing customer_id via PostgREST', async () => {
    const { data, error } = await settingsAdminClient
      .from('orgs')
      .update({ customer_id: null })
      .eq('id', orgId)
      .select('customer_id')

    expect(error?.code).toBe('42501')
    expect(error?.message ?? '').toContain('PERMISSION_DENIED_ORG_UPDATE_BILLING')
    expect(data).toBeNull()

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('customer_id')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.customer_id).toBe(originalCustomerId)
  })

  it('still allows org.update_settings principals to change cosmetic org fields', async () => {
    const updatedName = `Org billing guard renamed ${fixtureId}`

    const { error } = await settingsAdminClient
      .from('orgs')
      .update({ name: updatedName })
      .eq('id', orgId)

    expect(error).toBeNull()

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('name')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.name).toBe(updatedName)
  })

  it('allows org.update_billing principals to change customer_id via PostgREST', async () => {
    const { error } = await billingSuperAdminClient
      .from('orgs')
      .update({ customer_id: replacementCustomerId })
      .eq('id', orgId)

    expect(error).toBeNull()

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('customer_id')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.customer_id).toBe(replacementCustomerId)
  })

  it('allows service_role to change customer_id via PostgREST', async () => {
    const { error } = await serviceRoleSupabase
      .from('orgs')
      .update({ customer_id: originalCustomerId })
      .eq('id', orgId)

    expect(error).toBeNull()

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('customer_id')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.customer_id).toBe(originalCustomerId)
  })
})
