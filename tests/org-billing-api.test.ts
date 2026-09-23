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

describe('org billing HTTP API', () => {
  it.concurrent('rejects unauthenticated plan-name reads', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/org_billing/plan-name?org_id=${ORG_ID}`))

    expect(response.status).toBe(401)
  })

  it.concurrent('allows org members to read plan billing endpoints', async () => {
    const headers = await getAuthHeaders()

    const planNameResponse = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/plan-name?org_id=${ORG_ID}`),
      { headers },
    )
    expect(planNameResponse.status).toBe(200)
    const planNameData = await planNameResponse.json() as { plan_name: string }
    expect(typeof planNameData.plan_name).toBe('string')
    expect(planNameData.plan_name.length).toBeGreaterThan(0)

    const usageResponse = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/usage-percent?org_id=${ORG_ID}`),
      { headers },
    )
    expect(usageResponse.status).toBe(200)
    const usageData = await usageResponse.json() as {
      total_percent: number
      mau_percent: number
      bandwidth_percent: number
      storage_percent: number
      build_time_percent: number
    }
    expect(typeof usageData.total_percent).toBe('number')

    const storageResponse = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/total-storage?org_id=${ORG_ID}`),
      { headers },
    )
    expect(storageResponse.status).toBe(200)
    const storageData = await storageResponse.json() as { bytes: number }
    expect(typeof storageData.bytes).toBe('number')

    const payingResponse = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/is-paying?org_id=${ORG_ID}`),
      { headers },
    )
    expect(payingResponse.status).toBe(200)
    const payingData = await payingResponse.json() as { is_paying: boolean }
    expect(typeof payingData.is_paying).toBe('boolean')

    const deductionsResponse = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/credit-deductions?org_id=${ORG_ID}`),
      { headers },
    )
    expect(deductionsResponse.status).toBe(200)
    const deductionsData = await deductionsResponse.json()
    expect(Array.isArray(deductionsData)).toBe(true)
  })

  it.concurrent('returns default plan name for unauthorized org access', async () => {
    const response = await fetchTestRequest(
      getEndpointUrl(`/private/org_billing/plan-name?org_id=${ORG_ID}`),
      {
        headers: await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER),
      },
    )

    expect(response.status).toBe(200)
    const data = await response.json() as { plan_name: string }
    expect(data.plan_name).toBe('Solo')
  })

  it.concurrent('find-best-plan returns a plan name for authenticated users', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_billing/find-best-plan'), {
      method: 'POST',
      headers: {
        ...(await getAuthHeaders()),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mau: 100,
        bandwidth: 1_000_000_000,
        storage: 500_000_000,
        build_time_unit: 0,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { plan_name: string }
    expect(typeof data.plan_name).toBe('string')
    expect(data.plan_name.length).toBeGreaterThan(0)
  })

  it.concurrent('platform-admin endpoint returns a boolean for authenticated users', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/org_billing/platform-admin'), {
      headers: await getAuthHeaders(),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { is_admin: boolean }
    expect(typeof data.is_admin).toBe('boolean')
  })
})
