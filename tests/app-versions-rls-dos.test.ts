import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ORG_SUPER_ADMIN, APP_NAME, fetchTestRequest, SUPABASE_ANON_KEY, SUPABASE_BASE_URL } from './test-utils.ts'

function getAnonHeaders() {
  if (!SUPABASE_BASE_URL || !SUPABASE_ANON_KEY)
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for app_versions RLS DoS tests')

  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  }
}

function getApiKeyHeaders() {
  return {
    ...getAnonHeaders(),
    capgkey: APIKEY_TEST_ORG_SUPER_ADMIN,
  }
}

function fetchRest(path: string, headers: Record<string, string>) {
  return fetchTestRequest(`${SUPABASE_BASE_URL}/rest/v1/${path}`, { headers })
}

describe('app_versions RLS DoS regression', () => {
  it.concurrent('returns an empty response for unauthenticated unfiltered reads', async () => {
    const response = await fetchRest('app_versions?select=id&limit=1', getAnonHeaders())
    const body = await response.text()

    expect(response.status, body).toBe(200)
    expect(JSON.parse(body)).toEqual([])
  })

  it.concurrent('keeps unrelated anonymous reads available during parallel app_versions probes', async () => {
    const headers = getAnonHeaders()

    const responses = await Promise.all(Array.from({ length: 8 }, () => fetchRest('app_versions?select=id&limit=1', headers)))
    const bodies = await Promise.all(responses.map(response => response.text()))

    for (const [index, response] of responses.entries())
      expect(response.status, bodies[index]).toBe(200)

    const response = await fetchRest('orgs?select=id&limit=1', headers)
    const body = await response.text()

    expect(response.status, body).toBe(200)
  })

  it.concurrent('keeps Capgo API key reads on app_versions working', async () => {
    const response = await fetchRest(`app_versions?select=id,app_id&app_id=eq.${APP_NAME}&limit=1`, getApiKeyHeaders())
    const body = await response.text()

    expect(response.status, body).toBe(200)
    expect(JSON.parse(body).every((row: { app_id: string }) => row.app_id === APP_NAME)).toBe(true)
  })
})
