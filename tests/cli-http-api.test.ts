import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, getEndpointUrl, ORG_ID, USER_ID } from './test-utils.ts'

const CLI_IDENTITY_URL = getEndpointUrl('/private/cli/identity')
const CLI_PERMISSION_URL = getEndpointUrl('/private/cli/check-permission')
const CLI_ORGANIZATIONS_URL = getEndpointUrl('/private/cli/organizations')
const CLI_BILLING_ENTITLEMENTS_URL = getEndpointUrl('/private/cli/billing/entitlements')
const CLI_BILLING_ALLOWED_ACTIONS_URL = getEndpointUrl('/private/cli/billing/allowed-actions')
const CLI_WARNINGS_URL = getEndpointUrl('/private/cli/warnings')
const CLI_REJECT_ORG_2FA_URL = getEndpointUrl('/private/cli/2fa/reject-org')

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
        org_id: ORG_ID,
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

  it.concurrent('GET /private/cli/billing/entitlements returns billing flags', async () => {
    const response = await fetch(`${CLI_BILLING_ENTITLEMENTS_URL}?org_id=${ORG_ID}`, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      isPaying?: boolean
      trialDays?: number
      hasCredits?: boolean
    }
    expect(typeof body.isPaying).toBe('boolean')
    expect(typeof body.trialDays).toBe('number')
    expect(typeof body.hasCredits).toBe('boolean')
  })

  it.concurrent('POST /private/cli/billing/allowed-actions returns allowed for storage', async () => {
    const response = await fetch(CLI_BILLING_ALLOWED_ACTIONS_URL, {
      method: 'POST',
      headers: apiHeaders(APIKEY_TEST_ALL),
      body: JSON.stringify({
        org_id: ORG_ID,
        actions: ['storage'],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { allowed?: boolean }
    expect(body.allowed).toBe(true)
  })

  it.concurrent('GET /private/cli/warnings returns an array for the org', async () => {
    const response = await fetch(`${CLI_WARNINGS_URL}?org_id=${ORG_ID}&cli_version=99.0.0-test`, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Array.isArray(body)).toBe(true)
  })

  it.concurrent('GET /private/cli/2fa/reject-org returns reject boolean', async () => {
    const response = await fetch(`${CLI_REJECT_ORG_2FA_URL}?org_id=${ORG_ID}`, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { reject?: boolean }
    expect(typeof body.reject).toBe('boolean')
  })
})
