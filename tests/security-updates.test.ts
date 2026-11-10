import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppAdvisoryFeedResponse } from '../supabase/functions/shared/security_advisory.ts'
import { executeSQL, fetchTestRequest, getAuthHeaders, getEndpointUrl, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const DEMO_APP_ID = 'com.demo.app'

describe('[GET] /private/security_updates/feed', () => {
  it.concurrent('rejects unauthenticated requests', async () => {
    const response = await fetchTestRequest(
      `${getEndpointUrl('/private/security_updates/feed')}?app_id=${encodeURIComponent(DEMO_APP_ID)}`,
      { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    )
    expect(response.status).toBe(401)
  })

  it.concurrent('rejects users without app.read on the requested app', async () => {
    const response = await fetchTestRequest(
      `${getEndpointUrl('/private/security_updates/feed')}?app_id=com.demoadmin.app`,
      { method: 'GET', headers: await getAuthHeaders() },
    )
    expect(response.status).toBe(403)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('app_access_denied')
  })

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

describe('[GET] /private/security_updates/feed reported package sourcing', () => {
  const appId = `com.test.security.feed.${randomUUID()}`

  beforeAll(async () => {
    await resetAndSeedAppData(appId)
    const iosOnlyPackages = JSON.stringify([{ name: '@capacitor/ios', version: '6.2.0' }])
    await executeSQL(
      `INSERT INTO public.app_versions (
         app_id, name, owner_org, deleted, storage_provider, r2_path, checksum,
         native_packages, cli_version, user_id
       )
       SELECT $1, 'core-placeholder-prod', a.owner_org, false, 'r2',
         'orgs/' || a.owner_org::text || '/apps/' || $1 || '/core-placeholder-prod.zip',
         'feedabc1', $2::jsonb, '1.9.0', a.user_id
       FROM public.apps a WHERE a.app_id = $1
       ON CONFLICT (name, app_id) DO NOTHING`,
      [appId, iosOnlyPackages],
    )
    const prodRows = await executeSQL<{ id: number }>(
      `SELECT id FROM public.app_versions WHERE app_id = $1 AND name = 'core-placeholder-prod' LIMIT 1`,
      [appId],
    )
    const prodVersionId = Number(prodRows[0]?.id)
    await executeSQL(
      `UPDATE public.channels SET version = $1, updated_at = NOW()
       WHERE app_id = $2 AND name = 'production'`,
      [prodVersionId, appId],
    )
    await executeSQL(
      `INSERT INTO public.app_versions (
         app_id, name, owner_org, deleted, storage_provider, r2_path, checksum,
         native_packages, cli_version, user_id
       )
       SELECT $1, 'cli-latest-upload', a.owner_org, false, 'r2',
         'orgs/' || a.owner_org::text || '/apps/' || $1 || '/cli-latest-upload.zip',
         'feedabc2', '[]'::jsonb, '2.1.0', a.user_id
       FROM public.apps a WHERE a.app_id = $1
       ON CONFLICT (name, app_id) DO NOTHING`,
      [appId],
    )
  })

  afterAll(async () => {
    await resetAppData(appId)
  })

  it('reports core as unknown when production lists ios only', async () => {
    const response = await fetchTestRequest(
      `${getEndpointUrl('/private/security_updates/feed')}?app_id=${encodeURIComponent(appId)}`,
      { method: 'GET', headers: await getAuthHeaders() },
    )
    expect(response.status).toBe(200)
    const data = await response.json() as AppAdvisoryFeedResponse
    const coreItems = data.items.filter(item => item.package === '@capacitor/core')
    expect(coreItems.length).toBeGreaterThan(0)
    expect(coreItems.every(item => item.status === 'unknown')).toBe(true)
    expect(coreItems.every(item => item.current_version === '')).toBe(true)
  })

  it('uses the latest upload cli_version while production supplies native packages', async () => {
    const response = await fetchTestRequest(
      `${getEndpointUrl('/private/security_updates/feed')}?app_id=${encodeURIComponent(appId)}`,
      { method: 'GET', headers: await getAuthHeaders() },
    )
    expect(response.status).toBe(200)
    const data = await response.json() as AppAdvisoryFeedResponse
    const cli = data.items.find(item => item.package === '@capgo/cli')
    expect(cli?.current_version).toBe('2.1.0')
    expect(cli?.status).toBe('patched')
    const ios = data.items.find(item => item.package === '@capacitor/ios')
    expect(ios?.current_version).toBe('6.2.0')
  })
})
