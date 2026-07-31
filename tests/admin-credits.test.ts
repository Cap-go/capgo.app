import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, getAuthHeaders, getSupabaseClient, ORG_ID, TEST_EMAIL, USER_ID } from './test-utils.ts'

// Test organization for admin credits tests
const TEST_ORG_ID = randomUUID()
const TEST_ORG_NAME = `Admin Credits Test Org ${TEST_ORG_ID}`
const TEST_CUSTOMER_ID = `cus_admin_credits_test_${TEST_ORG_ID}`
const ADMIN_EMAIL = 'admin@capgo.app'
const ADMIN_PASSWORD = 'adminadmin'

let adminHeadersCache: Record<string, string> | null = null
let nonAdminHeaders: Record<string, string>

async function getAdminHeaders() {
  if (adminHeadersCache)
    return adminHeadersCache

  const supabaseUrl = env.SUPABASE_URL
  const supabaseAnonKey = env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY is missing for admin auth headers')
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })

  const { data, error } = await supabase.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  })

  if (error || !data.session?.access_token) {
    throw error ?? new Error('Unable to obtain admin JWT for tests')
  }

  adminHeadersCache = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${data.session.access_token}`,
  }

  return adminHeadersCache
}

beforeAll(async () => {
  nonAdminHeaders = await getAuthHeaders()

  // Create stripe_info for the test org
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: TEST_CUSTOMER_ID,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${TEST_ORG_ID}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  // Create a test organization
  const { error } = await getSupabaseClient().from('orgs').insert({
    id: TEST_ORG_ID,
    name: TEST_ORG_NAME,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: TEST_CUSTOMER_ID,
  })
  if (error)
    throw error
})

afterAll(async () => {
  // Clean up test data
  await getSupabaseClient().from('usage_credit_transactions').delete().eq('org_id', TEST_ORG_ID)
  await getSupabaseClient().from('usage_credit_grants').delete().eq('org_id', TEST_ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', TEST_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', TEST_CUSTOMER_ID)
})

describe('[POST] /private/admin_credits/grant - Admin Access Control', () => {
  it('should return 401 when no authorization header is provided', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        amount: 100,
        notes: 'Test grant',
      }),
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 not_admin when non-admin user tries to grant credits', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: nonAdminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        amount: 100,
        notes: 'Test grant',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 for invalid JSON body (admin check happens first)', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: nonAdminHeaders,
      body: 'invalid json',
    })
    // The not_admin check happens before body validation for authenticated users
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 when org_id is missing', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: nonAdminHeaders,
      body: JSON.stringify({
        amount: 100,
        notes: 'Test grant',
      }),
    })
    // The not_admin check happens before body validation for authenticated users
    expect(response.status).toBe(400)
  })

  it('should return 400 when amount is missing', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: nonAdminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        notes: 'Test grant',
      }),
    })
    // The not_admin check happens before body validation for authenticated users
    expect(response.status).toBe(400)
  })

  it('should return 400 when amount is less than 1', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: nonAdminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        amount: 0,
        notes: 'Test grant',
      }),
    })
    // The not_admin check happens before body validation
    expect(response.status).toBe(400)
  })
})

describe('[GET] /private/admin_credits/search-orgs - Admin Access Control', () => {
  it('should return 401 when no authorization header is provided', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=test`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 not_admin when non-admin user tries to search orgs', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=test`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 not_admin even when search term is empty', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    // The not_admin check happens before validating the search term
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 not_admin even when searching by UUID', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=${ORG_ID}`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should reject SQL injection attempts with not_admin', async () => {
    // Test various SQL injection patterns - all should be blocked by admin check first
    const injectionPatterns = [
      'test%\'; DROP TABLE orgs; --',
      'test\' OR \'1\'=\'1',
      'test%,test2',
      '%()',
    ]

    for (const pattern of injectionPatterns) {
      const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=${encodeURIComponent(pattern)}`, {
        method: 'GET',
        headers: nonAdminHeaders,
      })
      expect(response.status).toBe(400)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_admin')
    }
  })
})

describe('[GET] /private/admin_credits/org-balance/:orgId - Admin Access Control', () => {
  it('should return 401 when no authorization header is provided', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/org-balance/${TEST_ORG_ID}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 not_admin when non-admin user tries to view org balance', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/org-balance/${TEST_ORG_ID}`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 not_admin even for non-existent org', async () => {
    const nonExistentOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/private/admin_credits/org-balance/${nonExistentOrgId}`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    // The not_admin check happens before org validation
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })

  it('should return 400 not_admin even with invalid UUID format', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/org-balance/invalid-uuid`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })
})

