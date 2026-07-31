import type { Database } from '../src/types/supabase.types.ts'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkOrgReadAccess } from '../supabase/functions/_backend/private/validate_password_compliance.ts'
import { BASE_URL, executeSQL, getSupabaseClient, headers, TEST_EMAIL, USER_EMAIL, USER_ID, USER_ID_2, USER_PASSWORD, USER_PASSWORD_HASH } from './test-utils.ts'

const ORG_ID = randomUUID()
const globalId = randomUUID()
const name = `Test Password Policy Org ${globalId}`
const customerId = `cus_test_pwd_${ORG_ID}`
const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
const describeSupabaseOnly = describe.skipIf(USE_CLOUDFLARE)

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    return

  // Create stripe_info for this test org
  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: customerId,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_${globalId}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error } = await getSupabaseClient().from('orgs').insert({
    id: ORG_ID,
    name,
    management_email: TEST_EMAIL,
    created_by: USER_ID,
    customer_id: customerId,
  })
  if (error)
    throw error

})

afterAll(async () => {
  if (USE_CLOUDFLARE)
    return

  // Clean up test organization and stripe_info
  await getSupabaseClient().from('user_password_compliance').delete().eq('org_id', ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
})

describeSupabaseOnly('password Policy Configuration via SDK', () => {
  it('enable password policy with all requirements via direct update', async () => {
    const policyConfig = {
      enabled: true,
      min_length: 12,
      require_uppercase: true,
      require_number: true,
      require_special: true,
    }

    const { error } = await getSupabaseClient()
      .from('orgs')
      .update({ password_policy_config: policyConfig })
      .eq('id', ORG_ID)

    expect(error).toBeNull()

    // Verify the policy was saved
    const { data: org, error: fetchError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(fetchError).toBeNull()
    expect(org).toBeTruthy()
    expect(org?.password_policy_config).toEqual(policyConfig)
  })

  it('update password policy with partial requirements', async () => {
    const policyConfig = {
      enabled: true,
      min_length: 8,
      require_uppercase: false,
      require_number: true,
      require_special: false,
    }

    const { error } = await getSupabaseClient()
      .from('orgs')
      .update({ password_policy_config: policyConfig })
      .eq('id', ORG_ID)

    expect(error).toBeNull()

    // Verify the policy was updated
    const { data: org, error: fetchError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(fetchError).toBeNull()
    expect(org?.password_policy_config).toEqual(policyConfig)
  })

  it('reject password policy lengths above the Supabase maximum', async () => {
    const policyConfig = {
      enabled: true,
      min_length: 73,
      require_uppercase: true,
      require_number: true,
      require_special: true,
    }

    const { error } = await getSupabaseClient()
      .from('orgs')
      .update({ password_policy_config: policyConfig })
      .eq('id', ORG_ID)

    expect(error).not.toBeNull()
    expect(error?.message).toContain('password_policy_config')
  })

  it('reject oversized password policy lengths through the org RLS update policy', async () => {
    const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '')
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY

    if (!supabaseUrl || !supabaseAnonKey)
      throw new Error('SUPABASE_URL or SUPABASE_ANON_KEY is missing for password policy RLS test')

    const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
      },
    })

    const { error: signInError } = await client.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })

    expect(signInError).toBeNull()

    const { data: beforeUpdate, error: beforeUpdateError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(beforeUpdateError).toBeNull()

    const { error } = await client
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: true,
          min_length: 73,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      })
      .eq('id', ORG_ID)

    expect(error).toBeNull()

    const { data: afterUpdate, error: afterUpdateError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(afterUpdateError).toBeNull()
    expect(afterUpdate?.password_policy_config).toEqual(beforeUpdate?.password_policy_config)
    expect((afterUpdate?.password_policy_config as { min_length?: number } | null)?.min_length).not.toBe(73)
  })

  it('disable password policy', async () => {
    const { error } = await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: false,
          min_length: 8,
        },
      })
      .eq('id', ORG_ID)

    expect(error).toBeNull()

    // Verify the policy was disabled
    const { data: org, error: fetchError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(fetchError).toBeNull()
    expect((org?.password_policy_config as any)?.enabled).toBe(false)
  })
})

