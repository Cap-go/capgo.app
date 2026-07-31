import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, USER_EMAIL_NONMEMBER, USER_ID, USER_ID_2, USER_ID_NONMEMBER, USER_PASSWORD, USER_PASSWORD_NONMEMBER } from './test-utils.ts'

let authHeaders: Record<string, string>
let nonMemberAuthHeaders: Record<string, string>
let orgAdminAuthHeaders: Record<string, string>
const USER_EMAIL_2 = 'test2@capgo.app'

async function postInviteExistingUserToOrg(headers: Record<string, string>, body: { email: string, org_id: string }) {
  return fetch(getEndpointUrl('/private/invite_existing_user_to_org'), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

async function createInviteTestFixture(options?: {
  inviterUserId?: string
  inviterRoleName?: 'org_admin' | 'org_super_admin'
  invitedRoleName?: 'org_member' | 'org_super_admin'
}) {
  const id = randomUUID()
  const orgId = randomUUID()
  const customerId = `cus_existing_invite_${id}`
  const orgEmail = `existing-invite-${id}@capgo.app`
  const supabase = getSupabaseClient()
  const inviterUserId = options?.inviterUserId ?? USER_ID
  const inviterRoleName = options?.inviterRoleName ?? 'org_super_admin'
  const invitedRoleName = options?.invitedRoleName ?? 'org_member'

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
    name: `Existing Invite Org ${id}`,
    management_email: orgEmail,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (orgError)
    throw orgError

  const orgUserRows: Array<{ org_id: string, user_id: string, rbac_role_name: string, is_invite: boolean }> = [
    {
      org_id: orgId,
      user_id: USER_ID_NONMEMBER,
      rbac_role_name: invitedRoleName,
      is_invite: true,
    },
  ]
  if (inviterUserId !== USER_ID) {
    orgUserRows.unshift({
      org_id: orgId,
      user_id: inviterUserId,
      rbac_role_name: inviterRoleName,
      is_invite: false,
    })
  }

  const { error: orgUsersError } = await supabase.from('org_users').insert(orgUserRows)
  if (orgUsersError)
    throw orgUsersError

  return {
    id,
    orgId,
    supabase,
    cleanup: async () => {
      await supabase.from('orgs').delete().eq('id', orgId)
      await supabase.from('stripe_info').delete().eq('customer_id', customerId)
    },
  }
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
  nonMemberAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
  orgAdminAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_2, USER_PASSWORD)
})

describe('[POST] /private/invite_existing_user_to_org', () => {
  it.concurrent('returns ok for an existing user with a pending org invitation', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { status: string }
      expect(data.status).toBe('ok')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns a validation error for an invalid email format', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: 'invalid-email',
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(400)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('invalid_request')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns not found when the target user does not exist', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: `missing-${fixture.id}@capgo.app`,
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(404)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('user_not_found')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns forbidden when the caller targets an inaccessible organization id', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: `${fixture.orgId}-missing`,
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_authorized')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns conflict when the invitation has already been accepted', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const { error: updateError } = await fixture.supabase
        .from('org_users')
        .update({ is_invite: false })
        .eq('org_id', fixture.orgId)
        .eq('user_id', USER_ID_NONMEMBER)

      expect(updateError).toBeNull()

      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(409)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('invite_already_accepted')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns forbidden when the caller cannot invite users', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const response = await postInviteExistingUserToOrg(nonMemberAuthHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_authorized')
    }
    finally {
      await fixture.cleanup()
    }
  })

  it.concurrent('returns forbidden when an org admin tries to resend a super admin invite', async () => {
    const fixture = await createInviteTestFixture({
      inviterUserId: USER_ID_2,
      inviterRoleName: 'org_admin',
      invitedRoleName: 'org_super_admin',
    })
    try {
      const response = await postInviteExistingUserToOrg(orgAdminAuthHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: fixture.orgId,
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
