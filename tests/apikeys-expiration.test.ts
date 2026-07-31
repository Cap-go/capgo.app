import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appApiKeyBindings, BASE_URL, createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, getAuthHeadersForCredentials, getSupabaseClient, normalizeLocalhostUrl, orgApiKeyBindings, resetAndSeedAppData, resetAppData, TEST_EMAIL, USER_EMAIL_APIKEY_EXPIRATION, USER_ID_APIKEY_EXPIRATION, USER_PASSWORD } from './test-utils.ts'

const id = randomUUID()
const BASE_ORG_ID = randomUUID()
const BASE_ORG_CUSTOMER_ID = `cus_test_expiration_base_${id}`
const POLICY_APPNAME = `com.app.expiration.policy.${id}`

// Orgs for testing expiration policies
const BASE_ORG_NAME = `Test Expiration Base Org ${id}`
const POLICY_ORG_ID = randomUUID()
const POLICY_ORG_CUSTOMER_ID = `cus_test_policy_${id}`
const POLICY_ORG_NAME = `Test Policy Org ${id}`
let authHeaders: Record<string, string>
let policyAppUuid: string

function keyName(name: string): string {
  return `${name}-${id}`
}

function orgKeyBody(name: string, orgId = BASE_ORG_ID, extra: Record<string, unknown> = {}) {
  return {
    name: keyName(name),
    bindings: orgApiKeyBindings(orgId),
    ...extra,
  }
}

async function appKeyBody(name: string, appId = POLICY_APPNAME, extra: Record<string, unknown> = {}) {
  return {
    name: keyName(name),
    bindings: await appApiKeyBindings(appId),
    ...extra,
  }
}

async function seedPlainApiKey(name: string, expiresAt: string | null, orgId = BASE_ORG_ID) {
  const key = randomUUID()
  const data = await createDirectApiKeyWithBindings({
    userId: USER_ID_APIKEY_EXPIRATION,
    key,
    name: keyName(name),
    orgId,
    roleName: 'org_admin',
    expiresAt,
  })

  if (!data.key)
    throw new Error(`Failed to seed API key ${name}`)

  const supabase = getSupabaseClient()
  const { data: memberships, error: membershipsError } = await supabase
    .from('org_users')
    .select('org_id')
    .eq('user_id', USER_ID_APIKEY_EXPIRATION)

  if (membershipsError)
    throw membershipsError

  const extraOrgIds = [...new Set((memberships ?? []).map(row => row.org_id).filter((membershipOrgId): membershipOrgId is string => !!membershipOrgId && membershipOrgId !== orgId))]
  if (extraOrgIds.length > 0) {
    const { data: orgPolicies, error: orgPoliciesError } = await supabase
      .from('orgs')
      .select('id, require_apikey_expiration, max_apikey_expiration_days')
      .in('id', extraOrgIds)

    if (orgPoliciesError)
      throw orgPoliciesError

    const expiresAtTime = expiresAt ? new Date(expiresAt).getTime() : null
    const compatibleExtraOrgIds = (orgPolicies ?? [])
      .filter((org) => {
        if (org.require_apikey_expiration && expiresAt === null)
          return false
        if (org.max_apikey_expiration_days !== null && expiresAtTime !== null) {
          return expiresAtTime <= Date.now() + org.max_apikey_expiration_days * 24 * 60 * 60 * 1000
        }
        return true
      })
      .map(org => org.id)

    if (compatibleExtraOrgIds.length === 0)
      return { id: data.id, key: data.key, expires_at: data.expires_at }

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'org_admin')
      .single()

    if (roleError || !role)
      throw roleError ?? new Error('Unable to resolve org_admin role')

    const { error: bindingError } = await supabase.from('role_bindings').insert(compatibleExtraOrgIds.map(extraOrgId => ({
      principal_type: 'apikey' as const,
      principal_id: data.rbac_id,
      role_id: role.id,
      scope_type: 'org' as const,
      org_id: extraOrgId,
      granted_by: USER_ID_APIKEY_EXPIRATION,
      reason: 'Expiration test full-org key binding',
      is_direct: true,
    })))

    if (bindingError)
      throw bindingError
  }

  return { id: data.id, key: data.key, expires_at: data.expires_at }
}

