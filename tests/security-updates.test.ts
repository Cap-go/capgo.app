import { describe, expect, it } from 'vitest'
import type { AppAdvisoryFeedResponse } from '../supabase/functions/shared/security_advisory.ts'
import { fetchTestRequest, getAuthHeaders, getEndpointUrl } from './test-utils.ts'

const DEMO_APP_ID = 'com.demo.app'

describe('[GET] /private/security_updates/feed', () => {
  it('returns feed and per-app matches for an authorized app', async () => {
    const response = await fetchTestRequest(
      `${getEndpointUrl('/private/security_updates/feed')}?app_id=${encodeURIComponent(DEMO_APP_ID)}`,
      { method: 'GET', headers: await getAuthHeaders() },
    )
    expect(response.status).toBe(200)
    const data = await response.json() as AppAdvisoryFeedResponse
    expect(data.app_id).toBe(DEMO_APP_ID)
    expect(data.feed.advisories.length).toBeGreaterThan(0)
    expect(typeof data.feed.generated_at).toBe('string')
    expect(Array.isArray(data.items)).toBe(true)
    for (const item of data.items) {
      expect(item.advisory).toBeTruthy()
      expect(item.affected.package).toBe(item.package)
      expect(['affected', 'patched', 'unknown']).toContain(item.status)
    }
  })

  it('rejects missing app_id', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/security_updates/feed'), {
      method: 'GET',
      headers: await getAuthHeaders(),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
