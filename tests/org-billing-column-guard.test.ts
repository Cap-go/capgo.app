import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  fetchTestRequest,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  getSupabaseClient,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
} from './test-utils.ts'

if (!SUPABASE_BASE_URL)
  throw new Error('SUPABASE_URL is required for org customer_id guard tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for org customer_id guard tests')

const serviceRoleSupabase = getSupabaseClient()

const fixtureId = randomUUID()
const orgId = randomUUID()
let settingsAdminUserId: string
let superAdminUserId: string
const settingsAdminEmail = `org-customer-id-guard-admin-${fixtureId}@capgo.test`
const superAdminEmail = `org-customer-id-guard-super-${fixtureId}@capgo.test`
const testPassword = `Capgo!${fixtureId}`
const originalCustomerId = `cus_org_customer_id_guard_${fixtureId.replaceAll('-', '').slice(0, 16)}`
const replacementCustomerId = `cus_org_customer_id_guard_alt_${fixtureId.replaceAll('-', '').slice(0, 12)}`

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
       $1::uuid, 'org customer_id guard fixture', true
     )
     ON CONFLICT DO NOTHING`,
    [userId, role.id, orgId],
  )
}

function withRestHeaders(headers: Record<string, string>) {
  return {
    ...headers,
    'apikey': SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  }
}

async function patchOrg(headers: Record<string, string>, body: Record<string, unknown>) {
  const response = await fetchTestRequest(getEndpointUrl(`/rest/v1/orgs?id=eq.${orgId}`), {
    method: 'PATCH',
    headers: {
      ...withRestHeaders(headers),
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const data = text ? JSON.parse(text) as unknown : null
  return { response, data }
}

describe('org customer_id guard', () => {
  let settingsAdminHeaders: Record<string, string>
  let superAdminHeaders: Record<string, string>
  const createdOrgIds: string[] = []

  beforeAll(async () => {
    const { data: settingsAdminAuth, error: settingsAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: settingsAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (settingsAdminAuthError)
      throw settingsAdminAuthError

    const { data: superAdminAuth, error: superAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: superAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (superAdminAuthError)
      throw superAdminAuthError

    await executeSQL(
      `INSERT INTO public.users (id, email, first_name)
       VALUES ($1::uuid, $2, 'Org Customer ID Guard Admin'), ($3::uuid, $4, 'Org Customer ID Guard Super')
       ON CONFLICT (id) DO NOTHING`,
      [settingsAdminAuth.user.id, settingsAdminEmail, superAdminAuth.user.id, superAdminEmail],
    )

    settingsAdminUserId = settingsAdminAuth.user.id
    superAdminUserId = superAdminAuth.user.id

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
      [orgId, superAdminUserId, `Org customer_id guard ${fixtureId}`, settingsAdminEmail, originalCustomerId],
    )

    await executeSQL(
      `INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
       VALUES ($1::uuid, $2::uuid, public.rbac_role_org_admin(), false)
       ON CONFLICT DO NOTHING`,
      [settingsAdminUserId, orgId],
    )

    await bindOrgRole(settingsAdminUserId, 'org_admin')
    await bindOrgRole(superAdminUserId, 'org_super_admin')

    settingsAdminHeaders = await getAuthHeadersForCredentials(settingsAdminEmail, testPassword)
    superAdminHeaders = await getAuthHeadersForCredentials(superAdminEmail, testPassword)
  })

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      await executeSQL(
        'DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])',
        [createdOrgIds.map(id => `pending_${id}`)],
      )
      await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [createdOrgIds])
    }
    await executeSQL('DELETE FROM public.orgs WHERE id = $1::uuid', [orgId])
    await executeSQL(
      'DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])',
      [[originalCustomerId, replacementCustomerId]],
    )
    await serviceRoleSupabase.auth.admin.deleteUser(settingsAdminUserId)
    await serviceRoleSupabase.auth.admin.deleteUser(superAdminUserId)
  })

  it('blocks org_admin from changing customer_id via PostgREST', async () => {
    const { response, data } = await patchOrg(settingsAdminHeaders, { customer_id: null })

    expect(response.status).toBe(403)
    expect(data).toMatchObject({
      code: '42501',
      message: 'PERMISSION_DENIED_ORG_CUSTOMER_ID',
    })

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('customer_id')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.customer_id).toBe(originalCustomerId)
  })

  it('blocks org_super_admin from changing customer_id via PostgREST', async () => {
    const { response, data } = await patchOrg(superAdminHeaders, { customer_id: replacementCustomerId })

    expect(response.status).toBe(403)
    expect(data).toMatchObject({
      code: '42501',
      message: 'PERMISSION_DENIED_ORG_CUSTOMER_ID',
    })
  })

  it('still allows org settings principals to change cosmetic org fields', async () => {
    const updatedName = `Org customer_id guard renamed ${fixtureId}`

    const { response, data } = await patchOrg(settingsAdminHeaders, { name: updatedName })

    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('name')
      .eq('id', orgId)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.name).toBe(updatedName)
  })

  it('allows service_role to change customer_id via PostgREST', async () => {
    const { error } = await serviceRoleSupabase
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

  it('assigns pending customer_id when creating an org via the organization API', async () => {
    const orgName = `Org customer_id guard create ${fixtureId}`

    const response = await fetchTestRequest(getEndpointUrl('/organization'), {
      method: 'POST',
      headers: {
        ...settingsAdminHeaders,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: orgName,
        email: settingsAdminEmail,
        estimatedMau: 1000,
        intent: 'ota',
      }),
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { id?: string }
    expect(payload.id).toBeTruthy()
    createdOrgIds.push(payload.id!)

    const { data: orgRow, error: readError } = await serviceRoleSupabase
      .from('orgs')
      .select('customer_id, name')
      .eq('id', payload.id!)
      .single()

    expect(readError).toBeNull()
    expect(orgRow?.name).toBe(orgName)
    expect(orgRow?.customer_id).toBe(`pending_${payload.id}`)
  })
})