async function deleteSeededApiKeys(ids: number[]) {
  if (ids.length === 0)
    return

  await getSupabaseClient()
    .from('apikeys')
    .delete()
    .in('id', ids)
}

function apiFetch(path: string, init?: RequestInit) {
  return fetchTestRequest(`${BASE_URL}${path}`, init)
}

function createAuthenticatedSupabaseClient(headers: Record<string, string>) {
  const supabaseUrl = normalizeLocalhostUrl(env.SUPABASE_URL)
  const supabaseAnonKey = env.SUPABASE_ANON_KEY
  const authorization = headers.Authorization ?? headers.authorization

  if (!supabaseUrl || !supabaseAnonKey || !authorization) {
    throw new Error('Missing Supabase auth environment for authenticated client')
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: authorization,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

function createApiKeySupabaseClient(apikey: string) {
  const supabaseUrl = normalizeLocalhostUrl(env.SUPABASE_URL)
  const supabaseAnonKey = env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Missing Supabase auth environment for API key client')
  }

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        capgkey: apikey,
      },
    },
    auth: {
      persistSession: false,
    },
  })
}

async function expectApiKeyCanReadBaseOrg(apikey: string) {
  const supabase = createApiKeySupabaseClient(apikey)
  const { data, error } = await supabase
    .from('orgs')
    .select('id')
    .eq('id', BASE_ORG_ID)
    .single()

  expect(error).toBeNull()
  expect(data?.id).toBe(BASE_ORG_ID)
}

async function expectApiKeyCannotReadBaseOrg(apikey: string) {
  const supabase = createApiKeySupabaseClient(apikey)
  const { data, error } = await supabase
    .from('orgs')
    .select('id')
    .eq('id', BASE_ORG_ID)

  expect(error).toBeNull()
  expect(data).toEqual([])
}

beforeAll(async () => {
  authHeaders = await getAuthHeadersForCredentials(USER_EMAIL_APIKEY_EXPIRATION, USER_PASSWORD)

  const { error: baseStripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: BASE_ORG_CUSTOMER_ID,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_base_${id}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (baseStripeError)
    throw baseStripeError

  const { error: baseOrgError } = await getSupabaseClient().from('orgs').insert({
    id: BASE_ORG_ID,
    name: BASE_ORG_NAME,
    management_email: TEST_EMAIL,
    created_by: USER_ID_APIKEY_EXPIRATION,
    customer_id: BASE_ORG_CUSTOMER_ID,
  })
  if (baseOrgError)
    throw baseOrgError

  const { error: baseMemberError } = await getSupabaseClient().from('org_users').insert({
    org_id: BASE_ORG_ID,
    user_id: USER_ID_APIKEY_EXPIRATION,
    rbac_role_name: 'org_super_admin',
  })
  if (baseMemberError)
    throw baseMemberError

  // Create a test org with specific expiration policies
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: POLICY_ORG_CUSTOMER_ID,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${id}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: POLICY_ORG_ID,
    name: POLICY_ORG_NAME,
    management_email: TEST_EMAIL,
    created_by: USER_ID_APIKEY_EXPIRATION,
    customer_id: POLICY_ORG_CUSTOMER_ID,
    require_apikey_expiration: true,
    max_apikey_expiration_days: 30,
  })
  if (orgError)
    throw orgError

  const { error: policyMemberError } = await getSupabaseClient().from('org_users').insert({
    org_id: POLICY_ORG_ID,
    user_id: USER_ID_APIKEY_EXPIRATION,
    rbac_role_name: 'org_super_admin',
  })
  if (policyMemberError)
    throw policyMemberError

  await resetAndSeedAppData(POLICY_APPNAME, {
    orgId: POLICY_ORG_ID,
    stripeCustomerId: POLICY_ORG_CUSTOMER_ID,
    userId: USER_ID_APIKEY_EXPIRATION,
  })

  const { data: policyApp, error: policyAppError } = await getSupabaseClient()
    .from('apps')
    .select('id')
    .eq('app_id', POLICY_APPNAME)
    .single()

  if (policyAppError || !policyApp?.id)
    throw policyAppError ?? new Error('Missing policy app')

  policyAppUuid = policyApp.id
})

