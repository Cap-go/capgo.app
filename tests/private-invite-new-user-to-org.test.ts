import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  getSupabaseClient,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_ID_2,
  USER_ID_NONMEMBER,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const USER_EMAIL_2 = 'test2@capgo.app'

let authHeaders: Record<string, string>
let orgAdminAuthHeaders: Record<string, string>
let orgMemberAuthHeaders: Record<string, string>

async function postInviteNewUserToOrg(
  headers: Record<string, string>,
  body: {
    email: string
    org_id: string
    invite_type: 'org_member' | 'org_admin' | 'org_super_admin'
    first_name?: string
    last_name?: string
  },
) {
  return fetch(getEndpointUrl('/private/invite_new_user_to_org'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      first_name: body.first_name ?? 'Invite',
      last_name: body.last_name ?? 'Target',
      ...body,
    }),
  })
}

async function createUserOrgBinding(orgId: string, userId: string, roleName: string, grantedBy = USER_ID) {
  const [role] = await executeSQL(
    `SELECT id FROM public.roles WHERE name = $1 AND scope_type = 'org' LIMIT 1`,
    [roleName],
  )
  if (!role?.id)
    throw new Error(`Unable to resolve org role ${roleName}`)

  try {
    await executeSQL(
      `INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
       VALUES ($1::uuid, $2::uuid, $3, false)`,
      [orgId, userId, roleName],
    )
  }
  catch (error: any) {
    if (error?.code !== '23505')
      throw error
  }

  try {
    await executeSQL(
      `INSERT INTO public.role_bindings (
         principal_type, principal_id, role_id, scope_type, org_id,
         granted_by, reason, is_direct
       ) VALUES (
         'user', $1::uuid, $2::uuid, 'org', $3::uuid, $4::uuid,
         'Test invite rank binding', true
       )`,
      [userId, role.id, orgId, grantedBy],
    )
  }
  catch (error: any) {
    if (error?.code !== '23505')
      throw error
  }
}

async function createInviteNewUserFixture(options?: {
  extraMembers?: Array<{ userId: string, roleName: 'org_admin' | 'org_member' }>
}) {
  const id = randomUUID()
  const orgId = randomUUID()
  const customerId = `cus_new_invite_${id}`
  const orgEmail = `new-invite-${id}@capgo.app`
  const supabase = getSupabaseClient()

  const { error: stripeError } = await supabase.from('stripe_info').insert({
    customer_id: customerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${id}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await supabase.from('orgs').insert({
    id: orgId,
    name: `New Invite Org ${id}`,
    management_email: orgEmail,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (orgError)
    throw orgError

  for (const member of options?.extraMembers ?? [])
    await createUserOrgBinding(orgId, member.userId, member.roleName)

  return {
    id,
    orgId,
    supabase,
    cleanup: async () => {
      await supabase.from('tmp_users').delete().eq('org_id', orgId)
      await supabase.from('orgs').delete().eq('id', orgId)
      await supabase.from('stripe_info').delete().eq('customer_id', customerId)
    },
  }
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
  orgAdminAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_2, USER_PASSWORD)
  orgMemberAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
})

describe('[POST] /private/invite_new_user_to_org rank guards', () => {
  it.concurrent('returns forbidden when an org_admin invites org_super_admin', async () => {
    const fixture = await createInviteNewUserFixture({
      extraMembers: [{ userId: USER_ID_2, roleName: 'org_admin' }],
    })
    try {
      const response = await postInviteNewUserToOrg(orgAdminAuthHeaders, {
        email: `admin-cannot-super-${fixture.id}@capgo.app`,
        org_id: fixture.orgId,
        invite_type: 'org_super_admin',
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_authorized')

      const { data: invitation } = await fixture.supabase
        .from('tmp_users')
        .select('id')
        .eq('org_id', fixture.orgId)
        .maybeSingle()
      expect(invitation).toBeNull()
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('allows an org_super_admin to invite another org_super_admin', async () => {
    const fixture = await createInviteNewUserFixture()
    const invitedEmail = `super-can-super-${fixture.id}@capgo.app`
    try {
      const response = await postInviteNewUserToOrg(authHeaders, {
        email: invitedEmail,
        org_id: fixture.orgId,
        invite_type: 'org_super_admin',
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { status: string }
      expect(data.status).toBe('ok')

      const { data: invitation, error } = await fixture.supabase
        .from('tmp_users')
        .select('rbac_role_name, email')
        .eq('org_id', fixture.orgId)
        .eq('email', invitedEmail)
        .single()
      expect(error).toBeNull()
      expect(invitation?.rbac_role_name).toBe('org_super_admin')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns forbidden when an org_member invites org_admin', async () => {
    const fixture = await createInviteNewUserFixture({
      extraMembers: [{ userId: USER_ID_NONMEMBER, roleName: 'org_member' }],
    })
    try {
      const response = await postInviteNewUserToOrg(orgMemberAuthHeaders, {
        email: `member-cannot-admin-${fixture.id}@capgo.app`,
        org_id: fixture.orgId,
        invite_type: 'org_admin',
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_authorized')
    }
    finally {
      await fixture.cleanup()
    }
  })
})