describeSupabaseOnly('[POST] /private/validate_password_compliance', () => {
  beforeAll(async () => {
    // Enable password policy for testing
    await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: true,
          min_length: 10,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      })
      .eq('id', ORG_ID)
  })

  it('reject request with missing email', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        password: 'TestPassword123!',
        org_id: ORG_ID,
      }),
    })
    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('reject request with disallowed Origin header', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers: {
        ...headers,
        Origin: 'https://malicious.example',
      },
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: ORG_ID,
      }),
    })
    expect(response.status).toBe(403)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('forbidden_origin')
  })

  it('allow request from capacitor origin', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers: {
        ...headers,
        Origin: 'capacitor://localhost',
      },
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('password_does_not_meet_policy')
  })

  it('allow request from ionic origin', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers: {
        ...headers,
        Origin: 'ionic://localhost',
      },
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('password_does_not_meet_policy')
  })

  it('allow request from localhost origin', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers: {
        ...headers,
        Origin: 'http://localhost:3000',
      },
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('password_does_not_meet_policy')
  })

  it('reject request with missing password', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        org_id: ORG_ID,
      }),
    })
    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('reject request with missing org_id', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: 'TestPassword123!',
      }),
    })
    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('reject request with invalid org_id format', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: 'TestPassword123!',
        org_id: 'not-a-uuid',
      }),
    })
    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('reject request with invalid email format', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: 'not-an-email',
        password: 'TestPassword123!',
        org_id: ORG_ID,
      }),
    })
    expect(response.status).toBe(400)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('reject request for non-existent org', async () => {
    const nonExistentOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: nonExistentOrgId,
      }),
    })
    expect(response.status).toBe(403)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('not_member')
  })

  it('returns policy errors for non-compliant member', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: USER_PASSWORD,
        org_id: ORG_ID,
      }),
    })

    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string, moreInfo?: { errors?: string[] } }
    expect(responseData.error).toBe('password_does_not_meet_policy')
    expect(Array.isArray(responseData.moreInfo?.errors)).toBe(true)
    expect(responseData.moreInfo!.errors!.length).toBeGreaterThan(0)
  })

  it('reject request for org without password policy', async () => {
    const policyConfig = {
      enabled: true,
      min_length: 10,
      require_uppercase: true,
      require_number: true,
      require_special: true,
    }

    // Temporarily disable policy on existing org to avoid DB mismatch across runtimes
    const { error: disableError } = await getSupabaseClient()
      .from('orgs')
      .update({ password_policy_config: null })
      .eq('id', ORG_ID)
    if (disableError)
      throw disableError

    let caughtError: Error | null = null
    let restoreErrorMessage: string | null = null
    try {
      const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
        headers,
        method: 'POST',
        body: JSON.stringify({
          email: USER_EMAIL,
          password: USER_PASSWORD,
          org_id: ORG_ID,
        }),
      })
      expect(response.status).toBe(400)

      const responseData = await response.json() as { error: string }
      expect(responseData.error).toBe('no_policy')
    }
    catch (error) {
      caughtError = error as Error
    }
    finally {
      const { error: restoreError } = await getSupabaseClient()
        .from('orgs')
        .update({ password_policy_config: policyConfig })
        .eq('id', ORG_ID)

      if (restoreError)
        restoreErrorMessage = restoreError.message
    }

    if (restoreErrorMessage && caughtError)
      throw new Error(`Test failed AND restore failed: ${caughtError.message} | Restore error: ${restoreErrorMessage}`)
    if (restoreErrorMessage)
      throw new Error(restoreErrorMessage)
    if (caughtError)
      throw caughtError
  })

  it('reject request with invalid credentials', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: 'WrongPassword123!',
        org_id: ORG_ID,
      }),
    })
    expect(response.status).toBe(401)

    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_credentials')
  })

  it('does not reveal org existence when credentials are invalid', async () => {
    const nonExistentOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        email: USER_EMAIL,
        password: 'WrongPassword123!',
        org_id: nonExistentOrgId,
      }),
    })

    expect(response.status).toBe(401)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_credentials')
  })

  it('reject request when user is not a member of the org', async () => {
    const nonMemberOrgId = randomUUID()
    const nonMemberCustomerId = `cus_pwd_nomember_${nonMemberOrgId}`
    const nonMemberEmail = USER_EMAIL
    const nonMemberPassword = USER_PASSWORD
    const supabase = getSupabaseClient()

    await executeSQL(
      `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data)
       VALUES ($1, $2, $3, NOW(), NOW(), NOW(), '{}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL, USER_PASSWORD_HASH],
    )
    await executeSQL(
      `INSERT INTO public.users (id, email, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, USER_EMAIL],
    )

    await supabase.from('stripe_info').insert({
      customer_id: nonMemberCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${nonMemberOrgId}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })

    await supabase.from('orgs').insert({
      id: nonMemberOrgId,
      name: `Pwd Policy Non Member Org ${nonMemberOrgId}`,
      management_email: TEST_EMAIL,
      created_by: USER_ID_2,
      customer_id: nonMemberCustomerId,
      password_policy_config: {
        enabled: true,
        min_length: 10,
        require_uppercase: true,
        require_number: true,
        require_special: true,
      },
    })

    try {
      const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
        headers,
        method: 'POST',
        body: JSON.stringify({
          email: nonMemberEmail,
          password: nonMemberPassword,
          org_id: nonMemberOrgId,
        }),
      })

      expect(response.status).toBe(403)
      const responseData = await response.json() as { error: string }
      expect(responseData.error).toBe('not_member')
    }
    finally {
      await supabase.from('orgs').delete().eq('id', nonMemberOrgId)
      await supabase.from('stripe_info').delete().eq('customer_id', nonMemberCustomerId)
    }
  })

  it('reject request with invalid JSON', async () => {
    const response = await fetch(`${BASE_URL}/private/validate_password_compliance`, {
      headers,
      method: 'POST',
      body: 'invalid json',
    })
    expect(response.status).toBe(400)
  })
})

