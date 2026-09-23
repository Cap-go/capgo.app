import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  ORG_ID,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_ID_NONMEMBER,
  USER_PASSWORD_NONMEMBER,
} from './test-utils'

async function seedPendingOrgInvitation(orgId: string, inviteeId: string, roleName = 'org_member') {
  await executeSQL(
    `INSERT INTO public.orgs (id, name, management_email, created_by)
     VALUES ($1::uuid, $2, $3, $4::uuid)`,
    [orgId, `Invite test ${orgId}`, `invite-${orgId}@example.com`, USER_ID],
  )
  await executeSQL(
    `INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
     VALUES ($1::uuid, $2::uuid, $3, true)`,
    [orgId, inviteeId, roleName],
  )
  await executeSQL(
    `INSERT INTO public.role_bindings (
       principal_type, principal_id, role_id, scope_type, org_id,
       granted_by, granted_at, expires_at, reason, is_direct
     )
     SELECT
       public.rbac_principal_user(),
       $1::uuid,
       roles.id,
       public.rbac_scope_org(),
       $2::uuid,
       $3::uuid,
       now(),
       now() - INTERVAL '1 second',
       'Pending invitation',
       true
     FROM public.roles
     WHERE roles.name = $4
       AND roles.scope_type = public.rbac_scope_org()`,
    [inviteeId, orgId, USER_ID, roleName],
  )
}

describe('org members HTTP API', () => {
  it.concurrent('rejects unauthenticated member list reads', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/org_members?org_id=${ORG_ID}`))

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('allows org members to list RBAC members', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/org_members?org_id=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as Array<{
      email: string
      role_name: string
      is_invite: boolean
      is_tmp: boolean
    }>
    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    expect(typeof data[0]?.email).toBe('string')
    expect(typeof data[0]?.role_name).toBe('string')
  })

  it.concurrent('rejects member list reads for non-members', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/org_members?org_id=${ORG_ID}`),
      {
        headers: await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER),
      },
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('invite endpoint returns invite flow codes for unknown emails', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/invite'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
        email: `no-account-${randomUUID()}@example.com`,
        role_name: 'org_member',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { code: string }
    expect(data.code).toBe('NO_EMAIL')
  })

  it.concurrent('invite endpoint normalizes email before validation', async () => {
    const localPart = `no-account-${randomUUID()}`
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/invite'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
        email: `  ${localPart}@EXAMPLE.COM  `,
        role_name: 'org_member',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { code: string }
    expect(data.code).toBe('NO_EMAIL')
  })

  it.concurrent('magic invite lookup returns 404 for unknown tokens', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/org_members/magic-invite?lookup=${randomUUID()}`),
    )

    expect(response.status).toBe(404)
  })

  it.concurrent('rescind endpoint rejects unauthenticated callers', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/rescind'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
        email: 'pending@example.com',
      }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('member role updates reject unauthenticated callers', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/member-role'), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
        user_id: randomUUID(),
        role_name: 'org_member',
      }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('accept endpoint rejects unauthenticated callers', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/accept'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('accept endpoint lets invitees join an organization', async () => {
    const orgId = randomUUID()
    await seedPendingOrgInvitation(orgId, USER_ID_NONMEMBER)

    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/accept'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: orgId,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('ok')

    const membership = await executeSQL<{ is_invite: boolean }>(
      `SELECT is_invite
       FROM public.org_users
       WHERE org_id = $1::uuid
         AND user_id = $2::uuid`,
      [orgId, USER_ID_NONMEMBER],
    )
    expect(membership[0]?.is_invite).toBe(false)
  })

  it.concurrent('decline endpoint rejects unauthenticated callers', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/decline'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('decline endpoint removes pending invitations for the caller', async () => {
    const orgId = randomUUID()
    await seedPendingOrgInvitation(orgId, USER_ID_NONMEMBER)

    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/decline'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: orgId,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('ok')

    const membership = await executeSQL(
      `SELECT 1
       FROM public.org_users
       WHERE org_id = $1::uuid
         AND user_id = $2::uuid`,
      [orgId, USER_ID_NONMEMBER],
    )
    expect(membership).toHaveLength(0)
  })

  it.concurrent('decline endpoint accepts multiple org ids', async () => {
    const orgIdA = randomUUID()
    const orgIdB = randomUUID()
    await seedPendingOrgInvitation(orgIdA, USER_ID_NONMEMBER)
    await seedPendingOrgInvitation(orgIdB, USER_ID_NONMEMBER)

    const response = await fetchTestRequest(getEndpointUrl('/private/org_members/decline'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_ids: [orgIdA, orgIdB],
      }),
    })

    expect(response.status).toBe(200)

    const membership = await executeSQL(
      `SELECT org_id
       FROM public.org_users
       WHERE user_id = $1::uuid
         AND org_id = ANY($2::uuid[])`,
      [USER_ID_NONMEMBER, [orgIdA, orgIdB]],
    )
    expect(membership).toHaveLength(0)
  })
})