describe('[GET] /private/admin_credits/grants-history - Admin Access Control', () => {
  it('should return 401 when no authorization header is provided', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grants-history`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })

  it('should return 400 not_admin when non-admin user tries to view grant history', async () => {
    const response = await fetch(`${BASE_URL}/private/admin_credits/grants-history`, {
      method: 'GET',
      headers: nonAdminHeaders,
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('not_admin')
  })
})

describe('admin credits - admin JWT access', () => {
  it('should allow admin user to search organizations', async () => {
    const adminHeaders = await getAdminHeaders()

    const response = await fetch(`${BASE_URL}/private/admin_credits/search-orgs?q=${TEST_ORG_ID}`, {
      method: 'GET',
      headers: adminHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { orgs: Array<{ id: string }> }
    expect(Array.isArray(data.orgs)).toBe(true)
    expect(data.orgs.some(org => org.id === TEST_ORG_ID)).toBe(true)
  })

  it('should allow admin user to grant credits', async () => {
    const adminHeaders = await getAdminHeaders()

    const grantResponse = await fetch(`${BASE_URL}/private/admin_credits/grant`, {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({
        org_id: TEST_ORG_ID,
        amount: 25,
        notes: 'Admin grant test',
      }),
    })

    expect(grantResponse.status).toBe(200)
    const grantData = await grantResponse.json() as {
      success: boolean
      org: { id: string }
    }
    expect(grantData.success).toBe(true)
    expect(grantData.org.id).toBe(TEST_ORG_ID)

    const balanceResponse = await fetch(`${BASE_URL}/private/admin_credits/org-balance/${TEST_ORG_ID}`, {
      method: 'GET',
      headers: adminHeaders,
    })
    expect(balanceResponse.status).toBe(200)

    const balanceData = await balanceResponse.json() as {
      balance: {
        total_credits: number
        available_credits: number
      }
    }
    expect(balanceData.balance.total_credits).toBeGreaterThanOrEqual(25)
    expect(balanceData.balance.available_credits).toBeGreaterThanOrEqual(25)
  })
})

describe('admin credits - consistent error responses', () => {
  it('all endpoints should return consistent not_admin error for unauthorized users', async () => {
    const endpoints = [
      { method: 'POST', path: '/private/admin_credits/grant', body: JSON.stringify({ org_id: TEST_ORG_ID, amount: 100 }) },
      { method: 'GET', path: '/private/admin_credits/search-orgs?q=test', body: null },
      { method: 'GET', path: `/private/admin_credits/org-balance/${TEST_ORG_ID}`, body: null },
      { method: 'GET', path: '/private/admin_credits/grants-history', body: null },
    ]

    for (const endpoint of endpoints) {
      const response = await fetch(`${BASE_URL}${endpoint.path}`, {
        method: endpoint.method,
        headers: nonAdminHeaders,
        body: endpoint.body,
      })

      expect(response.status).toBe(400)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('not_admin')
    }
  })

  it('all endpoints should return consistent unauthorized error when auth header is missing', async () => {
    const endpoints = [
      { method: 'POST', path: '/private/admin_credits/grant', body: JSON.stringify({ org_id: TEST_ORG_ID, amount: 100 }) },
      { method: 'GET', path: '/private/admin_credits/search-orgs?q=test', body: null },
      { method: 'GET', path: `/private/admin_credits/org-balance/${TEST_ORG_ID}`, body: null },
      { method: 'GET', path: '/private/admin_credits/grants-history', body: null },
    ]

    for (const endpoint of endpoints) {
      const response = await fetch(`${BASE_URL}${endpoint.path}`, {
        method: endpoint.method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: endpoint.body,
      })

      expect(response.status).toBe(401)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('no_jwt_apikey_or_subkey')
    }
  })
})
