import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, BASE_URL } from './test-utils.ts'

// The OpenAPI spec documents x-api-key as the primary header and OAuth clients send the
// MCP-issued API key as a Bearer token: every form must reach the same API key auth.
describe('public API key headers', () => {
  it.each([
    ['x-api-key', { 'x-api-key': APIKEY_TEST_ALL }],
    ['capgkey', { capgkey: APIKEY_TEST_ALL }],
    ['raw authorization', { authorization: APIKEY_TEST_ALL }],
    ['Bearer authorization', { authorization: `Bearer ${APIKEY_TEST_ALL}` }],
  ])('authenticates GET /app with %s and reports the rate limit', async (_name, headers) => {
    const response = await fetch(`${BASE_URL}/app/`, { headers })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('RateLimit-Policy')).toMatch(/^"apikey";q=\d+;w=60$/)
    expect(response.headers.get('RateLimit')).toMatch(/^"apikey";r=\d+;t=\d+$/)
  })

  it('rejects an unknown Bearer API key without treating it as a JWT', async () => {
    const response = await fetch(`${BASE_URL}/app/`, { headers: { authorization: 'Bearer 00000000-0000-4000-8000-000000000000' } })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_apikey' })
  })
})

describe('rate limit headers on console sessions', () => {
  it('does not advertise the API key or failed-auth quota on JWT-authenticated responses', async () => {
    const { getAuthHeaders } = await import('./test-utils.ts')
    const response = await fetch(`${BASE_URL}/user/`, { headers: await getAuthHeaders() })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('RateLimit-Policy')).toBeNull()
  })
})