afterAll(async () => {
  await resetAppData(POLICY_APPNAME)
  await getSupabaseClient().from('org_users').delete().eq('org_id', POLICY_ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', POLICY_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', POLICY_ORG_CUSTOMER_ID)
  await getSupabaseClient().from('org_users').delete().eq('org_id', BASE_ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', BASE_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', BASE_ORG_CUSTOMER_ID)
})

describe('[POST] /apikey with expiration', () => {
  it('create api key with valid expiration date', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days from now
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-with-expiration', BASE_ORG_ID, { expires_at: futureDate })),
    })
    const data = await response.json<{ key: string, id: number, expires_at: string }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data).toHaveProperty('id')
    expect(data).toHaveProperty('expires_at')
    expect(new Date(data.expires_at).getTime()).toBeCloseTo(new Date(futureDate).getTime(), -3)
  })

  it('create api key without expiration (null)', async () => {
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-no-expiration')),
    })
    const data = await response.json<{ key: string, id: number, expires_at: string | null }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data.expires_at).toBeNull()
  })

  it('fail to create api key with past expiration date', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // 1 day ago
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-past-expiration', BASE_ORG_ID, { expires_at: pastDate })),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_expiration_date')
  })

  it('fail to create api key with invalid expiration date format', async () => {
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-invalid-date', BASE_ORG_ID, { expires_at: 'not-a-date' })),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_expiration_date')
  })
})

describe('[PUT] /apikey/:id with expiration', () => {
  let testKeyId: number

  beforeAll(async () => {
    // Create a key to update
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-for-update-expiration')),
    })
    expect(response.status).toBe(200)
    const data = await response.json<{ id: number }>()
    testKeyId = data.id
  })

  it('update api key to add expiration date', async () => {
    const futureDate = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() // 14 days from now
    const response = await apiFetch(`/apikey/${testKeyId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expires_at: futureDate,
      }),
    })
    const data = await response.json<{ id: number, expires_at: string }>()
    expect(response.status).toBe(200)
    expect(data.id).toBe(testKeyId)
    expect(new Date(data.expires_at).getTime()).toBeCloseTo(new Date(futureDate).getTime(), -3)
  })

  it('update api key to change expiration date', async () => {
    const newFutureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
    const response = await apiFetch(`/apikey/${testKeyId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expires_at: newFutureDate,
      }),
    })
    const data = await response.json<{ id: number, expires_at: string }>()
    expect(response.status).toBe(200)
    expect(new Date(data.expires_at).getTime()).toBeCloseTo(new Date(newFutureDate).getTime(), -3)
  })

  it('update api key to remove expiration (set to null)', async () => {
    const response = await apiFetch(`/apikey/${testKeyId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expires_at: null,
      }),
    })
    const data = await response.json<{ id: number, expires_at: string | null }>()
    expect(response.status).toBe(200)
    expect(data.expires_at).toBeNull()
  })

  it('fail to update api key with past expiration date', async () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const response = await apiFetch(`/apikey/${testKeyId}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        expires_at: pastDate,
      }),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_expiration_date')
  })
})

