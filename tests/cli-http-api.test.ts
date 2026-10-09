import { describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, getEndpointUrl, ORG_ID, USER_ID } from './test-utils.ts'

const APP_ID = 'com.demo.app'
const CLI_IDENTITY_URL = getEndpointUrl('/private/cli/identity')
const CLI_ORGANIZATIONS_URL = getEndpointUrl('/private/cli/organizations')
const CLI_PERMISSIONS_URL = getEndpointUrl('/private/cli/permissions')
const CLI_PREFLIGHT_URL = getEndpointUrl('/private/cli/preflight')

function apiHeaders(apikey: string, apiVersion = '2025-10-01') {
  return {
    'capgkey': apikey,
    'capgo_api': apiVersion,
    'Content-Type': 'application/json',
  }
}

describe('private/cli HTTP API', () => {
  it.concurrent('gET /private/cli/identity resolves the API key actor', async () => {
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

  it.concurrent('rejects an unsupported capgo_api version', async () => {
    const response = await fetch(CLI_IDENTITY_URL, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL, '2099-01-01'),
    })

    expect(response.status).toBe(400)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('unsupported_capgo_api_version')
  })

  it.concurrent('gET /private/cli/organizations returns v7-enriched org rows', async () => {
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

  it.concurrent('gET /private/cli/organizations?permission= flags allowed orgs', async () => {
    const response = await fetch(`${CLI_ORGANIZATIONS_URL}?permission=org.read`, {
      method: 'GET',
      headers: apiHeaders(APIKEY_TEST_ALL),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as Array<{ gid: string, allowed?: boolean }>
    expect(body.find(org => org.gid === ORG_ID)?.allowed).toBe(true)
  })

  it.concurrent('pOST /private/cli/permissions checks several permissions at once', async () => {
    const response = await fetch(CLI_PERMISSIONS_URL, {
      method: 'POST',
      headers: apiHeaders(APIKEY_TEST_ALL),
      body: JSON.stringify({
        permissions: ['org.read', 'org.update_settings'],
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as { permissions?: Record<string, boolean> }
    expect(body.permissions).toEqual({ 'org.read': true, 'org.update_settings': true })
  })

  it.concurrent('pOST /private/cli/preflight resolves the app org for an allowed upload', async () => {
    const response = await fetch(CLI_PREFLIGHT_URL, {
      method: 'POST',
      headers: apiHeaders(APIKEY_TEST_ALL),
      body: JSON.stringify({
        app_id: APP_ID,
        permission: 'app.upload_bundle',
        plan: 'upload',
        cli_version: '99.0.0-test',
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as {
      org_id?: string
      app_id?: string
      trial_days_left?: number | null
      warnings?: unknown[]
    }
    expect(body.org_id).toBe(ORG_ID)
    expect(body.app_id).toBe(APP_ID)
    expect(body.trial_days_left === null || typeof body.trial_days_left === 'number').toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  it.concurrent('pOST /private/cli/preflight returns app_not_found for an unknown app', async () => {
    const response = await fetch(CLI_PREFLIGHT_URL, {
      method: 'POST',
      headers: apiHeaders(APIKEY_TEST_ALL),
      body: JSON.stringify({
        app_id: 'com.missing.cli.preflight',
        permission: 'app.read',
        check_2fa: false,
      }),
    })

    expect(response.status).toBe(404)
    const body = await response.json() as { error?: string }
    expect(body.error).toBe('app_not_found')
  })
})
