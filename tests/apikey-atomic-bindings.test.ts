import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { executeSQL, getAuthHeaders, getEndpointUrl, getSupabaseClient, USER_ID } from './test-utils.ts'

const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

let authHeaders: Record<string, string>

// Dedicated seed data for this test file (isolated from other parallel test files)
const TEST_ID = randomUUID()
const TEST_ORG_ID = randomUUID()
const TEST_ORG_NAME = `Atomic Bindings Test Org ${TEST_ID.slice(0, 8)}`
const TEST_ORG_EMAIL = `atomic-bindings-${TEST_ID.slice(0, 8)}@capgo.app`
const STRIPE_CUSTOMER_ID = `cus_atomic_bindings_${TEST_ID.slice(0, 8)}`

const createdKeyIds: number[] = []

async function setupTestOrg() {
  const supabase = getSupabaseClient()

  // Create a dedicated org with RBAC enabled
  const { error: orgError } = await supabase.from('orgs').insert({
    id: TEST_ORG_ID,
    created_by: USER_ID,
    name: TEST_ORG_NAME,
    management_email: TEST_ORG_EMAIL,
  })
  if (orgError)
    throw orgError

  // The org needs a stripe_info entry for the apikey creation path
  const { error: stripeError } = await supabase.from('stripe_info').insert({
    customer_id: STRIPE_CUSTOMER_ID,
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: null,
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgToStripeError } = await supabase.from('orgs').update({
    customer_id: STRIPE_CUSTOMER_ID,
  }).eq('id', TEST_ORG_ID)
  if (orgToStripeError)
    throw orgToStripeError

  // Add the test user as super_admin in the org so the RBAC checks can create keys there.
  const { error: ouError } = await supabase.from('org_users').insert({
    org_id: TEST_ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin',
  })
  if (ouError)
    throw ouError
}

async function cleanupTestData() {
  const supabase = getSupabaseClient()
  // Delete created API keys
  for (const keyId of createdKeyIds) {
    await supabase.from('apikeys').delete().eq('id', keyId)
  }
  // Delete role bindings for the test org
  await supabase.from('role_bindings').delete().eq('org_id', TEST_ORG_ID)
  // Delete org membership
  await supabase.from('org_users').delete().eq('org_id', TEST_ORG_ID)
  // Delete org
  await supabase.from('orgs').delete().eq('id', TEST_ORG_ID)
  // Delete stripe info
  await supabase.from('stripe_info').delete().eq('customer_id', STRIPE_CUSTOMER_ID)
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
  await setupTestOrg()
})

afterAll(async () => {
  await cleanupTestData()
})

