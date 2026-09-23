import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, getEndpointUrl, USER_ID } from './test-utils.ts'

const CLI_IDENTITY_URL = getEndpointUrl('/private/cli/identity')
const CLI_PERMISSION_URL = getEndpointUrl('/private/cli/check-permission')
const CLI_ORGANIZATIONS_URL = getEndpointUrl('/private/cli/organizations')

function apiHeaders(apikey: string) {
  return {
    capgkey: apikey,
    'Content-Type': 'application/json',
  }
}

describe('private/cli HTTP API', () => {
  it.concurrent('GET /private/cli/identity resolves the API key actor', async () => {
    const response = await fetch(CLI_IDENTITY_URL, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      userId?: string
      email?: string | null
      has2fa?: boolean
      apikey_id?: number
    }
    expect(body.userId).toBe(USER_ID)
    expect(body.email).toMatch(/@/)
    expect(typeof body.has2fa).toBe('boolean')
    expect(body.apikey_id).toBeGreaterThan(0)
  })

  it.concurrent('POST /private/cli/check-permission returns allowed for org.read', async () => {
    const response = await fetch(CLI_PERMISSION_URL, {
      method: 'POST',
      headers: apiHeaders(APIKEY_TEST_ALL),
      body: JSON.stringify({
        permission_key: 'org.read',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { allowed?: boolean }
    expect(body.allowed).toBe(true)
  })

  it.concurrent('GET /private/cli/organizations returns v7-enriched org rows', async () => {
    const response = await fetch(CLI_ORGANIZATIONS_URL, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBeGreaterThan(0)
    expect(body[0]).toHaveProperty('gid')
    expect(body[0]).toHaveProperty('name')
    expect(body[0]).toHaveProperty('role')
    expect(body[0]).toHaveProperty('enforcing_2fa')
    expect(body[0]).toHaveProperty('2fa_has_access')
  })
})
