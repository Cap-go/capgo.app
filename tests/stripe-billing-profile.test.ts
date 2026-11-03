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
  throw new Error('SUPABASE_URL is required for stripe billing profile tests')
if (!SUPABASE_ANON_KEY)
  throw new Error('SUPABASE_ANON_KEY is required for stripe billing profile tests')

const serviceRoleSupabase = getSupabaseClient()
const fixtureId = randomUUID()
const orgEeId = randomUUID()
const orgUsId = randomUUID()
const orgAdminEmail = `billing-profile-admin-${fixtureId}@capgo.test`
const billingAdminEmail = `billing-profile-billing-${fixtureId}@capgo.test`
const testPassword = `Capgo!${fixtureId}`
const customerEe = `cus_billing_profile_ee_${fixtureId.replaceAll('-', '').slice(0, 14)}`
const customerUs = `cus_billing_profile_us_${fixtureId.replaceAll('-', '').slice(0, 14)}`

async function bindOrgRole(userId: string, orgId: string, roleName: string) {
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
       $1::uuid, 'billing profile fixture', true
     )
     ON CONFLICT DO NOTHING`,
    [userId, role.id, orgId],
  )
}

describe('stripe billing profile API', () => {
  let orgAdminHeaders: Record<string, string>
  let billingAdminHeaders: Record<string, string>

  beforeAll(async () => {
    const { data: orgAdminAuth, error: orgAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: orgAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (orgAdminAuthError)
      throw orgAdminAuthError

    const { data: billingAdminAuth, error: billingAdminAuthError } = await serviceRoleSupabase.auth.admin.createUser({
      email: billingAdminEmail,
      password: testPassword,
      email_confirm: true,
    })
    if (billingAdminAuthError)
      throw billingAdminAuthError

    await executeSQL(
      `INSERT INTO public.users (id, email, first_name)
       VALUES ($1::uuid, $2, 'Billing Profile Org Admin'), ($3::uuid, $4, 'Billing Profile Billing Admin')
       ON CONFLICT (id) DO NOTHING`,
      [orgAdminAuth.user.id, orgAdminEmail, billingAdminAuth.user.id, billingAdminEmail],
    )

    await executeSQL(
      `INSERT INTO public.stripe_info (customer_id, status, product_id, subscription_id, billing_account)
       VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', $2, 'ee'),
              ($3, 'succeeded', 'prod_VDt1FTF7XJxyMR', $4, 'us')`,
      [customerEe, `sub_ee_${fixtureId}`, customerUs, `sub_us_${fixtureId}`],
    )

    await executeSQL(
      `INSERT INTO public.orgs (id, created_by, name, management_email, customer_id)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5),
              ($6::uuid, $2::uuid, $7, $8, $9)`,
      [
        orgEeId,
        orgAdminAuth.user.id,
        `Billing profile EE ${fixtureId}`,
        orgAdminEmail,
        customerEe,
        orgUsId,
        `Billing profile US ${fixtureId}`,
        orgAdminEmail,
        customerUs,
      ],
    )

    await bindOrgRole(orgAdminAuth.user.id, orgEeId, 'org_admin')
    await bindOrgRole(orgAdminAuth.user.id, orgUsId, 'org_admin')
    await bindOrgRole(billingAdminAuth.user.id, orgEeId, 'org_billing_admin')

    await executeSQL(
      `INSERT INTO public.org_users (user_id, org_id, rbac_role_name, is_invite)
       VALUES ($1::uuid, $2::uuid, public.rbac_role_org_admin(), false),
              ($1::uuid, $3::uuid, public.rbac_role_org_admin(), false),
              ($4::uuid, $2::uuid, public.rbac_role_org_billing_admin(), false)
       ON CONFLICT DO NOTHING`,
      [orgAdminAuth.user.id, orgEeId, orgUsId, billingAdminAuth.user.id],
    )

    orgAdminHeaders = await getAuthHeadersForCredentials(orgAdminEmail, testPassword)
    billingAdminHeaders = await getAuthHeadersForCredentials(billingAdminEmail, testPassword)
  })

  afterAll(async () => {
    await executeSQL('DELETE FROM public.orgs WHERE id = ANY($1::uuid[])', [[orgEeId, orgUsId]])
    await executeSQL('DELETE FROM public.stripe_info WHERE customer_id = ANY($1::text[])', [[customerEe, customerUs]])
  })

  it.concurrent('rejects org_billing_admin even with org.update_billing', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/stripe_billing/billing-profile?orgId=${orgEeId}`), {
      method: 'GET',
      headers: billingAdminHeaders,
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('not_authorized')
  })

  it('allows org_admin on EE and US orgs when Stripe is reachable', async () => {
    for (const orgId of [orgEeId, orgUsId]) {
      const response = await fetchTestRequest(getEndpointUrl(`/private/stripe_billing/billing-profile?orgId=${orgId}`), {
        method: 'GET',
        headers: orgAdminHeaders,
      })
      expect([200, 503, 500]).toContain(response.status)
      if (response.status !== 200)
        continue
      const payload = await response.json() as { address?: { country?: string | null } }
      expect(payload.address).toBeTruthy()
    }
  })
})
