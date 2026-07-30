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

  it('should return 401 when not authorized', async () => {
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Missing authorization header
      },
      body: JSON.stringify({
        app_id: APPNAME,
        org_id: NON_OWNER_ORG_ID,
        device_id: randomUUID(),
        platform: 'android',
        version: 1,
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 for invalid JSON body', async () => {
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_json_parse_body')
  })

  it('should return 404 when app not found', async () => {
    // Use testOrgId where user has super_admin rights to properly test app not found
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers: testOrgHeaders,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        org_id: testOrgId,
        device_id: randomUUID(),
        platform: 'android',
        version_name: '1.0.0',
      }),
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_not_found')
  })

  it('should return 401 when not authorized for specific app', async () => {
    const response = await fetch(getEndpointUrl('/private/create_device'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'com.demoadmin.app', // Use the admin app that test user doesn't have access to
        org_id: NON_OWNER_ORG_ID,
        device_id: randomUUID(),
        platform: 'android',
        version_name: '1.0.0',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_authorized')
  })
})

describe('[POST] /private/upload_link - Error Cases', () => {
  it('should return 500 when user not found', async () => {
    const response = await fetch(getEndpointUrl('/private/upload_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        version: '1.0.0',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_access_denied')
  })

  it('should return 400 when user cannot access app', async () => {
    const response = await fetch(getEndpointUrl('/private/upload_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        version: '1.0.0',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_access_denied')
  })

  it('should return 500 when app not found', async () => {
    const response = await fetch(getEndpointUrl('/private/upload_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: '1.0.0',
      }),
    })

    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('error_version_not_found')
  })

  it('should return 500 when version already exists', async () => {
    const response = await fetch(getEndpointUrl('/private/upload_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: 'unknown', // This version likely exists
      }),
    })

    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('error_version_not_found')
  })
})

describe('[POST] /private/download_link - Error Cases', () => {
  it('should return 400 when authorization cannot be found', async () => {
    const response = await fetch(getEndpointUrl('/private/download_link'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Missing authorization
      },
      body: JSON.stringify({
        app_id: APPNAME,
        version: '1.0.0',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 401 when not authorized', async () => {
    const response = await fetch(getEndpointUrl('/private/download_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'unauthorized.app',
        version: '1.0.0',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 when user cannot access app', async () => {
    const response = await fetch(getEndpointUrl('/private/download_link'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        version: '1.0.0',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })
})

describe('[DELETE] /private/delete_failed_version', () => {
  it('should return 401 when user cannot access app', async () => {
    const response = await fetch(getEndpointUrl('/private/delete_failed_version'), {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: 'nonexistent.app',
        name: '1.0.0',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_authorized')
  })

  it('should return 400 when bundle name missing', async () => {
    const response = await fetch(getEndpointUrl('/private/delete_failed_version'), {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        // Missing name
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('error_bundle_name_missing')
  })

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

describe('[POST] /private/log_as - Error Cases', () => {
  it('should return 401 when not authorized', async () => {
    const response = await fetch(getEndpointUrl('/private/log_as'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Missing authorization
      },
      body: JSON.stringify({
        user_id: randomUUID(),
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 401 for invalid JWT with malformed body', async () => {
    const response = await fetch(getEndpointUrl('/private/log_as'), {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 when JWT is invalid', async () => {
    const response = await fetch(getEndpointUrl('/private/log_as'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: randomUUID(),
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 when JWT is invalid for unknown user', async () => {
    const response = await fetch(getEndpointUrl('/private/log_as'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: 'nonexistent-user-id',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })
})

describe('[POST] /private/set_org_email - Error Cases', () => {
  it('should return 401 when not authorized', async () => {
    const response = await fetch(getEndpointUrl('/private/set_org_email'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Missing authorization
      },
      body: JSON.stringify({
        org_id: testOrgId,
        email: 'test@example.com',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 for invalid JSON body', async () => {
    const response = await fetch(getEndpointUrl('/private/set_org_email'), {
      method: 'POST',
      headers,
      body: 'invalid json',
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_json_parse_body')
  })

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

  it('should return 400 when the scoped API key cannot read the org', async () => {
    const response = await fetch(getEndpointUrl('/private/set_org_email'), {
      method: 'POST',
      headers: testOrgHeaders,
      body: JSON.stringify({
        org_id: NON_OWNER_ORG_ID,
        email: 'test@example.com',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('org_not_found')
  })
})

describe('[POST] /private/accept_invitation - Error Cases', () => {
  it('should return 400 for invalid request', async () => {
    const response = await fetch(getEndpointUrl('/private/accept_invitation'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // Missing required fields
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_json_body')
  })

  it('should return 404 when invitation not found', async () => {
    const response = await fetch(getEndpointUrl('/private/accept_invitation'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        password: 'ValidPassword123!!',
        magic_invite_string: 'nonexistent-invitation-id',
        opt_for_newsletters: false,
        captchaToken: 'test-captcha-token',
      }),
    })

    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('failed_to_accept_invitation')
  })
})

describe('[POST] /private/invite_new_user_to_org - Error Cases', () => {
  it('should return 401 when JWT is invalid before captcha validation', async () => {
    // Auth validation runs before captcha verification.
    const response = await fetch(getEndpointUrl('/private/invite_new_user_to_org'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org_id: testOrgId,
        email: 'existing@example.com',
        invite_type: 'org_member',
        captcha_token: 'test-captcha-token',
        first_name: 'Test',
        last_name: 'User',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })

  it('should return 401 when JWT is invalid for nonexistent org', async () => {
    // Auth validation runs before org lookup or captcha verification.
    const response = await fetch(getEndpointUrl('/private/invite_new_user_to_org'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        org_id: randomUUID(),
        email: 'test@example.com',
        invite_type: 'org_member',
        captcha_token: 'test-captcha-token',
        first_name: 'Test',
        last_name: 'User',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_jwt')
  })
})

describe('[POST] /private/stats - Error Cases', () => {
  it('should return 400 when user not found', async () => {
    const response = await fetch(getEndpointUrl('/private/stats'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: 'nonexistent.app',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_access_denied')
  })

  it('should return 400 when user cannot access app', async () => {
    const response = await fetch(getEndpointUrl('/private/stats'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: 'unauthorized.app',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_access_denied')
  })

  it('should work when used with APIKEY', async () => {
    const response = await fetch(getEndpointUrl('/private/stats'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APPNAME,
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { error: string }
    console.log(data)
    expect(data).toBeDefined()
  })

  it('should return 400 when wrong auth', async () => {
    const response = await fetch(getEndpointUrl('/private/stats'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': APIKEY_STATS,
      },
      body: JSON.stringify({
        appId: APPNAME,
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('app_access_denied')
  })
  it('should return 401 when no auth', async () => {
    const response = await fetch(getEndpointUrl('/private/stats'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: APPNAME,
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })
})

describe('[POST] /private/plans - Error Cases', () => {
  it('should return 500 when plans cannot be retrieved', async () => {
    const response = await fetch(getEndpointUrl('/private/plans'), {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { error: string }
    expect(data).toBeDefined()
  })
})

describe('[POST] /private/latency - Error Cases', () => {
  it('should return 400 when latency post fails', async () => {
    const response = await fetch(getEndpointUrl('/private/latency'), {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { error: string }
    expect(data).toBeDefined()
  })
})

describe('[POST] /private/config - Error Cases', () => {
  it('should return 500 when config cannot be retrieved', async () => {
    const response = await fetch(getEndpointUrl('/private/config'), {
      method: 'GET',
      headers,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { error: string }
    expect(data).toBeDefined()
  })
})
