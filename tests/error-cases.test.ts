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

const triggerHeaders = { 'Content-Type': 'application/json', 'apisecret': 'testsecret' }
const invalidApiKeyHeaders = { 'Content-Type': 'application/json', 'Authorization': 'invalid-api-key' }

interface ErrorCase {
  name: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
  status: number
  error: string
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME, { orgId: ORG_ID, stripeCustomerId: STRIPE_CUSTOMER_ID })
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('aPI error responses', () => {
  const cases: ErrorCase[] = [
    // statistics
    { name: 'statistics for an app without access', url: `${BASE_URL}/statistics/app/nonexistent.app.id?from=2&to=1`, status: 401, error: 'no_access_to_app' },
    { name: 'statistics for an organization without access', url: `${BASE_URL}/statistics/org/${randomUUID()}?from=1&to=2`, status: 401, error: 'no_access_to_organization' },
    // device
    { name: 'device for an app without access', url: `${BASE_URL}/device?device_id=${randomUUID()}&app_id=nonexistent.app.id`, status: 400, error: 'cannot_access_app' },
    { name: 'device without app_id', url: `${BASE_URL}/device`, status: 400, error: 'missing_app_id' },
    { name: 'device lookup with a version for an unknown device', url: `${BASE_URL}/device?device_id=${randomUUID()}&app_id=${APPNAME}&version=1.0.0`, status: 404, error: 'device_not_found' },
    // channel
    { name: 'channel for an app without access', url: `${BASE_URL}/channel?name=test-channel&app_id=nonexistent.app.id`, status: 400, error: 'cannot_access_app' },
    { name: 'channel delete without a name', url: `${BASE_URL}/channel`, method: 'DELETE', body: { app_id: APPNAME }, status: 400, error: 'missing_channel_name' },
    { name: 'channel delete for a non-existent channel', url: `${BASE_URL}/channel`, method: 'DELETE', body: { app_id: APPNAME, name: 'nonexistent-channel' }, status: 400, error: 'missing_channel_name' },
    // bundle
    { name: 'bundle for an unknown app', url: `${BASE_URL}/bundle?app_id=nonexistent.app.id&name=test-bundle`, status: 404, error: 'app_not_found' },
    // triggers
    { name: 'cron_stat_app without appId', url: `${BASE_URL}/triggers/cron_stat_app`, method: 'POST', headers: triggerHeaders, body: {}, status: 400, error: 'no_appId' },
    { name: 'cron_stat_org without orgId', url: `${BASE_URL}/triggers/cron_stat_org`, method: 'POST', headers: triggerHeaders, body: {}, status: 400, error: 'no_orgId' },
    // Validation checks email and type first before appId
    { name: 'cron_email with missing fields', url: `${BASE_URL}/triggers/cron_email`, method: 'POST', headers: triggerHeaders, body: {}, status: 400, error: 'missing_email_type' },
    { name: 'cron_email with an invalid type', url: `${BASE_URL}/triggers/cron_email`, method: 'POST', headers: triggerHeaders, body: { email: 'test@example.com', appId: APPNAME, type: 'invalid_type' }, status: 400, error: 'invalid_stats_type' },
    // private endpoints require a JWT / valid API key
    { name: 'stripe_portal without a JWT', url: `${BASE_URL}/private/stripe_portal`, method: 'POST', body: {}, status: 401, error: 'invalid_jwt' },
    { name: 'stripe_past_due without a JWT', url: `${BASE_URL}/private/stripe_past_due`, method: 'POST', body: {}, status: 401, error: 'invalid_jwt' },
    { name: 'stripe_checkout without a JWT', url: `${BASE_URL}/private/stripe_checkout`, method: 'POST', body: {}, status: 401, error: 'invalid_jwt' },
    { name: 'upload_link with an invalid API key', url: getEndpointUrl('/private/upload_link'), method: 'POST', headers: invalidApiKeyHeaders, body: { app_id: APPNAME, name: '1.0.0' }, status: 401, error: 'invalid_apikey' },
    // plugin
    {
      name: 'updates with an invalid body',
      url: getEndpointUrl('/updates'),
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
      body: {},
      status: 400,
      error: 'invalid_json_body',
    },
    // files
    { name: 'a non-existent file', url: getEndpointUrl('/files/nonexistent-file.zip'), status: 404, error: 'not_found' },
    { name: 'an invalid file name', url: getEndpointUrl('/files/invalid-file-name'), status: 404, error: 'not_found' },
  ]

  it.each(cases)('returns $status $error for $name', async ({ url, method = 'GET', headers: caseHeaders = headers, body, status, error }) => {
    const response = await fetch(url, {
      method,
      headers: caseHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(response.status).toBe(status)
    const data = await response.json() as { error: string }
    expect(data.error).toBe(error)
  })
})

describe('general error cases', () => {
  it.each([
    { name: 'invalid JSON in request body', url: `${BASE_URL}/organization`, init: { method: 'POST', headers, body: 'invalid json' } },
    { name: 'missing content-type header', url: `${BASE_URL}/org`, init: { method: 'POST', headers: { ...headers, 'Content-Type': undefined } as any, body: JSON.stringify({ name: 'test' }) } },
    { name: 'missing Authorization header', url: `${BASE_URL}/organization`, init: { method: 'GET', headers: { 'Content-Type': 'application/json' } } },
    { name: 'invalid API key', url: `${BASE_URL}/organization`, init: { method: 'GET', headers: invalidApiKeyHeaders } },
  ])('rejects $name', async ({ url, init }) => {
    const response = await fetch(url, init)
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})
