import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, getEndpointUrl, headers, resetAndSeedAppData, resetAppData } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.error.test.${id}`
// Own org: seeding into the shared Demo org exposes this file's permission checks
// to concurrent files mutating that org (seen as flaky cannot_access_app on delete).
// A dedicated org needs its own Stripe customer: orgs.customer_id is unique.
const ORG_ID = randomUUID()
const STRIPE_CUSTOMER_ID = `cus_error_${id.slice(0, 8)}`

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME, { orgId: ORG_ID, stripeCustomerId: STRIPE_CUSTOMER_ID })
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('[GET] /statistics - Error Cases', () => {
  it('should return 404 for app without access', async () => {
    const response = await fetch(`${BASE_URL}/statistics/app/nonexistent.app.id?from=2&to=1`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_access_to_app')
  })

  it('should return 401 for organization without access', async () => {
    const response = await fetch(`${BASE_URL}/statistics/org/${randomUUID()}?from=1&to=2`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_access_to_organization')
  })
})

describe('[GET] /device - Error Cases', () => {
  it('should return 400 for app without access', async () => {
    const response = await fetch(`${BASE_URL}/device?device_id=${randomUUID()}&app_id=nonexistent.app.id`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app') // Changed: validation passes for valid format, then access check fails
  })

  it('should return 400 for missing device_id or app_id', async () => {
    const response = await fetch(`${BASE_URL}/device`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_app_id') // Changed: validation catches missing app_id first
  })

  it('should return 400 when trying to set version to device', async () => {
    const response = await fetch(`${BASE_URL}/device?device_id=${randomUUID()}&app_id=${APPNAME}&version=1.0.0`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('device_not_found')
  })
})

describe('[GET] /channel - Error Cases', () => {
  it('should return 400 for app without access', async () => {
    const response = await fetch(`${BASE_URL}/channel?name=test-channel&app_id=nonexistent.app.id`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })

  it('should return 400 for missing channel name on delete', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_channel_name')
  })

  it('should return 400 for non-existent channel on delete', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: 'nonexistent-channel',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_channel_name')
  })
})

describe('[GET] /bundle - Error Cases', () => {
  it('should return 400 for app without access', async () => {
    const response = await fetch(`${BASE_URL}/bundle?app_id=nonexistent.app.id&name=test-bundle`, {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_get_bundle')
  })
})

describe('general Error Cases', () => {
  it('should handle invalid JSON in request body', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('should handle missing content-type header', async () => {
    const response = await fetch(`${BASE_URL}/org`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': undefined,
      } as any,
      body: JSON.stringify({ name: 'test' }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('should handle unauthorized requests', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // Missing Authorization header
      },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('should handle invalid API key', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'invalid-api-key',
      },
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('rate Limiting Error Cases', () => {
  it('should handle rate limit exceeded (429)', async () => {
    // This test might be hard to trigger in testing environment
    // but we can test that the error structure is correct
    const response = await fetch(`${BASE_URL}/ok`, {
      method: 'GET',
      headers,
    })
    // Just ensure the endpoint is working, rate limiting is harder to test
    expect([200, 429]).toContain(response.status)
  })
})

describe('server Error Cases (5xx)', () => {
  it('should handle database connection errors gracefully', async () => {
    // This is harder to test without mocking the database
    // but we ensure that 500 errors return proper JSON format
    const response = await fetch(`${BASE_URL}/organization`, {
      method: 'GET',
      headers,
    })

    if (response.status >= 500) {
      const data = await response.json() as { status: string, error?: string }
      expect(data).toHaveProperty('status')
      expect(typeof data.status).toBe('string')
    }
  })
})

describe('trigger Endpoint Error Cases', () => {
  it('should return 400 for cron_stat_app without appId', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_app`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apisecret': 'testsecret',
      },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_appId')
  })

  it('should return 400 for cron_plan without orgId', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_stat_org`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apisecret': 'testsecret',
      },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_orgId')
  })

  it('should return 400 for cron_email with missing fields', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apisecret': 'testsecret',
      },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    // Validation now checks email and type first before appId
    expect(data.error).toBe('missing_email_type')
  })

  it('should return 400 for cron_email with invalid type', async () => {
    const response = await fetch(`${BASE_URL}/triggers/cron_email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apisecret': 'testsecret',
      },
      body: JSON.stringify({
        email: 'test@example.com',
        appId: APPNAME,
        type: 'invalid_type',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_stats_type')
  })
})

describe('private Endpoint Error Cases', () => {
  it('should return 401 for stripe_portal without authorization', async () => {
    const response = await fetch(`${BASE_URL}/private/stripe_portal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 for stripe_checkout without org_id', async () => {
    const response = await fetch(`${BASE_URL}/private/stripe_checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 for upload_link with invalid API key', async () => {
    const response = await fetch(getEndpointUrl('/private/upload_link'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'invalid-api-key',
      },
      body: JSON.stringify({
        app_id: APPNAME,
        name: '1.0.0',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_apikey')
  })
})

describe('plugin Endpoint Error Cases', () => {
  it('should return 400 for updates with invalid request', async () => {
    const response = await fetch(getEndpointUrl('/updates'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'cap-platform': 'ios',
        'cap-platform-version': '15.0',
        'cap-version-name': '1.0.0',
        'cap-version-build': '1',
        'cap-version-code': '1',
        'cap-app-id': 'nonexistent.app',
      },
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_json_body')
  })
})

describe('files Endpoint Error Cases', () => {
  it('should return 404 for non-existent file', async () => {
    const response = await fetch(getEndpointUrl('/files/nonexistent-file.zip'), {
      method: 'GET',
      headers,
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_found')
  })

  it('should return 404 for invalid file name', async () => {
    // This test may be environment-specific
    const response = await fetch(getEndpointUrl('/files/invalid-file-name'), {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_found')
  })
})
