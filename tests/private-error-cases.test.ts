import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APIKEY_STATS, createDirectApiKeyWithBindings, executeSQL, getEndpointUrl, getSupabaseClient, headers, NON_OWNER_ORG_ID, ORG_ID, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.private.error.${id}`
// Use unique org ID per test run to prevent conflicts with parallel tests
const testOrgId = randomUUID()
const testOrgEmail = `test-private-error-${id}@capgo.app`
const testCustomerId = `cus_test_${id}`
const testOrgApiKey = randomUUID()
let testOrgHeaders: Record<string, string>
let testOrgApiKeyId: number | null = null

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)

  // Create stripe_info for this test org (so user can access it via RLS)
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: testCustomerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${id}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  // Create unique test organization with a customer_id so RLS allows access.
  const { error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: testOrgId,
    name: `Test Private Error Org ${id}`,
    management_email: testOrgEmail,
    created_by: USER_ID,
    customer_id: testCustomerId,
  })

  if (orgError)
    throw orgError

  const apiKey = await createDirectApiKeyWithBindings({
    key: testOrgApiKey,
    name: `private-error-org-${id}`,
    orgId: testOrgId,
    roleName: 'org_super_admin',
  })
  if (!apiKey.key)
    throw new Error('Failed to create private error API key')

  testOrgApiKeyId = apiKey.id
  testOrgHeaders = {
    'Content-Type': 'application/json',
    'Authorization': apiKey.key,
  }
})

afterAll(async () => {
  await resetAppData(APPNAME)

  // Clean up the unique test organization
  if (testOrgApiKeyId !== null)
    await getSupabaseClient().from('apikeys').delete().eq('id', testOrgApiKeyId).throwOnError()
  await getSupabaseClient().from('orgs').delete().eq('id', testOrgId)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', testCustomerId)
})

describe('[POST] /private/create_device - Error Cases', () => {
  it.concurrent('should reject app/org scope mismatch in permission checks', async () => {
    const [result] = await executeSQL(`
      SELECT public.rbac_check_permission_direct(
        public.rbac_perm_app_update_settings(),
        $1::uuid,
        $2::uuid,
        $3,
        NULL::bigint,
        NULL
      ) AS allowed
    `, [USER_ID, testOrgId, APPNAME])

    expect(result.allowed).toBe(false)
  })

  it.concurrent('should reject API key app/org scope mismatch in direct permission checks', async () => {
    const [result] = await executeSQL(`
      SELECT
        public.rbac_check_permission_direct(
          public.rbac_perm_app_update_settings(),
          $1::uuid,
          $2::uuid,
          $3,
          NULL::bigint,
          $4
        ) AS allowed,
        public.rbac_check_permission_direct_no_password_policy(
          public.rbac_perm_app_update_settings(),
          $1::uuid,
          $2::uuid,
          $3,
          NULL::bigint,
          $4
        ) AS allowed_no_password_policy
    `, [USER_ID, testOrgId, APPNAME, testOrgApiKey])

    expect(result.allowed).toBe(false)
    expect(result.allowed_no_password_policy).toBe(false)
  })

  it.concurrent('should return 401 when org_id does not own the app', async () => {
    const deviceId = randomUUID()
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers: testOrgHeaders,
      body: JSON.stringify({
        app_id: APPNAME,
        org_id: testOrgId,
        device_id: deviceId,
        platform: 'android',
        version_name: '1.0.0',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_authorized')

    const { data: device, error: deviceError } = await getSupabaseClient()
      .from('devices')
      .select('device_id')
      .eq('app_id', APPNAME)
      .eq('device_id', deviceId)
      .maybeSingle()
    expect(deviceError).toBeNull()
    expect(device).toBeNull()
  })

  it.concurrent('should allow device creation when normalized org_id owns the app', async () => {
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        org_id: ORG_ID.toUpperCase(),
        device_id: randomUUID(),
        platform: 'android',
        version_name: '1.0.0',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { status: string }
    expect(data.status).toBe('ok')
  })
})

describe('[DELETE] /private/delete_failed_version', () => {
  it('allows app_uploader keys to clean up incomplete r2-direct versions', async () => {
    const bundleName = `1.0.0-failed-upload-${id.slice(0, 8)}`
    const createdApikey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `delete-failed-uploader-${id}`,
      orgId: ORG_ID,
      roleName: 'apikey_org_reader',
      appId: APPNAME,
      appRoleName: 'app_uploader',
    })
    if (!createdApikey.key)
      throw new Error('Expected plain API key from createDirectApiKeyWithBindings')

    try {
      const { data: version, error: versionError } = await getSupabaseClient()
        .from('app_versions')
        .insert({
          app_id: APPNAME,
          name: bundleName,
          checksum: '',
          owner_org: ORG_ID,
          user_id: USER_ID,
          storage_provider: 'r2-direct',
          deleted: false,
        })
        .select('id')
        .single()
      if (versionError || !version)
        throw new Error(`Failed to create incomplete version: ${versionError?.message}`)

      const response = await fetch(getEndpointUrl('/private/delete_failed_version'), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': createdApikey.key,
        },
        body: JSON.stringify({
          app_id: APPNAME,
          name: bundleName,
        }),
      })
      expect(response.status).toBe(200)
      const data = await response.json() as { status: string }
      expect(data.status).toBe('ok')

      const { data: remaining, error: remainingError } = await getSupabaseClient()
        .from('app_versions')
        .select('id')
        .eq('id', version.id)
        .maybeSingle()
      expect(remainingError).toBeNull()
      expect(remaining).toBeNull()

      const denied = await fetch(getEndpointUrl('/private/delete_failed_version'), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': createdApikey.key,
        },
        body: JSON.stringify({
          app_id: 'com.demoadmin.app',
          name: '1.0.0',
        }),
      })
      expect(denied.status).toBe(401)
      const deniedData = await denied.json() as { error: string }
      expect(deniedData.error).toBe('not_authorized')
    }
    finally {
      await getSupabaseClient().from('apikeys').delete().eq('id', createdApikey.id).throwOnError()
    }
  })
})

type HeaderMode = 'none' | 'default' | 'testOrg' | 'statsKey'

interface ErrorCase {
  method?: 'GET' | 'POST' | 'DELETE'
  auth?: HeaderMode
  body?: Record<string, unknown> | string
}

function resolveHeaders(mode: HeaderMode): Record<string, string> {
  switch (mode) {
    case 'none':
      return { 'Content-Type': 'application/json' }
    case 'testOrg':
      return testOrgHeaders
    case 'statsKey':
      return { 'Content-Type': 'application/json', 'capgkey': APIKEY_STATS }
    default:
      return headers
  }
}

function requestPrivate(path: string, { method = 'POST', auth = 'default', body }: ErrorCase) {
  return fetch(getEndpointUrl(path), {
    method,
    headers: resolveHeaders(auth),
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
}

// [label, path, request, expected status, expected error code (null = only check status)]
// Bodies are built lazily so they can reference fixtures created in beforeAll.
const errorCases: Array<[string, string, () => ErrorCase, number, string | null]> = [
  // create_device
  ['create_device without auth', '/private/create_device', () => ({ auth: 'none', body: { app_id: APPNAME, org_id: NON_OWNER_ORG_ID, device_id: randomUUID(), platform: 'android', version: 1 } }), 401, 'no_jwt_apikey_or_subkey'],
  ['create_device invalid JSON body', '/private/create_device', () => ({ body: 'invalid json' }), 400, 'invalid_json_parse_body'],
  ['create_device unknown app in an org the key administers', '/private/create_device', () => ({ auth: 'testOrg', body: { app_id: 'nonexistent.app', org_id: testOrgId, device_id: randomUUID(), platform: 'android', version_name: '1.0.0' } }), 404, 'app_not_found'],
  ['create_device for an app the user cannot access', '/private/create_device', () => ({ body: { app_id: 'com.demoadmin.app', org_id: NON_OWNER_ORG_ID, device_id: randomUUID(), platform: 'android', version_name: '1.0.0' } }), 401, 'not_authorized'],
  // upload_link
  ['upload_link for an app the user cannot access', '/private/upload_link', () => ({ body: { app_id: 'nonexistent.app', version: '1.0.0' } }), 400, 'app_access_denied'],
  ['upload_link for an unknown version', '/private/upload_link', () => ({ body: { app_id: APPNAME, version: '1.0.0' } }), 404, 'error_version_not_found'],
  ['upload_link for the placeholder unknown version', '/private/upload_link', () => ({ body: { app_id: APPNAME, version: 'unknown' } }), 404, 'error_version_not_found'],
  // download_link
  ['download_link without auth', '/private/download_link', () => ({ auth: 'none', body: { app_id: APPNAME, version: '1.0.0' } }), 401, 'no_jwt_apikey_or_subkey'],
  ['download_link with an API key instead of a JWT', '/private/download_link', () => ({ body: { app_id: 'nonexistent.app', version: '1.0.0' } }), 401, 'invalid_jwt'],
  // delete_failed_version
  ['delete_failed_version for an app the user cannot access', '/private/delete_failed_version', () => ({ method: 'DELETE', body: { app_id: 'nonexistent.app', name: '1.0.0' } }), 401, 'not_authorized'],
  ['delete_failed_version without bundle name', '/private/delete_failed_version', () => ({ method: 'DELETE', body: { app_id: APPNAME } }), 400, 'error_bundle_name_missing'],
  // log_as
  ['log_as without auth', '/private/log_as', () => ({ auth: 'none', body: { user_id: randomUUID() } }), 401, 'no_jwt_apikey_or_subkey'],
  ['log_as with an API key and malformed body', '/private/log_as', () => ({ body: 'invalid json' }), 401, 'invalid_jwt'],
  ['log_as with an API key instead of a JWT', '/private/log_as', () => ({ body: { user_id: randomUUID() } }), 401, 'invalid_jwt'],
  ['log_as with an API key for an unknown user id', '/private/log_as', () => ({ body: { user_id: 'nonexistent-user-id' } }), 401, 'invalid_jwt'],
  // set_org_email
  ['set_org_email without auth', '/private/set_org_email', () => ({ auth: 'none', body: { org_id: testOrgId, email: 'test@example.com' } }), 401, 'no_jwt_apikey_or_subkey'],
  ['set_org_email invalid JSON body', '/private/set_org_email', () => ({ body: 'invalid json' }), 400, 'invalid_json_parse_body'],
  ['set_org_email for an org the scoped key cannot read', '/private/set_org_email', () => ({ auth: 'testOrg', body: { org_id: NON_OWNER_ORG_ID, email: 'test@example.com' } }), 400, 'org_not_found'],
  // accept_invitation
  ['accept_invitation with missing fields', '/private/accept_invitation', () => ({ body: {} }), 400, 'invalid_json_body'],
  ['accept_invitation for an unknown invitation', '/private/accept_invitation', () => ({ body: { password: 'ValidPassword123!!', magic_invite_string: 'nonexistent-invitation-id', opt_for_newsletters: false, captchaToken: 'test-captcha-token' } }), 404, 'failed_to_accept_invitation'],
  // invite_new_user_to_org: auth validation runs before org lookup or captcha verification
  ['invite_new_user_to_org with an API key before captcha validation', '/private/invite_new_user_to_org', () => ({ body: { org_id: testOrgId, email: 'existing@example.com', invite_type: 'org_member', captcha_token: 'test-captcha-token', first_name: 'Test', last_name: 'User' } }), 401, 'invalid_jwt'],
  ['invite_new_user_to_org with an API key for a nonexistent org', '/private/invite_new_user_to_org', () => ({ body: { org_id: randomUUID(), email: 'test@example.com', invite_type: 'org_member', captcha_token: 'test-captcha-token', first_name: 'Test', last_name: 'User' } }), 401, 'invalid_jwt'],
  // stats
  ['stats for an app the user cannot access', '/private/stats', () => ({ body: { appId: 'nonexistent.app' } }), 400, 'app_access_denied'],
  ['stats with a key lacking app access', '/private/stats', () => ({ auth: 'statsKey', body: { appId: APPNAME } }), 400, 'app_access_denied'],
  ['stats without auth', '/private/stats', () => ({ auth: 'none', body: { appId: APPNAME } }), 401, 'no_jwt_apikey_or_subkey'],
  ['stats with a valid API key', '/private/stats', () => ({ body: { appId: APPNAME } }), 200, null],
  // smoke checks for read-only private endpoints
  ['plans', '/private/plans', () => ({ method: 'GET' }), 200, null],
  ['public plan prices without auth', '/private/plan_prices/public', () => ({ method: 'GET', auth: 'none' }), 200, null],
  ['org plan prices without auth', `/private/plan_prices?orgId=${ORG_ID}`, () => ({ method: 'GET', auth: 'none' }), 401, 'no_jwt_apikey_or_subkey'],
  ['latency', '/private/latency', () => ({ method: 'GET' }), 200, null],
  ['config', '/private/config', () => ({ method: 'GET' }), 200, null],
]

describe('private endpoint error cases', () => {
  it.each(errorCases)('%s', async (_label, path, buildRequest, status, error) => {
    const response = await requestPrivate(path, buildRequest())
    const data = await response.json() as { error?: string }

    expect(response.status, JSON.stringify(data)).toBe(status)
    if (error)
      expect(data.error).toBe(error)
  })
})

describe('[POST] /private/set_org_email - customer requirement', () => {
  it('should return 400 when org does not have customer', async () => {
    // Temporarily remove customer_id from the org to test the error case
    await getSupabaseClient().from('orgs').update({ customer_id: null }).eq('id', testOrgId)

    const response = await fetch(getEndpointUrl('/private/set_org_email'), {
      method: 'POST',
      headers: testOrgHeaders,
      body: JSON.stringify({
        org_id: testOrgId,
        email: 'test@example.com',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_does_not_have_customer')

    // Restore customer_id for other tests
    await getSupabaseClient().from('orgs').update({ customer_id: testCustomerId }).eq('id', testOrgId)
  })
})
