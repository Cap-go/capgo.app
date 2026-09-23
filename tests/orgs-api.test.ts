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
  USER_EMAIL_ORGS_API_EMPTY,
  USER_ID,
  USER_PASSWORD_NONMEMBER,
  USER_PASSWORD_ORGS_API_EMPTY,
} from './test-utils'

describe('orgs HTTP API', () => {
  it.concurrent('rejects unauthenticated organization list reads', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/orgs'))

    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('allows authenticated users to list their organizations', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl('/private/orgs'),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as Array<{
      gid: string
      name: string
      role: string
      app_count: number
      is_invite: boolean | null
      enforcing_2fa: boolean
      password_policy_config: unknown
    }>

    expect(Array.isArray(data)).toBe(true)
    expect(data.length).toBeGreaterThan(0)
    expect(data.some(org => org.gid === ORG_ID)).toBe(true)

    const seededOrg = data.find(org => org.gid === ORG_ID)
    expect(seededOrg).toBeTruthy()
    expect(typeof seededOrg!.name).toBe('string')
    expect(typeof seededOrg!.role).toBe('string')
    expect(typeof seededOrg!.app_count).toBe('number')
    expect(typeof seededOrg!.enforcing_2fa).toBe('boolean')
    expect(seededOrg).toHaveProperty('password_policy_config')
  })

  it.concurrent('returns an empty list for users without organization membership', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl('/private/orgs'),
      {
        headers: await getAuthHeadersForCredentials(
          USER_EMAIL_ORGS_API_EMPTY,
          USER_PASSWORD_ORGS_API_EMPTY,
        ),
      },
    )

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })

  it.concurrent('allows org members to read security settings', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/security-settings?org_id=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as {
      enforcing_2fa: boolean
      enforce_hashed_api_keys: boolean
      enforce_encrypted_bundles: boolean
      required_encryption_key: string | null
    }
    expect(typeof data.enforcing_2fa).toBe('boolean')
    expect(typeof data.enforce_hashed_api_keys).toBe('boolean')
    expect(typeof data.enforce_encrypted_bundles).toBe('boolean')
    expect(data.required_encryption_key === null || typeof data.required_encryption_key === 'string').toBe(true)
  })

  it.concurrent('allows org members to read support channel settings', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/support-channel?org_id=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as {
      support_channel_type: string | null
      support_channel_url: string | null
    }
    expect('support_channel_type' in data).toBe(true)
    expect('support_channel_url' in data).toBe(true)
  })

  it.concurrent('allows org members to read chart refresh state', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/chart-refresh-state?org_id=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as {
      stats_updated_at: string | null
      stats_refresh_requested_at: string | null
    }
    expect('stats_updated_at' in data).toBe(true)
    expect('stats_refresh_requested_at' in data).toBe(true)
  })

  it.concurrent('allows org members to read billing paid_at', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/billing-paid-at?org_id=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as { paid_at: string | null }
    expect('paid_at' in data).toBe(true)
    expect(data.paid_at === null || typeof data.paid_at === 'string').toBe(true)
  })

  it.concurrent('allows org members to batch-read org names', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/names?ids=${ORG_ID}`),
      { headers: await getAuthHeaders() },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as Array<{ id: string, name: string }>
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(1)
    expect(data[0]?.id).toBe(ORG_ID)
    expect(typeof data[0]?.name).toBe('string')
  })

  it.concurrent('allows org admins to patch organization settings', async () => {
    const headers = await getAuthHeaders()
    const originalName = 'Demo org'
    const updatedName = `Demo org ${randomUUID().slice(0, 8)}`

    const updateResponse = await fetchTestRequest(
      getEndpointUrl('/private/orgs'),
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          org_id: ORG_ID,
          name: updatedName,
        }),
      },
    )
    expect(updateResponse.status).toBe(200)

    const namesResponse = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/names?ids=${ORG_ID}`),
      { headers },
    )
    expect(namesResponse.status).toBe(200)
    const names = await namesResponse.json() as Array<{ id: string, name: string }>
    expect(names[0]?.name).toBe(updatedName)

    const revertResponse = await fetchTestRequest(
      getEndpointUrl('/private/orgs'),
      {
        method: 'PATCH',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          org_id: ORG_ID,
          name: originalName,
        }),
      },
    )
    expect(revertResponse.status).toBe(200)
  })

  it.concurrent('allows org admins to delete organizations they own', async () => {
    const orgId = randomUUID()
    await executeSQL(
      `INSERT INTO public.orgs (id, name, management_email, created_by)
       VALUES ($1::uuid, $2, $3, $4::uuid)`,
      [orgId, `Delete test ${orgId}`, `delete-${orgId}@example.com`, USER_ID],
    )

    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs?org_id=${orgId}`),
      {
        method: 'DELETE',
        headers: await getAuthHeaders(),
      },
    )

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data).toEqual({ status: 'ok' })
  })

  it.concurrent('denies non-members access to organization detail routes', async () => {
    const headers = await getAuthHeadersForCredentials(
      USER_EMAIL_NONMEMBER,
      USER_PASSWORD_NONMEMBER,
    )

    const response = await fetchTestRequest(
      getEndpointUrl(`/private/orgs/security-settings?org_id=${ORG_ID}`),
      { headers },
    )

    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
