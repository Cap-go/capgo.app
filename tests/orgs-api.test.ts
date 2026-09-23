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
          USER_EMAIL_NONMEMBER,
          USER_PASSWORD_NONMEMBER,
        ),
      },
    )

    expect(response.status).toBe(200)
    const data = await response.json()
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })
})
