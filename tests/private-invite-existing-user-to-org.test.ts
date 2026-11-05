import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, USER_EMAIL_NONMEMBER, USER_ID, USER_ID_2, USER_ID_NONMEMBER, USER_PASSWORD, USER_PASSWORD_NONMEMBER } from './test-utils.ts'

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

  // A pending membership now queues the initial email atomically. These
  // endpoint tests exercise a later explicit resend after the cooldown.
  await executeSQL(`
    UPDATE public.org_invitation_email_requests
    SET requested_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes'
    WHERE org_user_id IN (SELECT id FROM public.org_users WHERE org_id = $1)
  `, [orgId])

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
  it.concurrent('queues one explicit resend and rejects repeated requests during the cooldown', async () => {
    const fixture = await createInviteTestFixture()
    try {
      const before = await executeSQL<{ id: string }>(`
        SELECT r.id FROM public.org_invitation_email_requests r
        JOIN public.org_users ou ON ou.id = r.org_user_id WHERE ou.org_id = $1
      `, [fixture.orgId])
      const body = { email: USER_EMAIL_NONMEMBER, org_id: fixture.orgId }
      const first = await postInviteExistingUserToOrg(authHeaders, body)
      expect(first.status).toBe(200)
      expect(await first.json()).toMatchObject({ status: 'ok' })
      const after = await executeSQL<{ id: string }>(`
        SELECT r.id FROM public.org_invitation_email_requests r
        JOIN public.org_users ou ON ou.id = r.org_user_id WHERE ou.org_id = $1
      `, [fixture.orgId])
      expect(after[0]?.id).not.toBe(before[0]?.id)
      const response = await postInviteExistingUserToOrg(authHeaders, body)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        error: 'user_already_invited',
        moreInfo: { reason: 'invite_recently_sent', cooldown_minutes: 5 },
      })
      const jobs = await executeSQL<{ count: string }>(`
        SELECT count(*) FROM pgmq.q_send_email WHERE message->'payload'->>'org_invitation_id' = $1
      `, [after[0]!.id])
      expect(Number(jobs[0]?.count)).toBe(1)
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

  it.concurrent('allows an org super admin to resend a super admin invite', async () => {
    const fixture = await createInviteTestFixture({
      invitedRoleName: 'org_super_admin',
    })
    try {
      const response = await postInviteExistingUserToOrg(authHeaders, {
        email: USER_EMAIL_NONMEMBER,
        org_id: fixture.orgId,
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { status: string }
      expect(data.status).toBe('ok')

      const { data: membership, error } = await fixture.supabase
        .from('org_users')
        .select('rbac_role_name, is_invite')
        .eq('org_id', fixture.orgId)
        .eq('user_id', USER_ID_NONMEMBER)
        .single()
      expect(error).toBeNull()
      expect(membership?.rbac_role_name).toBe('org_super_admin')
      expect(membership?.is_invite).toBe(true)
    }
    finally {
      await fixture.cleanup()
    }
  })
})
