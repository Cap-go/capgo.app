/**
 * App ID Validation Tests
 *
 * IMPORTANT: These integration tests require the backend to be running with the latest code.
 * If tests fail with unexpected status codes, restart Supabase Edge Functions:
 *   supabase functions serve --no-verify-jwt
 *
 * or for Cloudflare Workers:
 *   npm run dev:cloudflare (or restart the workers)
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isValidAppId } from '../supabase/functions/_backend/utils/utils.ts'
import { BASE_URL, createDirectApiKeyWithBindings, getSupabaseClient, headers, resetAndSeedAppData, resetAppData, TEST_EMAIL, USER_ID } from './test-utils.ts'

const id = randomUUID()
const VALID_APPNAME = `com.app.valid.${id}`
const appCreationApiKey = randomUUID()
let testOrgId: string
let testOrgApiKeyId: number | null = null
let testOrgHeaders: Record<string, string>

beforeAll(async () => {
  await resetAndSeedAppData(VALID_APPNAME)

  // Create test organization
  const { data: orgData, error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: randomUUID(),
    name: `Test App ID Validation Org ${id}`,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
  }).select().single()

  if (orgError)
    throw orgError
  testOrgId = orgData.id

  const apiKey = await createDirectApiKeyWithBindings({
    key: appCreationApiKey,
    name: `app-id-validation-${id}`,
    orgId: testOrgId,
    roleName: 'org_super_admin',
  })
  if (!apiKey.key)
    throw new Error('Failed to create app id validation API key')

  testOrgApiKeyId = apiKey.id
  testOrgHeaders = {
    'Content-Type': 'application/json',
    'Authorization': apiKey.key,
  }
})

afterAll(async () => {
  await resetAppData(VALID_APPNAME)
  if (testOrgApiKeyId !== null)
    await getSupabaseClient().from('apikeys').delete().eq('id', testOrgApiKeyId)
  await getSupabaseClient().from('orgs').delete().eq('id', testOrgId)
})

describe('isValidAppId helper function', () => {
  it.concurrent('accepts reverse domain app IDs', () => {
    for (const appId of ['com.example.app', 'ee.forgr.demoapp', 'com.company.product-name', 'com.company.product_name', 'io.ionic.starter'])
      expect(isValidAppId(appId), appId).toBe(true)
  })

  it.concurrent('rejects malformed, empty or missing app IDs', () => {
    for (const appId of ['', 'app', 'app_name', '.com.example', 'com.example.', 'com..example', 'com.example.app+', '[appid]', null, undefined])
      expect(isValidAppId(appId as any), String(appId)).toBe(false)
  })
})

describe('public API app_id validation', () => {
  const appBody = (app_id: string) => () => ({ app_id, name: 'Test App', owner_org: testOrgId })
  const bundleBody = (app_id: string) => () => ({ app_id, version: '1.0.0', external_url: 'https://example.com/bundle.zip', checksum: 'abc123' })
  const channelBody = (app_id: string) => () => ({ app_id, channel: 'test-channel' })

  it.concurrent.each([
    ['POST', '/app', 'invalid-app-id', appBody('invalid-app-id')],
    ['POST', '/app', 'justappname', appBody('justappname')],
    ['POST', '/bundle', 'invalid-app', bundleBody('invalid-app')],
    ['POST', '/bundle', '.com.example.app', bundleBody('.com.example.app')],
    ['POST', '/channel', 'nodomainapp', channelBody('nodomainapp')],
    ['POST', '/channel', 'com.example.app+special', channelBody('com.example.app+special')],
    ['POST', '/device', 'badappid', () => ({ app_id: 'badappid', device_id: '00000000-0000-0000-0000-000000000000' })],
    ['GET', '/app/invalid-app-id', ''],
    ['GET', '/app/[appid]', ''],
    ['PUT', '/app/no-domain', 'no-domain', () => ({ name: 'Updated Name' })],
    ['DELETE', '/app/justname', ''],
    ['GET', '/bundle?app_id=invalid', ''],
    ['DELETE', '/bundle?app_id=badid&version=1.0.0', ''],
    ['GET', '/channel?app_id=wrongformat', ''],
    ['DELETE', '/channel?app_id=bad&channel=production', ''],
    ['GET', '/device?app_id=wrongformat', ''],
    ['DELETE', '/device?app_id=bad&device_id=00000000-0000-0000-0000-000000000000', ''],
  ] as [string, string, string, (() => Record<string, unknown>)?][])('rejects %s %s %s with invalid_app_id', async (method, path, _appId, body) => {
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body()) } : {}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_app_id')
  })

  it('accepts app creation with a valid app_id', async () => {
    const validAppId = `com.test.valid.${randomUUID()}`
    const response = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers: testOrgHeaders,
      body: JSON.stringify({
        app_id: validAppId,
        name: 'Test Valid App',
        owner_org: testOrgId,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json() as { app_id: string }
    expect(data.app_id).toBe(validAppId)

    await getSupabaseClient().from('apps').delete().eq('app_id', validAppId)
  })
})
