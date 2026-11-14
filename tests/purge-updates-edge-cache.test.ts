import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, getAuthHeaders, getEndpointUrl, resetAndSeedAppData } from './test-utils.ts'

const APPNAME = `com.purge_edge_cache_${randomUUID().replaceAll('-', '').slice(0, 12)}`

let authHeaders: Record<string, string>

function postPurge(appId: string) {
  return fetch(getEndpointUrl('/private/purge_updates_edge_cache'), {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId }),
  })
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
  authHeaders = await getAuthHeaders()
  await executeSQL('DELETE FROM public.app_manual_updates_edge_purge WHERE app_id = $1', [APPNAME])
})

afterAll(async () => {
  await executeSQL('DELETE FROM public.app_manual_updates_edge_purge WHERE app_id = $1', [APPNAME])
})

describe('/private/purge_updates_edge_cache', () => {
  it('requires authentication', async () => {
    const response = await fetch(getEndpointUrl('/private/purge_updates_edge_cache'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APPNAME }),
    })
    expect(response.status).toBe(401)
  })

  it('purges the app edge cache tag when configured and enforces per-app rate limit', async () => {
    const first = await postPurge(APPNAME)
    expect([200, 503, 502]).toContain(first.status)
    const firstBody = await first.json() as { status?: string, error?: string, nudged?: boolean, purged?: boolean }
    if (first.status === 200) {
      expect(firstBody.status).toBe('ok')
      expect(firstBody.nudged).toBe(true)
    }

    const second = await postPurge(APPNAME)
    expect(second.status).toBe(429)
    const secondBody = await second.json() as { error?: string, moreInfo?: { retryAfterSeconds?: number } }
    expect(secondBody.error).toBe('purge_rate_limited')
    expect(secondBody.moreInfo?.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('rejects callers without app write rights', async () => {
    const response = await postPurge('com.demoadmin.app')
    expect(response.status).toBe(403)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('not_authorized')
  })
})