describe('[GET] /apikey with expiration info', () => {
  let keyWithExpiration: { id: number, key: string }
  let keyWithoutExpiration: { id: number, key: string }

  beforeAll(async () => {
    // Create key with expiration
    const response1 = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-with-exp-get-test', BASE_ORG_ID, { expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() })),
    })
    expect(response1.status).toBe(200)
    keyWithExpiration = await response1.json()

    // Create key without expiration
    const response2 = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-without-exp-get-test')),
    })
    expect(response2.status).toBe(200)
    keyWithoutExpiration = await response2.json()
  })

  it('get api key includes expires_at field when set', async () => {
    const response = await apiFetch(`/apikey/${keyWithExpiration.id}`, {
      method: 'GET',
      headers: authHeaders,
    })
    const data = await response.json<{ id: number, expires_at: string | null }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('expires_at')
    expect(data.expires_at).not.toBeNull()
  })

  it('get api key includes expires_at as null when not set', async () => {
    const response = await apiFetch(`/apikey/${keyWithoutExpiration.id}`, {
      method: 'GET',
      headers: authHeaders,
    })
    const data = await response.json<{ id: number, expires_at: string | null }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('expires_at')
    expect(data.expires_at).toBeNull()
  })

  it('list all api keys includes expires_at field', async () => {
    const response = await apiFetch('/apikey', {
      method: 'GET',
      headers: authHeaders,
    })
    const data = await response.json() as Array<{ id: number, expires_at: string | null }>
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)

    // Find our test keys
    const withExp = data.find(k => k.id === keyWithExpiration.id)
    const withoutExp = data.find(k => k.id === keyWithoutExpiration.id)

    expect(withExp).toBeDefined()
    expect(withExp?.expires_at).not.toBeNull()

    expect(withoutExp).toBeDefined()
    expect(withoutExp?.expires_at).toBeNull()
  })
})

