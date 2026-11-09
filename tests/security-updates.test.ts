import { describe, expect, it } from 'vitest'
import type { AppAdvisoryFeedResponse } from '../supabase/functions/shared/security_advisory.ts'
import { executeSQL, fetchTestRequest, getAuthHeaders, getEndpointUrl } from './test-utils.ts'

const DEMO_APP_ID = 'com.demo.app'
const DEMO_PRODUCTION_VERSION_ID = 3

const DEMO_NATIVE_PACKAGES = [
  { name: '@capacitor/camera', version: '6.1.0' },
  { name: '@capgo/capacitor-updater', version: '6.14.9' },
]

describe('[GET] /private/security_updates/feed', () => {
  it('returns feed and per-app matches for an authorized app', async () => {
    await executeSQL(
      `UPDATE public.app_versions
       SET native_packages = ARRAY[$1::jsonb, $2::jsonb], cli_version = $3
       WHERE id = $4`,
      [
        JSON.stringify(DEMO_NATIVE_PACKAGES[0]),
        JSON.stringify(DEMO_NATIVE_PACKAGES[1]),
        '1.9.0',
        DEMO_PRODUCTION_VERSION_ID,
      ],
    )

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
    const core = data.items.find(item => item.package === '@capacitor/core')
    expect(core?.current_version).toBe('6.1.0')
    expect(core?.status).toBe('affected')
    const cli = data.items.find(item => item.package === '@capgo/cli')
    expect(cli?.current_version).toBe('1.9.0')
    expect(cli?.status).toBe('affected')
  })

  it('rejects missing app_id', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/security_updates/feed'), {
      method: 'GET',
      headers: await getAuthHeaders(),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('missing_app_id')
  })
})
