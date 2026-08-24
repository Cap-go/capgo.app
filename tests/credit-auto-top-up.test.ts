import { afterAll, describe, expect, it } from 'vitest'
import { executeSQL, fetchTestRequest, getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, ORG_ID, USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER } from './test-utils'

interface AutoTopUpSettings {
  enabled: boolean
  threshold: number
  hasPaymentMethod: boolean
  availableCredits: number
  error?: string
}

const originalSettings = await executeSQL<{ auto_top_up_enabled: boolean, auto_top_up_threshold: number }>(
  'SELECT auto_top_up_enabled, auto_top_up_threshold FROM public.orgs WHERE id = $1',
  [ORG_ID],
)

afterAll(async () => {
  const row = originalSettings[0]
  if (!row)
    return
  await executeSQL(
    'UPDATE public.orgs SET auto_top_up_enabled = $2, auto_top_up_threshold = $3 WHERE id = $1',
    [ORG_ID, row.auto_top_up_enabled, row.auto_top_up_threshold],
  )
})

describe('credit auto top-up API', () => {
  it.concurrent('rejects unauthenticated auto top-up reads', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/credits/auto-top-up?orgId=${ORG_ID}`), {
      method: 'GET',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it.concurrent('rejects auto top-up reads for authenticated non-members', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/credits/auto-top-up?orgId=${ORG_ID}`), {
      method: 'GET',
      headers: await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('returns auto top-up settings for org billing readers', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/credits/auto-top-up?orgId=${ORG_ID}`), {
      method: 'GET',
      headers: await getAuthHeaders(),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as AutoTopUpSettings
    expect(data.enabled).toBe(false)
    expect(data.threshold).toBeGreaterThanOrEqual(10)
    expect(typeof data.hasPaymentMethod).toBe('boolean')
  })

  it('rejects thresholds below $10', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/credits/auto-top-up'), {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({
        orgId: ORG_ID,
        enabled: false,
        threshold: 9,
      }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
    const data = await response.json() as AutoTopUpSettings
    expect(data.error).toBe('invalid_threshold')
  })

  it('saves a disabled auto top-up threshold of at least $10', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/credits/auto-top-up'), {
      method: 'POST',
      headers: await getAuthHeaders(),
      body: JSON.stringify({
        orgId: ORG_ID,
        enabled: false,
        threshold: 25,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as AutoTopUpSettings
    expect(data.enabled).toBe(false)
    expect(data.threshold).toBe(25)
  })
})