// Atomic API key + bindings tests use /private/ route which is Supabase-only
describe.skipIf(USE_CLOUDFLARE)('[POST] /apikey with atomic bindings', () => {
  it('creates an API key with bindings', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `atomic-bindings-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
            reason: 'atomic creation test',
          },
        ],
      }),
    })

    const data = await response.json() as { id: number, key: string | null, rbac_id: string }
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('id')
    expect(data.rbac_id).toBeTruthy()
    createdKeyIds.push(data.id)

    // Verify the binding was created in the database
    const supabase = getSupabaseClient()
    const { data: bindings, error: bindingsError } = await supabase
      .from('role_bindings')
      .select('*')
      .eq('principal_type', 'apikey')
      .eq('principal_id', data.rbac_id)
      .eq('org_id', TEST_ORG_ID)

    expect(bindingsError).toBeNull()
    expect(bindings).toHaveLength(1)
    expect(bindings![0].scope_type).toBe('org')
    expect(bindings![0].reason).toBe('atomic creation test')
  })

  it.concurrent('creates an org.create API key permission for org admin keys', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `org-create-permission-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
        global_permissions: ['org.create'],
      }),
    })

    const data = await response.json() as { id: number, rbac_id: string, global_permissions: string[] }
    expect(response.status).toBe(200)
    expect(data.global_permissions).toContain('org.create')
    createdKeyIds.push(data.id)

    const permissionRows = await executeSQL(
      `SELECT permission_key
       FROM public.apikey_global_permissions
       WHERE apikey_rbac_id = $1::uuid`,
      [data.rbac_id],
    )
    expect(permissionRows).toEqual([{ permission_key: 'org.create' }])
  })

  it.concurrent('rejects org.create API key permission without an org admin binding', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `invalid-org-create-permission-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
        global_permissions: ['org.create'],
      }),
    })

    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_global_permissions')
  })

  it.concurrent('updates org.create API key permission from the API key editor payload', async () => {
    const createResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `update-org-create-permission-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })

    const createData = await createResponse.json() as { id: number, rbac_id: string }
    expect(createResponse.status).toBe(200)
    createdKeyIds.push(createData.id)

    const grantResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        id: createData.id,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
        global_permissions: ['org.create'],
      }),
    })

    const grantData = await grantResponse.json() as { global_permissions: string[] }
    expect(grantResponse.status).toBe(200)
    expect(grantData.global_permissions).toContain('org.create')

    const revokeResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        id: createData.id,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
        global_permissions: [],
      }),
    })

    const revokeData = await revokeResponse.json() as { global_permissions: string[] }
    expect(revokeResponse.status).toBe(200)
    expect(revokeData.global_permissions).toEqual([])

    const permissionRows = await executeSQL(
      `SELECT permission_key
       FROM public.apikey_global_permissions
       WHERE apikey_rbac_id = $1::uuid`,
      [createData.rbac_id],
    )
    expect(permissionRows).toEqual([])

    const regrantResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        id: createData.id,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
        global_permissions: ['org.create'],
      }),
    })
    expect(regrantResponse.status).toBe(200)

    const downgradeResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        id: createData.id,
        bindings: [
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })
    expect(downgradeResponse.status).toBe(200)

    const downgradedPermissionRows = await executeSQL(
      `SELECT permission_key
       FROM public.apikey_global_permissions
       WHERE apikey_rbac_id = $1::uuid`,
      [createData.rbac_id],
    )
    expect(downgradedPermissionRows).toEqual([])
  })

  it('requires explicit RBAC bindings', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `missing-bindings-key-${TEST_ID.slice(0, 8)}`,
      }),
    })

    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('bindings_required')
  })

  it('rolls back the API key when a binding fails', async () => {
    const uniqueKeyName = `rollback-test-key-${TEST_ID.slice(0, 8)}-${Date.now()}`

    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: uniqueKeyName,
        bindings: [
          {
            role_name: 'nonexistent_role_that_should_fail',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })

    expect(response.status).not.toBe(200)

    // Verify the specific key was rolled back (not present in DB)
    const supabase = getSupabaseClient()
    const { data: matchingKeys } = await supabase
      .from('apikeys')
      .select('id')
      .eq('user_id', USER_ID)
      .eq('name', uniqueKeyName)

    expect(matchingKeys).toHaveLength(0)
  })

  it('creates multiple bindings in a single call', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `multi-binding-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
            reason: 'multi-binding test 1',
          },
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
            reason: 'multi-binding test 2',
          },
        ],
      }),
    })

    // This may fail with a duplicate constraint if org_member can only be assigned once per scope.
    // In that case, the key should be rolled back.
    if (response.status === 200) {
      const data = await response.json() as { id: number, rbac_id: string }
      createdKeyIds.push(data.id)

      const supabase = getSupabaseClient()
      const { data: bindings } = await supabase
        .from('role_bindings')
        .select('*')
        .eq('principal_type', 'apikey')
        .eq('principal_id', data.rbac_id)
        .eq('org_id', TEST_ORG_ID)

      expect(bindings!.length).toBeGreaterThanOrEqual(2)
    }
    else {
      // Duplicate binding caused rollback - that's also valid behavior
      const data = await response.json() as { error: string }
      expect(data).toHaveProperty('error')
    }
  })

  it('validates binding shape before creation', async () => {
    const response = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `invalid-binding-shape-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            // missing role_name
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })

    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_bindings')
  })

  it('v2 key can authenticate', async () => {
    // First create a V2 key with role bindings.
    const createResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `rbac-auth-test-key-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_member',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })

    expect(createResponse.status).toBe(200)
    const createData = await createResponse.json() as { id: number, key: string }
    expect(createData.key).toBeTruthy()
    createdKeyIds.push(createData.id)

    // Use the RBAC-only key to authenticate. The request should reach the
    // API-key guard and be rejected as scoped, not as an invalid credential.
    const apiKeyHeaders = {
      'Content-Type': 'application/json',
      'Authorization': createData.key,
    }
    const getResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'GET',
      headers: apiKeyHeaders,
    })

    const getBody = await getResponse.json() as { error?: string }

    expect(getResponse.status, `Auth failed with body: ${JSON.stringify(getBody)}`).toBe(401)
    expect(getBody.error).toBe('cannot_list_apikeys')
  })
})

// Role bindings endpoint now supports API key auth
describe.skipIf(USE_CLOUDFLARE)('[GET] /private/role_bindings with API key auth', () => {
  it('accepts JWT auth on role_bindings endpoint', async () => {
    const response = await fetch(getEndpointUrl(`/private/role_bindings/${TEST_ORG_ID}`), {
      method: 'GET',
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as any[]
    expect(Array.isArray(data)).toBe(true)
  })

  it('rejects API key auth on role_bindings endpoint', async () => {
    // Create an API key first
    const createResponse = await fetch(getEndpointUrl('/apikey'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `role-binding-auth-test-${TEST_ID.slice(0, 8)}`,
        bindings: [
          {
            role_name: 'org_admin',
            scope_type: 'org',
            org_id: TEST_ORG_ID,
          },
        ],
      }),
    })

    expect(createResponse.status).toBe(200)
    const createData = await createResponse.json() as { id: number, key: string }
    createdKeyIds.push(createData.id)

    // Try using this API key on role_bindings endpoint
    const response = await fetch(getEndpointUrl(`/private/role_bindings/${TEST_ORG_ID}`), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': createData.key,
      },
    })

    expect(response.status).toBe(403)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('API keys cannot manage role bindings')
  })
})