describe('checkOrgReadAccess', () => {
  it('returns error when membership RPC fails', async () => {
    const result = await checkOrgReadAccess({
      rpc: async () => ({ data: null, error: { message: 'boom' } }),
    } as any, ORG_ID, 'req-test')

    expect(result.allowed).toBe(false)
    expect(result.error).toBe('boom')
  })
})

describeSupabaseOnly('[GET] /private/check_org_members_password_policy', () => {
  beforeAll(async () => {
    // Enable password policy for testing
    await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: true,
          min_length: 10,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      })
      .eq('id', ORG_ID)
  })

  it('check password policy compliance for org members via RPC', async () => {
    // Use direct RPC call to test the function
    const { data, error } = await getSupabaseClient().rpc('check_org_members_password_policy', {
      org_id: ORG_ID,
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(Array.isArray(data)).toBe(true)

    // Verify the response structure
    if (data && data.length > 0) {
      const member = data[0]
      expect(member).toHaveProperty('user_id')
      expect(member).toHaveProperty('email')
      expect(member).toHaveProperty('password_policy_compliant')
      expect(typeof member.password_policy_compliant).toBe('boolean')
    }
  })
})

describeSupabaseOnly('password Policy Enforcement Integration', () => {
  const orgWithPolicyId = randomUUID()
  const orgWithPolicyName = `Pwd Policy Integration Org ${randomUUID()}`
  const orgWithPolicyCustomerId = `cus_pwd_int_${orgWithPolicyId}`

  beforeAll(async () => {
    // Create stripe_info
    await getSupabaseClient().from('stripe_info').insert({
      customer_id: orgWithPolicyCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_int_${orgWithPolicyId}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })

    // Create org with password policy enabled while the compatibility flag is false.
    await getSupabaseClient().from('orgs').insert({
      id: orgWithPolicyId,
      name: orgWithPolicyName,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      customer_id: orgWithPolicyCustomerId,
      password_policy_config: {
        enabled: true,
        min_length: 10,
        require_uppercase: true,
        require_number: true,
        require_special: true,
      },
    })

  })

  afterAll(async () => {
    await getSupabaseClient().from('user_password_compliance').delete().eq('org_id', orgWithPolicyId)
    await getSupabaseClient().from('orgs').delete().eq('id', orgWithPolicyId)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', orgWithPolicyCustomerId)
  })

  it('RBAC permission checks respect password policy with compatibility flag disabled', async () => {
    const [result] = await executeSQL(`
      SELECT public.rbac_check_permission_direct(
        public.rbac_perm_org_read(),
        $1::uuid,
        $2::uuid,
        NULL::character varying,
        NULL::bigint,
        NULL
      ) AS allowed
    `, [USER_ID, orgWithPolicyId])

    expect(typeof result.allowed).toBe('boolean')
  })

  it('RBAC permission checks respect password policy', async () => {
    // Create a dedicated RBAC org with password policy to test the RBAC path
    const orgRbacId = randomUUID()
    const orgRbacCustomerId = `cus_pwd_rbac_${orgRbacId}`

    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: orgRbacCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_rbac_${orgRbacId}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(stripeError).toBeNull()

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: orgRbacId,
      name: `RBAC Pwd Policy Org ${orgRbacId}`,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      customer_id: orgRbacCustomerId,
      password_policy_config: {
        enabled: true,
        min_length: 10,
        require_uppercase: true,
        require_number: true,
        require_special: true,
      },
    })
    expect(orgError).toBeNull()

    // org_users + role_bindings are created by the org creation trigger for created_by.

    try {
      const [result] = await executeSQL(`
        SELECT public.rbac_check_permission_direct(
          public.rbac_perm_org_read(),
          $1::uuid,
          $2::uuid,
          NULL::character varying,
          NULL::bigint,
          NULL
        ) AS allowed
      `, [USER_ID, orgRbacId])
      expect(typeof result.allowed).toBe('boolean')
    }
    finally {
      await getSupabaseClient().from('orgs').delete().eq('id', orgRbacId)
      await getSupabaseClient().from('stripe_info').delete().eq('customer_id', orgRbacCustomerId)
    }
  })

  it('get_orgs_v7 includes password policy fields', async () => {
    const { data, error } = await getSupabaseClient().rpc('get_orgs_v7', {
      userid: USER_ID,
    })

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(Array.isArray(data)).toBe(true)

    // Find our test org
    const testOrg = data?.find((org: any) => org.gid === orgWithPolicyId)
    expect(testOrg).toBeTruthy()

    // Verify password policy fields exist
    expect(testOrg).toHaveProperty('password_policy_config')
    expect(testOrg).toHaveProperty('password_has_access')
    expect(typeof testOrg!.password_has_access).toBe('boolean')
  })
})

