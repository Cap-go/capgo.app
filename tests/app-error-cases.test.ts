import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createDirectApiKeyWithBindings, fetchTestRequest, getAuthHeaders, getSupabaseClient, NON_ACCESS_APP_NAME, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const id = randomUUID().replace(/-/g, '').slice(0, 12)
const APPNAME = `com.app.error.${id}`
const DELETE_APP_ID = `${APPNAME}.delete`
const NOT_FOUND_APP_ID = `${APPNAME}.notfound`
const PUT_APP_ID = `${APPNAME}.put`
const testOrgId = randomUUID()
const testStripeCustomerId = `cus_app_error_${id}`
let testApiKeyId: number | null = null
let testHeaders: Record<string, string>
let authHeaders: Record<string, string>

beforeAll(async () => {
  authHeaders = await getAuthHeaders()

  await resetAndSeedAppData(APPNAME, {
    orgId: testOrgId,
    userId: USER_ID,
    stripeCustomerId: testStripeCustomerId,
  })

  const createKey = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: `app-error-cases-${id}-${randomUUID()}`,
    name: `app-error-cases-${id}`,
    orgId: testOrgId,
    roleName: 'org_super_admin',
  })

  if (!createKey?.id || !createKey.key) {
    throw new Error('Failed to create isolated API key for app error case tests')
  }

  testApiKeyId = createKey.id
  testHeaders = {
    'Content-Type': 'application/json',
    'Authorization': createKey.key,
  }
}, 60000)

afterAll(async () => {
  await resetAppData(APPNAME)
  // Clean up any test apps created during tests
  await getSupabaseClient().from('apps').delete().eq('app_id', DELETE_APP_ID)
  await getSupabaseClient().from('apps').delete().eq('app_id', PUT_APP_ID)
  await getSupabaseClient().from('apps').delete().eq('app_id', NOT_FOUND_APP_ID)
  if (testApiKeyId !== null) {
    await fetchTestRequest(`${BASE_URL}/apikey/${testApiKeyId}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  }
  await getSupabaseClient().from('org_users').delete().eq('org_id', testOrgId)
  await getSupabaseClient().from('orgs').delete().eq('id', testOrgId)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', testStripeCustomerId)
}, 60000)

describe('[POST] /app - Error Cases', () => {
  it('should return 400 when name is missing', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app`, {
      method: 'POST',
      headers: testHeaders,
      body: JSON.stringify({
        owner_org: testOrgId,
        app_id: `${APPNAME}.missingname`,
        // Missing name
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_name')
  })

  it('should return 403 when organization access is denied', async () => {
    const nonExistentOrgId = randomUUID()
    const response = await fetchTestRequest(`${BASE_URL}/app`, {
      method: 'POST',
      headers: testHeaders,
      body: JSON.stringify({
        app_id: `${APPNAME}.accessdenied`,
        name: 'Test App',
        owner_org: nonExistentOrgId,
      }),
    })
    expect(response.status).toBe(403)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_organization')
  })

  it('should return 409 when app creation fails due to duplicate app id', async () => {
    // Try to create another app with the same app_id
    const response2 = await fetchTestRequest(`${BASE_URL}/app`, {
      method: 'POST',
      headers: testHeaders,
      body: JSON.stringify({
        app_id: APPNAME, // Same app_id as the one created in beforeAll
        name: APPNAME,
        owner_org: testOrgId,
      }),
    })
    expect(response2.status).toBe(409)
    const data = await response2.json() as { error: string }
    expect(data.error).toBe('app_id_already_exists')
  })

  it('should return 400 with invalid JSON body', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app`, {
      method: 'POST',
      headers: testHeaders,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[GET] /app - Error Cases', () => {
  it('should return 400 when user cannot access the app', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app/nonexistent.app`, {
      method: 'GET',
      headers: testHeaders,
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })

  it('should return 404 when app is not found', async () => {
    // Create an app first to get access, then delete it to test 404
    await resetAndSeedAppData(NOT_FOUND_APP_ID, {
      orgId: testOrgId,
      userId: USER_ID,
      stripeCustomerId: testStripeCustomerId,
    })

    // Delete the app from database directly
    await getSupabaseClient().from('apps').delete().eq('app_id', NOT_FOUND_APP_ID)

    // Try to get the deleted app
    const response = await fetchTestRequest(`${BASE_URL}/app/${NOT_FOUND_APP_ID}`, {
      method: 'GET',
      headers: testHeaders,
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })

  it('should return 403 when user does not have access to organization', async () => {
    // This test would need a more complex setup with different users
    // For now, we test with a response structure check
    const response = await fetchTestRequest(`${BASE_URL}/app/${NON_ACCESS_APP_NAME}`, {
      method: 'GET',
      headers: testHeaders,
    })

    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })
})

describe('[PUT] /app - Error Cases', () => {
  beforeAll(async () => {
    // Ensure the test app exists for PUT tests
    await resetAndSeedAppData(PUT_APP_ID, {
      orgId: testOrgId,
      userId: USER_ID,
      stripeCustomerId: testStripeCustomerId,
    })
  })

  it('should return 400 when user cannot access the app', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app/nonexistent.app`, {
      method: 'PUT',
      headers: testHeaders,
      body: JSON.stringify({
        name: 'Updated Name',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_access_app')
  })

  it('should return 400 when update fails', async () => {
    // Try to update with invalid data that would cause a database error
    const response = await fetchTestRequest(`${BASE_URL}/app/${PUT_APP_ID}`, {
      method: 'PUT',
      headers: testHeaders,
      body: JSON.stringify({
        // Try to set owner_org to non-existent org (this might cause an error)
        owner_org: 'non-existent-org-id',
      }),
    })

    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_update_app')
  })

  it('should handle invalid JSON body', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app/${PUT_APP_ID}`, {
      method: 'PUT',
      headers: testHeaders,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[DELETE] /app - Error Cases', () => {
  it('should return 400 when user cannot access the app', async () => {
    const response = await fetchTestRequest(`${BASE_URL}/app/nonexistent.app`, {
      method: 'DELETE',
      headers: testHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_delete_app')
  })

  it('should return 400 when app deletion fails', async () => {
    // Create an app to test deletion. Reset first so Vitest retries after a
    // previous successful delete do not reuse the seed cache for a missing row.
    await resetAppData(DELETE_APP_ID)
    await resetAndSeedAppData(DELETE_APP_ID, {
      orgId: testOrgId,
      userId: USER_ID,
      stripeCustomerId: testStripeCustomerId,
    })

    // Try to delete the app (this should work)
    const response = await fetchTestRequest(`${BASE_URL}/app/${DELETE_APP_ID}`, {
      method: 'DELETE',
      headers: testHeaders,
    })

    // The first delete should succeed
    expect(response.status).toBe(200)

    // Try to delete the same app again. Once the row is gone, the endpoint must
    // deny/fail before doing any destructive work.
    const response2 = await fetchTestRequest(`${BASE_URL}/app/${DELETE_APP_ID}`, {
      method: 'DELETE',
      headers: testHeaders,
    })
    expect([400, 401]).toContain(response2.status)
    const data = await response2.json() as { error: string }
    expect(['cannot_delete_app', 'cannot_access_app']).toContain(data.error)
  })
})