describe('organization API key expiration policy', () => {
  it('fail to create api key without expiration for org requiring expiration', async () => {
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-policy-test', POLICY_ORG_ID)),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('expiration_required')
  })

  it('fail to create api key with expiration exceeding org max days', async () => {
    // Org has max 30 days, try to create with 60 days
    const tooFarDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-policy-exceeds-max', POLICY_ORG_ID, { expires_at: tooFarDate })),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('expiration_exceeds_max')
  })

  it('create api key with valid expiration for org with policy', async () => {
    // Org has max 30 days, create with 15 days
    const validDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-policy-valid', POLICY_ORG_ID, { expires_at: validDate })),
    })
    const data = await response.json<{ key: string, id: number, expires_at: string }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data.expires_at).not.toBeNull()
  })

  it('create api key without expiration for org without policy', async () => {
    // Use this suite's dedicated org which does not enforce expiration policy
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-no-policy-org')),
    })
    const data = await response.json<{ key: string, id: number, expires_at: string | null }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    // Should succeed even without expiration since org doesn't require it
  })

  it('fail to create app-scoped api key without expiration for org requiring expiration', async () => {
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: keyName('key-policy-app-scope'),
        bindings: [{
          role_name: 'app_admin',
          scope_type: 'app',
          org_id: POLICY_ORG_ID,
          app_id: policyAppUuid,
        }],
      }),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('expiration_required')
  })

  it('fail to create app-scoped api key with expiration exceeding org max days', async () => {
    const tooFarDate = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString()
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(await appKeyBody('key-policy-app-scope-too-far', POLICY_APPNAME, { expires_at: tooFarDate })),
    })
    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('expiration_exceeds_max')
  })

  it('fail to create app-scoped api key for unknown app ids', async () => {
    const response = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: keyName('key-policy-app-scope-missing-app'),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        bindings: [{
          role_name: 'app_admin',
          scope_type: 'app',
          org_id: POLICY_ORG_ID,
          app_id: randomUUID(),
        }],
      }),
    })
    const data = await response.json() as { error: string }

    expect(response.status).toBe(404)
    expect(data.error).toBe('binding_failed')
  })

  it('reject unsupported api key scope updates', async () => {
    const createResponse = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-policy-app-scope-update')),
    })
    expect(createResponse.status).toBe(200)
    const createdKey = await createResponse.json<{ id: number }>()

    const updateResponse = await apiFetch(`/apikey/${createdKey.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        unsupported_app_scope: [POLICY_APPNAME],
      }),
    })
    const data = await updateResponse.json() as { error: string }

    expect(updateResponse.status).toBe(400)
    expect(data.error).toContain('no_valid_fields_provided_for_update')
  })

  it('reject app-scoped api keys from updating sibling keys', async () => {
    const validDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()
    const limitedKeyResponse = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(await appKeyBody('key-policy-app-updater', POLICY_APPNAME, { expires_at: validDate })),
    })
    expect(limitedKeyResponse.status).toBe(200)
    const limitedKey = await limitedKeyResponse.json<{ key: string }>()

    const siblingKeyResponse = await apiFetch('/apikey', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-policy-sibling-target')),
    })
    expect(siblingKeyResponse.status).toBe(200)
    const siblingKey = await siblingKeyResponse.json<{ id: number }>()

    const limitedAuthHeaders = {
      'Content-Type': 'application/json',
      'Authorization': limitedKey.key,
    }
    const updateResponse = await apiFetch(`/apikey/${siblingKey.id}`, {
      method: 'PUT',
      headers: limitedAuthHeaders,
      body: JSON.stringify({
        name: keyName('key-policy-escalation-attempt'),
      }),
    })
    const data = await updateResponse.json() as { error: string }

    expect(updateResponse.status).toBe(401)
    expect(data.error).toBe('cannot_update_apikey')
  })

  it('reject direct apikey inserts that bypass the server creation path', async () => {
    const supabase = createAuthenticatedSupabaseClient(authHeaders)
    const { data, error } = await supabase
      .from('apikeys')
      .insert({
        user_id: USER_ID_APIKEY_EXPIRATION,
        key: null,
        key_hash: '0'.repeat(64),
        name: keyName('direct-insert-policy-bypass'),
        expires_at: null,
      })
      .select()
      .single()

    expect(data).toBeNull()
    expect(error?.message).toContain('row-level security policy')
  })
})

describe('[PUT] /organization with API key policy', () => {
  const updateOrgId = randomUUID()
  const updateOrgCustomerId = `cus_test_update_${id}`

  beforeAll(async () => {
    // Create a test org for updating
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: updateOrgCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_update_${id}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    if (stripeError)
      throw stripeError

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: updateOrgId,
      name: `Test Update Org ${id}`,
      management_email: TEST_EMAIL,
      created_by: USER_ID_APIKEY_EXPIRATION,
      customer_id: updateOrgCustomerId,
    })
    if (orgError)
      throw orgError

    // Add user as super_admin to be able to update the org
    const { error: memberError } = await getSupabaseClient().from('org_users').insert({
      org_id: updateOrgId,
      user_id: USER_ID_APIKEY_EXPIRATION,
      rbac_role_name: 'org_super_admin',
    })
    if (memberError)
      throw memberError
  })

  afterAll(async () => {
    await getSupabaseClient().from('org_users').delete().eq('org_id', updateOrgId)
    await getSupabaseClient().from('orgs').delete().eq('id', updateOrgId)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', updateOrgCustomerId)
  })

  it('update organization to set max API key expiration days', async () => {
    const response = await apiFetch('/organization', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        orgId: updateOrgId,
        max_apikey_expiration_days: 90,
      }),
    })
    expect(response.status).toBe(200)

    // Verify the update
    const { data, error } = await getSupabaseClient().from('orgs').select('max_apikey_expiration_days').eq('id', updateOrgId).single()
    expect(error).toBeNull()
    expect(data?.max_apikey_expiration_days).toBe(90)
  })

  it('update organization to remove max expiration (set to null)', async () => {
    const response = await apiFetch('/organization', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        orgId: updateOrgId,
        max_apikey_expiration_days: null,
      }),
    })
    expect(response.status, await response.text()).toBe(200)

    // Verify the update
    const { data, error } = await getSupabaseClient().from('orgs').select('max_apikey_expiration_days').eq('id', updateOrgId).single()
    expect(error).toBeNull()
    expect(data?.max_apikey_expiration_days).toBeNull()
  })

  it('fail to set invalid max expiration days (negative)', async () => {
    const response = await apiFetch('/organization', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        orgId: updateOrgId,
        max_apikey_expiration_days: -1,
      }),
    })
    expect(response.status).toBe(400)
  })

  it('fail to set invalid max expiration days (too large)', async () => {
    const response = await apiFetch('/organization', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        orgId: updateOrgId,
        max_apikey_expiration_days: 500,
      }),
    })
    expect(response.status).toBe(400)
  })

  it('rejects direct Supabase writes with invalid max expiration days', async () => {
    const supabase = createAuthenticatedSupabaseClient(authHeaders)
    const { error } = await supabase
      .from('orgs')
      .update({ max_apikey_expiration_days: -1 })
      .eq('id', updateOrgId)

    expect(error).not.toBeNull()
    expect(error?.code).toBe('23514')
  })

  // This test must be last because it enables require_apikey_expiration,
  // which would block subsequent tests using a non-expiring API key
  it('update organization to require API key expiration', async () => {
    const response = await apiFetch('/organization', {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        orgId: updateOrgId,
        require_apikey_expiration: true,
      }),
    })
    expect(response.status).toBe(200)

    // Verify the update
    const { data, error } = await getSupabaseClient().from('orgs').select('require_apikey_expiration').eq('id', updateOrgId).single()
    expect(error).toBeNull()
    expect(data?.require_apikey_expiration).toBe(true)
  })
})

describe('expired API key rejection', () => {
  let expiredKeyValue: string
  let validKeyValue: string
  const seededApiKeyIds: number[] = []

  beforeAll(async () => {
    const expiredKey = await seedPlainApiKey('key-to-be-expired', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    const validKey = await seedPlainApiKey('key-valid-for-test', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString())

    expiredKeyValue = expiredKey.key
    validKeyValue = validKey.key
    seededApiKeyIds.push(expiredKey.id, validKey.id)
  })

  afterAll(async () => {
    await deleteSeededApiKeys(seededApiKeyIds)
  })

  it.concurrent('expired API key should be rejected when used for authentication', async () => {
    await expectApiKeyCannotReadBaseOrg(expiredKeyValue)
  })

  it.concurrent('valid (non-expired) API key should work for RLS authentication', async () => {
    await expectApiKeyCanReadBaseOrg(validKeyValue)
  })
})

describe('api key expiration boundary conditions', () => {
  it.concurrent('api key already expired should be rejected', async () => {
    const data = await seedPlainApiKey('key-boundary-test', new Date(Date.now() - 1000).toISOString())

    try {
      await expectApiKeyCannotReadBaseOrg(data.key)
    }
    finally {
      await deleteSeededApiKeys([data.id])
    }
  })

  it.concurrent('api key expiring in the near future should still work', async () => {
    const data = await seedPlainApiKey('key-near-expiration', new Date(Date.now() + 30_000).toISOString())

    try {
      await expectApiKeyCanReadBaseOrg(data.key)
    }
    finally {
      await deleteSeededApiKeys([data.id])
    }
  })

  it.concurrent('api key with null expiration should not be expired', async () => {
    const data = await seedPlainApiKey('key-no-expiration-test', null, BASE_ORG_ID)

    try {
      expect(data.expires_at).toBeNull()

      const [{ expired }] = await executeSQL(
        'SELECT public.is_apikey_expired($1::timestamptz) AS expired',
        [data.expires_at],
      )
      expect(expired).toBe(false)
    }
    finally {
      await deleteSeededApiKeys([data.id])
    }
  })
})
