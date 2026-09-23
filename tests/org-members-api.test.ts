import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  fetchTestRequest,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  ORG_ID,
  USER_EMAIL_NONMEMBER,
  USER_PASSWORD_NONMEMBER,
} from './test-utils'

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
})