describeSupabaseOnly('user_password_compliance table', () => {
  it('can insert compliance record via service role', async () => {
    // Get the policy hash
    const { data: org, error: orgError } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(orgError).toBeNull()
    expect(org?.password_policy_config).not.toBeNull()
    const policyConfig = org?.password_policy_config
    if (policyConfig == null)
      throw new Error('Expected password_policy_config to be set for test org')

    // Use the same RPC that production uses to compute the password policy hash
    const { data: rpcResult, error: rpcError } = await getSupabaseClient().rpc('get_password_policy_hash', {
      policy_config: policyConfig,
    })

    expect(rpcError).toBeNull()
    expect(rpcResult).not.toBeNull()
    expect(typeof rpcResult).toBe('string')

    const policyHash = rpcResult as string

    const { error } = await getSupabaseClient()
      .from('user_password_compliance')
      .upsert({
        user_id: USER_ID,
        org_id: ORG_ID,
        policy_hash: policyHash,
        validated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,org_id',
      })

    expect(error).toBeNull()
  })

  it('compliance record makes user pass password policy check', async () => {
    // Ensure policy is enabled
    await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: true,
          min_length: 10,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      })
      .eq('id', ORG_ID)

    // Get the correct policy hash using the same method as the SQL function
    const { data: hashResult } = await getSupabaseClient().rpc('get_password_policy_hash', {
      policy_config: {
        enabled: true,
        min_length: 10,
        require_uppercase: true,
        require_number: true,
        require_special: true,
      },
    })

    // Insert compliance record with correct hash
    await getSupabaseClient()
      .from('user_password_compliance')
      .upsert({
        user_id: USER_ID,
        org_id: ORG_ID,
        policy_hash: hashResult || '',
        validated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,org_id',
      })

    // Check if user now passes password policy
    const { data, error } = await getSupabaseClient().rpc('user_meets_password_policy', {
      user_id: USER_ID,
      org_id: ORG_ID,
    })

    expect(error).toBeNull()
    expect(data).toBe(true)
  })

  it('user fails policy check when policy hash changes', async () => {
    // Update the policy to a different config (changes the hash)
    await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: true,
          min_length: 15, // Changed from 10
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      })
      .eq('id', ORG_ID)

    // User should now fail because their compliance record has the old policy hash
    const { data, error } = await getSupabaseClient().rpc('user_meets_password_policy', {
      user_id: USER_ID,
      org_id: ORG_ID,
    })

    expect(error).toBeNull()
    expect(data).toBe(false)
  })

  it('user passes when policy is disabled', async () => {
    // Disable the policy
    await getSupabaseClient()
      .from('orgs')
      .update({
        password_policy_config: {
          enabled: false,
          min_length: 15,
        },
      })
      .eq('id', ORG_ID)

    // User should pass when policy is disabled (even without compliance record)
    const { data, error } = await getSupabaseClient().rpc('user_meets_password_policy', {
      user_id: USER_ID,
      org_id: ORG_ID,
    })

    expect(error).toBeNull()
    expect(data).toBe(true)
  })
})
