import { describe, expect, it } from 'vitest'
import { fetchTestRequest, getEndpointUrl } from './test-utils.ts'

describe('retired dashboard endpoints', () => {
  it.concurrent.each([
    '/private/admin_stats',
    '/private/admin_credits/grant',
    '/private/admin_org_support_channel',
  ])('returns not found for %s', async (path) => {
    const response = await fetchTestRequest(getEndpointUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(404)
  })
})
