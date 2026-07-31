import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchTestRequest, getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, POSTGRES_URL, USER_ADMIN_EMAIL, USER_EMAIL_NONMEMBER, USER_ID, USER_PASSWORD_NONMEMBER } from './test-utils.ts'

const SSO_TEST_ORG_ID = randomUUID()
const SSO_TEST_CUSTOMER_ID = `cus_sso_test_${randomUUID()}`
const ENTERPRISE_PRODUCT_ID = 'prod_MH5Jh6ajC9e7ZH'

let authHeaders: Record<string, string>

beforeAll(async () => {
  authHeaders = await getAuthHeaders()

  const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
    customer_id: SSO_TEST_CUSTOMER_ID,
    status: 'succeeded',
    product_id: 'prod_LQIregjtNduh4q',
    subscription_id: `sub_sso_${randomUUID()}`,
    trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError

  const { error: orgError } = await getSupabaseClient().from('orgs').insert({
    id: SSO_TEST_ORG_ID,
    name: `SSO Test Org ${SSO_TEST_ORG_ID}`,
    management_email: `sso-test-${SSO_TEST_ORG_ID}@capgo.app`,
    created_by: USER_ID,
    customer_id: SSO_TEST_CUSTOMER_ID,
  })
  if (orgError)
    throw orgError

  const { error: orgUserError } = await getSupabaseClient().from('org_users').insert({
    org_id: SSO_TEST_ORG_ID,
    user_id: USER_ID,
    rbac_role_name: 'org_super_admin' as const,
  })
  if (orgUserError)
    throw orgUserError
})

async function withEnforcedSsoPasswordUser(callback: (context: { targetAuthHeaders: Record<string, string>, email: string }) => Promise<void>) {
  const enforcementOrgId = randomUUID()
  const enforcementCustomerId = `cus_sso_impersonation_${randomUUID()}`
  const providerId = randomUUID()
  const externalProviderId = randomUUID()
  const domain = `${randomUUID()}.sso.test`
  const email = `impersonated-user@${domain}`
  const password = 'testtest'

  const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (createUserError || !createdUser.user)
    throw createUserError ?? new Error('Failed to create dedicated SSO impersonation auth user')

  try {
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: enforcementCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_sso_impersonation_${randomUUID()}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    if (stripeError)
      throw stripeError

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: enforcementOrgId,
      name: `SSO Impersonation Org ${enforcementOrgId}`,
      management_email: `sso-impersonation-${enforcementOrgId}@capgo.app`,
      created_by: USER_ID,
      customer_id: enforcementCustomerId,
    })
    if (orgError)
      throw orgError

    const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
      id: providerId,
      org_id: enforcementOrgId,
      domain,
      provider_id: externalProviderId,
      status: 'active',
      enforce_sso: true,
      dns_verification_token: `dns-${randomUUID()}`,
    })
    if (providerError)
      throw providerError

    const targetAuthHeaders = await getAuthHeadersForCredentials(email, password)
    await callback({ targetAuthHeaders, email })
  }
  finally {
    await Promise.allSettled([
      (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
      getSupabaseClient().from('orgs').delete().eq('id', enforcementOrgId),
      getSupabaseClient().from('stripe_info').delete().eq('customer_id', enforcementCustomerId),
      getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
    ])
  }
}

// Keep shared SSO suite fixture cleanup separate from per-test random SSO fixtures.
afterAll(async () => {
  await getSupabaseClient().from('org_users').delete().eq('org_id', SSO_TEST_ORG_ID)
  await getSupabaseClient().from('orgs').delete().eq('id', SSO_TEST_ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', SSO_TEST_CUSTOMER_ID)
})

describe('[POST] /private/sso/check-domain', () => {
  it('should return has_sso=false for non-SSO domain', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-domain'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: 'user@no-sso-configured-domain.com' }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { has_sso: boolean }
    expect(data.has_sso).toBe(false)
  })

  it('should return 400 for invalid email', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-domain'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ email: 'not-a-valid-email' }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBeDefined()
  })

  it('normalizes domain casing and whitespace for existing providers and lookups', async () => {
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const providerDomainInput = `  ${randomUUID().slice(0, 8)}.SSO.Test  `
    const expectedDomain = providerDomainInput.trim().toLowerCase()

    await getSupabaseClient().from('sso_providers').insert({
      id: providerId,
      org_id: SSO_TEST_ORG_ID,
      domain: providerDomainInput,
      provider_id: externalProviderId,
      status: 'active',
      enforce_sso: false,
      dns_verification_token: `dns-${randomUUID()}`,
    } as any)

    try {
      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-domain'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ email: `user@${expectedDomain.toUpperCase()}` }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as {
        has_sso: boolean
        enforce_sso?: boolean
        provider_id?: string
        org_id?: string
      }
      expect(data.has_sso).toBe(true)
      expect(data.enforce_sso).toBe(false)
      expect(data.provider_id).toBeUndefined()
      expect(data.org_id).toBeUndefined()

      const { data: rpcData, error: rpcError } = await (getSupabaseClient().rpc as any)('check_domain_sso', { p_domain: `  ${expectedDomain.toUpperCase()}  ` })
      expect(rpcError).toBeNull()
      expect(Array.isArray(rpcData)).toBe(true)
      expect(rpcData?.length).toBeGreaterThan(0)
      expect(rpcData?.[0].has_sso).toBe(true)
      expect(rpcData?.[0].org_id).toBe(SSO_TEST_ORG_ID)

      const { data: normalizedRow, error: normalizedRowError } = await getSupabaseClient()
        .from('sso_providers')
        .select('domain')
        .eq('id', providerId)
        .single()

      expect(normalizedRowError).toBeNull()
      expect(normalizedRow?.domain).toBe(expectedDomain)
    }
    finally {
      await getSupabaseClient().from('sso_providers').delete().eq('id', providerId)
    }
  })
})

describe('[POST] /private/sso/check-enforcement', () => {
  it.concurrent('should return allowed=true when a matching SSO provider exists but enforcement is disabled', async () => {
    const enforcementOrgId = randomUUID()
    const enforcementCustomerId = `cus_sso_enforcement_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `user@${domain}`
    const password = 'testtest'

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createUserError || !createdUser.user) {
      throw createUserError ?? new Error('Failed to create dedicated SSO enforcement auth user')
    }

    try {
      const { error: enforcementStripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: enforcementCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_enforcement_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (enforcementStripeError)
        throw enforcementStripeError

      const { error: enforcementOrgError } = await getSupabaseClient().from('orgs').insert({
        id: enforcementOrgId,
        name: `SSO Enforcement Org ${enforcementOrgId}`,
        management_email: `sso-enforcement-${enforcementOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: enforcementCustomerId,
      })
      if (enforcementOrgError)
        throw enforcementOrgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: enforcementOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const isolatedAuthHeaders = await getAuthHeadersForCredentials(email, password)

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
        method: 'POST',
        headers: isolatedAuthHeaders,
        body: JSON.stringify({
          email: 'ignored@example.com',
          auth_type: 'password',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { allowed: boolean }
      expect(data.allowed).toBe(true)
    }
    finally {
      await Promise.allSettled([
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', enforcementOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', enforcementCustomerId),
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
      ])
    }
  })

  it('should return allowed=true for password auth when no SSO is configured', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        email: 'user@no-sso-enforcement-domain.com',
        auth_type: 'password',
      }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { allowed: boolean }
    expect(data.allowed).toBe(true)
  })

  it.concurrent('should allow platform admin impersonation when SSO is enforced', async () => {
    await withEnforcedSsoPasswordUser(async ({ targetAuthHeaders }) => {
      const adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, 'adminadmin')

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
        method: 'POST',
        headers: {
          ...targetAuthHeaders,
          'X-Capgo-Spoof-Admin-Authorization': adminHeaders.Authorization,
        },
        body: JSON.stringify({
          email: 'ignored@example.com',
          auth_type: 'password',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { allowed: boolean }
      expect(data.allowed).toBe(true)
    })
  })

  it.concurrent('should not allow a user token to bypass SSO enforcement as spoof proof', async () => {
    await withEnforcedSsoPasswordUser(async ({ targetAuthHeaders }) => {
      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
        method: 'POST',
        headers: {
          ...targetAuthHeaders,
          'X-Capgo-Spoof-Admin-Authorization': targetAuthHeaders.Authorization,
        },
        body: JSON.stringify({
          email: 'ignored@example.com',
          auth_type: 'password',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { allowed: boolean, reason?: string }
      expect(data).toEqual({ allowed: false, reason: 'sso_enforced' })
    })
  })

  it.concurrent('should not allow a different non-admin token to bypass SSO enforcement as spoof proof', async () => {
    await withEnforcedSsoPasswordUser(async ({ targetAuthHeaders }) => {
      const nonAdminHeaders = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
        method: 'POST',
        headers: {
          ...targetAuthHeaders,
          'X-Capgo-Spoof-Admin-Authorization': nonAdminHeaders.Authorization,
        },
        body: JSON.stringify({
          email: 'ignored@example.com',
          auth_type: 'password',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { allowed: boolean, reason?: string }
      expect(data).toEqual({ allowed: false, reason: 'sso_enforced' })
    })
  })

  it.concurrent('should ignore malformed provider entries in JWT app metadata', async () => {
    const email = `${randomUUID()}@no-sso-enforcement-domain.com`
    const password = 'testtest'

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        provider: 'email',
        providers: [{}],
      } as any,
    })
    if (createUserError || !createdUser.user) {
      throw createUserError ?? new Error('Failed to create dedicated malformed provider auth user')
    }

    try {
      const isolatedAuthHeaders = await getAuthHeadersForCredentials(email, password)

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/check-enforcement'), {
        method: 'POST',
        headers: isolatedAuthHeaders,
        body: JSON.stringify({
          email: 'ignored@example.com',
          auth_type: 'password',
        }),
      })

      expect(response.status).toBe(200)
      const data = await response.json() as { allowed: boolean }
      expect(data.allowed).toBe(true)
    }
    finally {
      await getSupabaseClient().auth.admin.deleteUser(createdUser.user.id)
    }
  })
})

describe('[GET] /private/sso/sp-metadata', () => {
  it('returns SP metadata derived from the backend runtime URL', async () => {
    const response = await fetchTestRequest(getEndpointUrl('/private/sso/sp-metadata'), {
      method: 'GET',
      headers: authHeaders,
    })

    expect(response.status).toBe(200)

    const data = await response.json() as {
      acs_url: string
      entity_id: string
      sp_metadata_url: string
      nameid_format: string
    }

    const expectedBaseUrl = new URL(getEndpointUrl('/private/sso/sp-metadata')).origin

    expect(data).toEqual({
      acs_url: `${expectedBaseUrl}/auth/v1/sso/saml/acs`,
      entity_id: `${expectedBaseUrl}/auth/v1/sso/saml/metadata`,
      sp_metadata_url: `${expectedBaseUrl}/auth/v1/sso/saml/metadata`,
      nameid_format: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    })
  })
})

describe('[POST] /private/sso/providers', () => {
  it.concurrent('rejects pending Enterprise onboarding plans for SSO provider creation', async () => {
    const orgId = randomUUID()
    const pendingCustomerId = `pending_${orgId}`

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: pendingCustomerId,
        status: null,
        product_id: ENTERPRISE_PRODUCT_ID,
        subscription_id: null,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: orgId,
        name: `Pending Enterprise SSO ${orgId}`,
        management_email: `pending-enterprise-${orgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: pendingCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: orgUserError } = await getSupabaseClient().from('org_users').insert({
        org_id: orgId,
        user_id: USER_ID,
        rbac_role_name: 'org_super_admin' as const,
      })
      if (orgUserError)
        throw orgUserError

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/providers'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          org_id: orgId,
          domain: `${randomUUID()}.sso.test`,
          metadata_url: 'https://idp.example.com/metadata.xml',
        }),
      })

      expect(response.status).toBe(403)
      const data = await response.json() as { error: string }
      expect(data.error).toBe('enterprise_plan_required')
    }
    finally {
      await getSupabaseClient().from('org_users').delete().eq('org_id', orgId)
      await getSupabaseClient().from('orgs').delete().eq('id', orgId)
      await getSupabaseClient().from('stripe_info').delete().eq('customer_id', pendingCustomerId)
    }
  })
})

describe('[POST] /private/sso/prelink-users', () => {
  it.concurrent('only unlinks password identities for members of the provider org', async () => {
    const prelinkOrgId = randomUUID()
    const prelinkCustomerId = `cus_sso_prelink_${randomUUID()}`
    const foreignOrgId = randomUUID()
    const foreignCustomerId = `cus_sso_prelink_foreign_${randomUUID()}`
    const providerId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const memberEmail = `member-${randomUUID()}@${domain}`
    const outsiderEmail = `outsider-${randomUUID()}@${domain}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    let memberUserId: string | null = null
    let outsiderUserId: string | null = null

    try {
      const { error: prelinkStripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: prelinkCustomerId,
        status: 'succeeded',
        product_id: ENTERPRISE_PRODUCT_ID,
        subscription_id: `sub_sso_prelink_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (prelinkStripeError)
        throw prelinkStripeError

      const { error: prelinkOrgError } = await getSupabaseClient().from('orgs').insert({
        id: prelinkOrgId,
        name: `SSO Prelink Org ${prelinkOrgId}`,
        management_email: `sso-prelink-${prelinkOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: prelinkCustomerId,
      })
      if (prelinkOrgError)
        throw prelinkOrgError

      const { error: prelinkAdminError } = await getSupabaseClient().from('org_users').insert({
        org_id: prelinkOrgId,
        user_id: USER_ID,
        rbac_role_name: 'org_super_admin' as const,
      })
      if (prelinkAdminError)
        throw prelinkAdminError

      const { error: foreignStripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: foreignCustomerId,
        status: 'succeeded',
        product_id: ENTERPRISE_PRODUCT_ID,
        subscription_id: `sub_sso_prelink_foreign_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (foreignStripeError)
        throw foreignStripeError

      const { error: foreignOrgError } = await getSupabaseClient().from('orgs').insert({
        id: foreignOrgId,
        name: `SSO Foreign Org ${foreignOrgId}`,
        management_email: `sso-foreign-${foreignOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: foreignCustomerId,
      })
      if (foreignOrgError)
        throw foreignOrgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: prelinkOrgId,
        domain,
        provider_id: randomUUID(),
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { data: memberUserData, error: memberUserError } = await getSupabaseClient().auth.admin.createUser({
        email: memberEmail,
        password: 'testtest',
        email_confirm: true,
      })
      if (memberUserError || !memberUserData.user) {
        throw memberUserError ?? new Error('Failed to create prelink org member user')
      }
      memberUserId = memberUserData.user.id

      const { data: outsiderUserData, error: outsiderUserError } = await getSupabaseClient().auth.admin.createUser({
        email: outsiderEmail,
        password: 'testtest',
        email_confirm: true,
      })
      if (outsiderUserError || !outsiderUserData.user) {
        throw outsiderUserError ?? new Error('Failed to create foreign org user for prelink test')
      }
      outsiderUserId = outsiderUserData.user.id

      const { error: publicUsersError } = await getSupabaseClient().from('users').insert([
        {
          id: memberUserId,
          email: memberEmail,
          first_name: 'Prelink',
          last_name: 'Member',
          country: null,
          enable_notifications: true,
          opt_for_newsletters: true,
        },
        {
          id: outsiderUserId,
          email: outsiderEmail,
          first_name: 'Prelink',
          last_name: 'Outsider',
          country: null,
          enable_notifications: true,
          opt_for_newsletters: true,
        },
      ])
      if (publicUsersError)
        throw publicUsersError

      const { error: orgUsersError } = await getSupabaseClient().from('org_users').insert([
        {
          org_id: prelinkOrgId,
          user_id: memberUserId,
          rbac_role_name: 'org_member' as const,
        },
        {
          org_id: foreignOrgId,
          user_id: outsiderUserId,
          rbac_role_name: 'org_member' as const,
        },
      ])
      if (orgUsersError)
        throw orgUsersError

      const beforeMemberIdentities = await pool.query<{ provider: string }>(
        'select provider from auth.identities where user_id = $1 order by provider',
        [memberUserId],
      )
      const beforeOutsiderIdentities = await pool.query<{ provider: string }>(
        'select provider from auth.identities where user_id = $1 order by provider',
        [outsiderUserId],
      )

      expect(beforeMemberIdentities.rows.some(row => row.provider === 'email')).toBe(true)
      expect(beforeOutsiderIdentities.rows.some(row => row.provider === 'email')).toBe(true)

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/prelink-users'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ provider_id: providerId }),
      })

      expect(response.status).toBe(200)
      const responseBody = await response.json() as {
        processed: number
        linked: number
        error_count: number
      }
      expect(responseBody).toEqual({
        processed: 1,
        linked: 1,
        error_count: 0,
      })

      const memberIdentities = await pool.query<{ provider: string }>(
        'select provider from auth.identities where user_id = $1 order by provider',
        [memberUserId],
      )
      const outsiderIdentities = await pool.query<{ provider: string }>(
        'select provider from auth.identities where user_id = $1 order by provider',
        [outsiderUserId],
      )

      expect(memberIdentities.rows.some(row => row.provider === 'email')).toBe(false)
      expect(outsiderIdentities.rows.some(row => row.provider === 'email')).toBe(true)
    }
    finally {
      await pool.end()

      await Promise.allSettled([
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('org_users').delete().eq('org_id', prelinkOrgId),
        getSupabaseClient().from('org_users').delete().eq('org_id', foreignOrgId),
        memberUserId ? getSupabaseClient().from('users').delete().eq('id', memberUserId) : Promise.resolve(null),
        outsiderUserId ? getSupabaseClient().from('users').delete().eq('id', outsiderUserId) : Promise.resolve(null),
      ])

      await Promise.allSettled([
        getSupabaseClient().from('orgs').delete().eq('id', prelinkOrgId),
        getSupabaseClient().from('orgs').delete().eq('id', foreignOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', prelinkCustomerId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', foreignCustomerId),
        memberUserId ? getSupabaseClient().auth.admin.deleteUser(memberUserId) : Promise.resolve(null),
        outsiderUserId ? getSupabaseClient().auth.admin.deleteUser(outsiderUserId) : Promise.resolve(null),
      ])
    }
  })
})

describe('generate_org_on_user_create', () => {
  it('skips personal org creation for SSO-authenticated users on managed domains', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_managed_${randomUUID()}`
    const providerId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `managed-user@${domain}`

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: {
        provider: `sso:${providerId}`,
      },
      user_metadata: {
        first_name: 'Managed',
        last_name: 'SSO',
      },
    })
    if (createUserError || !createdUser.user) {
      throw createUserError ?? new Error('Failed to create SSO auth user for trigger test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_managed_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `Managed SSO Org ${managedOrgId}`,
        management_email: `managed-sso-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: randomUUID(),
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: publicUserError } = await getSupabaseClient().from('users').insert({
        id: createdUser.user.id,
        email,
        first_name: 'Managed',
        last_name: 'SSO',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      })
      if (publicUserError)
        throw publicUserError

      const { data: createdOrgs, error: createdOrgsError } = await getSupabaseClient()
        .from('orgs')
        .select('id')
        .eq('created_by', createdUser.user.id)

      expect(createdOrgsError).toBeNull()
      expect(createdOrgs ?? []).toHaveLength(0)
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
    }
  })

  it('does not create a personal org for email-auth users on managed domains', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_email_managed_${randomUUID()}`
    const providerId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `email-user@${domain}`

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: {
        provider: 'email',
      },
      user_metadata: {
        first_name: 'Email',
        last_name: 'User',
      },
    })
    if (createUserError || !createdUser.user) {
      throw createUserError ?? new Error('Failed to create email auth user for trigger test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_email_managed_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `Email Managed Org ${managedOrgId}`,
        management_email: `email-managed-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: randomUUID(),
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: publicUserError } = await getSupabaseClient().from('users').insert({
        id: createdUser.user.id,
        email,
        first_name: 'Email',
        last_name: 'User',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      })
      if (publicUserError)
        throw publicUserError

      const { data: createdOrgs, error: createdOrgsError } = await getSupabaseClient()
        .from('orgs')
        .select('id, management_email')
        .eq('created_by', createdUser.user.id)

      expect(createdOrgsError).toBeNull()
      expect(createdOrgs ?? []).toHaveLength(0)
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
    }
  })
})

describe('[POST] /private/sso/provision-user', () => {
  it('rejects non-SAML providers even when they are non-email identities', async () => {
    const email = `oauth-user-${randomUUID()}@capgo.app`
    const password = 'testtest'
    const oauthProviderId = `google-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'OAuth',
        last_name: 'User',
      },
    })
    if (createUserError || !createdUser.user) {
      await pool.end()
      throw createUserError ?? new Error('Failed to create OAuth-like auth user for SSO provider validation test')
    }

    try {
      const oauthAuthHeaders = await getAuthHeadersForCredentials(email, password)

      const { error: appMetadataError } = await getSupabaseClient().auth.admin.updateUserById(createdUser.user.id, {
        app_metadata: {
          provider: 'google',
        },
      })
      if (appMetadataError)
        throw appMetadataError

      await pool.query(
        `
          update auth.identities
          set provider = 'google',
              provider_id = $1,
              identity_data = jsonb_build_object($$sub$$, $1::text, $$email$$, $2::text, $$email_verified$$, true)
          where user_id = $3
        `,
        [oauthProviderId, email, createdUser.user.id],
      )

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: oauthAuthHeaders,
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(403)
      const responseBody = await response.json() as { error: string }
      expect(responseBody.error).toBe('sso_auth_required')
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        pool.end(),
      ])
    }
  })

  it('creates missing public.users profile before assigning org membership', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_missing_profile_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `missing-profile-${randomUUID()}@${domain}`
    const password = 'testtest'
    const identityProvider = `sso:${externalProviderId}`
    const identityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Missing',
        last_name: 'Profile',
      },
    })
    if (createUserError || !createdUser.user) {
      await pool.end()
      throw createUserError ?? new Error('Failed to create SSO auth user for missing profile provisioning test')
    }

    try {
      const ssoAuthHeaders = await getAuthHeadersForCredentials(email, password)

      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_missing_profile_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `SSO Missing Profile Org ${managedOrgId}`,
        management_email: `sso-missing-profile-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: providerMetadataError } = await getSupabaseClient().auth.admin.updateUserById(createdUser.user.id, {
        app_metadata: {
          provider: identityProvider,
        },
      })
      if (providerMetadataError)
        throw providerMetadataError

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [identityProvider, identityProviderId, email, createdUser.user.id],
      )

      // Ensure the test really covers the missing-profile path.
      await getSupabaseClient().from('users').delete().eq('id', createdUser.user.id)

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: ssoAuthHeaders,
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(200)
      const responseBody = await response.json() as {
        success: boolean
        already_member?: boolean
      }
      expect(responseBody).toMatchObject({ success: true })

      const { data: publicUser, error: publicUserError } = await getSupabaseClient()
        .from('users')
        .select('id, email')
        .eq('id', createdUser.user.id)
        .maybeSingle()

      expect(publicUserError).toBeNull()
      expect(publicUser?.id).toBe(createdUser.user.id)
      expect(publicUser?.email).toBe(email)

      const { data: membership, error: membershipError } = await getSupabaseClient()
        .from('org_users')
        .select('id, org_id, user_id')
        .eq('org_id', managedOrgId)
        .eq('user_id', createdUser.user.id)
        .maybeSingle()

      expect(membershipError).toBeNull()
      expect(membership?.org_id).toBe(managedOrgId)
      expect(membership?.user_id).toBe(createdUser.user.id)

      const roleBinding = await pool.query<{ role_name: string }>(
        `
          select roles.name as role_name
          from public.role_bindings
          join public.roles
            on roles.id = role_bindings.role_id
            and roles.scope_type = role_bindings.scope_type
          where role_bindings.principal_type = public.rbac_principal_user()
            and role_bindings.principal_id = $1
            and role_bindings.scope_type = public.rbac_scope_org()
            and role_bindings.org_id = $2
          limit 1
        `,
        [createdUser.user.id, managedOrgId],
      )

      expect(roleBinding.rows[0]?.role_name).toBe('org_member')
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
        pool.end(),
      ])
    }
  })

  it('rejects first-time SSO provisioning when the authenticating provider does not own the email domain', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_provider_mismatch_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const attackerExternalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `provider-mismatch-${randomUUID()}@${domain}`
    const password = 'testtest'
    const attackerIdentityProvider = `sso:${attackerExternalProviderId}`
    const attackerIdentityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    let createdUserId: string | null = null

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_provider_mismatch_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      await pool.query(
        `
          insert into public.orgs (id, name, management_email, created_by, customer_id)
          values ($1, $2, $3, $4, $5)
        `,
        [
          managedOrgId,
          `SSO Provider Mismatch Org ${managedOrgId}`,
          `sso-provider-mismatch-${managedOrgId}@capgo.app`,
          USER_ID,
          managedCustomerId,
        ],
      )

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        app_metadata: {
          provider: attackerIdentityProvider,
        },
        user_metadata: {
          first_name: 'Provider',
          last_name: 'Mismatch',
        },
      })
      if (createUserError || !createdUser.user) {
        throw createUserError ?? new Error('Failed to create mismatched SSO auth user')
      }
      createdUserId = createdUser.user.id

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [attackerIdentityProvider, attackerIdentityProviderId, email, createdUserId],
      )

      const ssoAuthHeaders = await getAuthHeadersForCredentials(email, password)
      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: ssoAuthHeaders,
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(403)
      const responseBody = await response.json() as { error: string }
      expect(responseBody.error).toBe('provider_mismatch')

      const { data: membership, error: membershipError } = await getSupabaseClient()
        .from('org_users')
        .select('id')
        .eq('org_id', managedOrgId)
        .eq('user_id', createdUserId)
        .maybeSingle()

      expect(membershipError).toBeNull()
      expect(membership).toBeNull()
    }
    finally {
      await Promise.allSettled([
        createdUserId ? getSupabaseClient().auth.admin.deleteUser(createdUserId) : Promise.resolve(null),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
        pool.end(),
      ])
    }
  })

  it('promotes invite-only org memberships during SSO provisioning instead of treating them as completed membership', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_invite_promotion_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `invite-only-user@${domain}`
    const password = 'testtest'
    const identityProvider = `sso:${externalProviderId}`
    const identityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        provider: identityProvider,
      },
      user_metadata: {
        first_name: 'Invite',
        last_name: 'Promotion',
      },
    })
    if (createUserError || !createdUser.user) {
      await pool.end()
      throw createUserError ?? new Error('Failed to create SSO auth user for invite promotion test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_invite_promotion_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `SSO Invite Promotion Org ${managedOrgId}`,
        management_email: `sso-invite-promotion-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: publicUserError } = await getSupabaseClient().from('users').insert({
        id: createdUser.user.id,
        email,
        first_name: 'Invite',
        last_name: 'Promotion',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      })
      if (publicUserError)
        throw publicUserError

      const { error: inviteMembershipError } = await getSupabaseClient().from('org_users').insert({
        org_id: managedOrgId,
        user_id: createdUser.user.id,
        rbac_role_name: 'org_member' as const, is_invite: true,
      })
      if (inviteMembershipError)
        throw inviteMembershipError

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [identityProvider, identityProviderId, email, createdUser.user.id],
      )

      const ssoAuthHeaders = await getAuthHeadersForCredentials(email, password)
      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: ssoAuthHeaders,
        body: JSON.stringify({}),
      })

      const responseBody = await response.json() as {
        success: boolean
        already_member?: boolean
      }
      expect(response.status).toBe(200)
      expect(responseBody).toMatchObject({ success: true })
      expect(responseBody.already_member).toBeUndefined()

      const { data: membership, error: membershipError } = await getSupabaseClient()
        .from('org_users')
        .select('rbac_role_name')
        .eq('org_id', managedOrgId)
        .eq('user_id', createdUser.user.id)
        .single()

      expect(membershipError).toBeNull()
      expect(membership?.rbac_role_name).toBe('org_member')
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
      await pool.end()
    }
  })

  it('merges an existing password account when a new SSO auth user arrives with the same email', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_merge_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const targetEmail = `merge-user@${domain}`
    const tempSsoEmail = `temp-sso-${randomUUID()}@${domain}`
    const password = 'testtest'
    const identityProvider = `sso:${externalProviderId}`
    const identityProviderId = `nameid-${randomUUID()}`
    const unrelatedSsoProvider = `sso:${randomUUID()}`
    const unrelatedSsoProviderId = `nameid-${randomUUID()}`
    const unrelatedProviderId = `github-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: originalUser, error: originalUserError } = await getSupabaseClient().auth.admin.createUser({
      email: targetEmail,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Merge',
        last_name: 'Original',
      },
    })
    if (originalUserError || !originalUser.user) {
      throw originalUserError ?? new Error('Failed to create original password auth user')
    }

    const { data: duplicateUser, error: duplicateUserError } = await getSupabaseClient().auth.admin.createUser({
      email: tempSsoEmail,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Merge',
        last_name: 'Duplicate',
      },
    })
    if (duplicateUserError || !duplicateUser.user) {
      await pool.end()
      throw duplicateUserError ?? new Error('Failed to create duplicate auth user for SSO merge test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_merge_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `SSO Merge Org ${managedOrgId}`,
        management_email: `sso-merge-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: originalPublicUserError } = await getSupabaseClient().from('users').insert({
        id: originalUser.user.id,
        email: targetEmail,
        first_name: 'Merge',
        last_name: 'Original',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      })
      if (originalPublicUserError)
        throw originalPublicUserError

      await getAuthHeadersForCredentials(targetEmail, password)
      const originalSessionsBeforeMerge = await pool.query<{ count: string }>(
        'select count(*) from auth.sessions where user_id = $1',
        [originalUser.user.id],
      )
      expect(Number(originalSessionsBeforeMerge.rows[0]?.count ?? 0)).toBeGreaterThan(0)

      const duplicateAuthHeaders = await getAuthHeadersForCredentials(tempSsoEmail, password)

      // Local Supabase Auth's admin API enforces unique emails before considering the
      // SSO-only flag. Update auth.users directly so this test can mimic the production
      // SSO duplicate-user shape while keeping the canonical merge key in auth.users.email.
      await pool.query(
        `
          update auth.users
          set email = $1,
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              is_sso_user = true,
              raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                || jsonb_build_object('provider', $2::text, 'providers', jsonb_build_array($2::text)),
              updated_at = now()
          where id = $3
        `,
        [targetEmail, identityProvider, duplicateUser.user.id],
      )

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [identityProvider, identityProviderId, targetEmail, duplicateUser.user.id],
      )
      await pool.query(
        `
          insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
          values ($1, $2, jsonb_build_object($$sub$$, $3::text, $$email$$, $4::text, $$email_verified$$, true), $5, $3, now(), now(), now())
        `,
        [randomUUID(), duplicateUser.user.id, unrelatedSsoProviderId, targetEmail, unrelatedSsoProvider],
      )
      await pool.query(
        `
          insert into auth.identities (id, user_id, identity_data, provider, provider_id, created_at, updated_at, last_sign_in_at)
          values ($1, $2, jsonb_build_object($$sub$$, $3::text, $$email$$, $4::text, $$email_verified$$, true), 'github', $3, now(), now(), now())
        `,
        [randomUUID(), duplicateUser.user.id, unrelatedProviderId, targetEmail],
      )

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: duplicateAuthHeaders,
        body: JSON.stringify({}),
      })

      const responseBody = await response.json() as {
        success: boolean
        merged?: boolean
      }
      expect(response.status).toBe(200)
      expect(responseBody).toMatchObject({ success: true, merged: true })

      const { data: originalPublicUser, error: originalPublicUserLookupError } = await getSupabaseClient()
        .from('users')
        .select('id, email')
        .eq('id', originalUser.user.id)
        .single()

      expect(originalPublicUserLookupError).toBeNull()
      expect(originalPublicUser?.email).toBe(targetEmail)

      const { data: duplicateAuthLookup } = await getSupabaseClient().auth.admin.getUserById(duplicateUser.user.id)
      expect(duplicateAuthLookup.user).toBeNull()

      const { data: mergedMembership, error: mergedMembershipError } = await getSupabaseClient()
        .from('org_users')
        .select('org_id, user_id, rbac_role_name')
        .eq('org_id', managedOrgId)
        .eq('user_id', originalUser.user.id)
        .maybeSingle()

      expect(mergedMembershipError).toBeNull()
      expect(mergedMembership).toMatchObject({
        org_id: managedOrgId,
        user_id: originalUser.user.id,
        rbac_role_name: 'org_member',
      })

      const identitiesAfterMerge = await pool.query(
        'select provider, provider_id, user_id, email from auth.identities where user_id = $1 order by provider, provider_id',
        [originalUser.user.id],
      )

      expect(identitiesAfterMerge.rows.some(row =>
        row.provider === identityProvider
        && row.provider_id === identityProviderId
        && row.user_id === originalUser.user.id
        && row.email === targetEmail,
      )).toBe(true)
      expect(identitiesAfterMerge.rows.every(row => row.provider === identityProvider)).toBe(true)
      expect(identitiesAfterMerge.rows.some(row => row.provider === 'email')).toBe(false)
      expect(identitiesAfterMerge.rows.some(row =>
        row.provider === 'github'
        && row.provider_id === unrelatedProviderId,
      )).toBe(false)
      expect(identitiesAfterMerge.rows.some(row =>
        row.provider === unrelatedSsoProvider
        && row.provider_id === unrelatedSsoProviderId,
      )).toBe(false)

      const mergedAuthUser = await pool.query<{ encrypted_password: string | null, is_sso_user: boolean }>(
        'select encrypted_password, is_sso_user from auth.users where id = $1',
        [originalUser.user.id],
      )

      expect(mergedAuthUser.rows[0]).toMatchObject({
        encrypted_password: null,
        is_sso_user: true,
      })

      const originalSessionsAfterMerge = await pool.query<{ count: string }>(
        'select count(*) from auth.sessions where user_id = $1',
        [originalUser.user.id],
      )
      expect(Number(originalSessionsAfterMerge.rows[0]?.count ?? 0)).toBe(0)
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(duplicateUser.user.id),
        getSupabaseClient().auth.admin.deleteUser(originalUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
      await pool.end()
    }
  })

  it('does not merge SSO login into an account that only matches mutable public profile email', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_profile_poison_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const attackerEmail = `profile-poison-attacker-${randomUUID()}@capgo.app`
    const targetEmail = `profile-poison-victim@${domain}`
    const password = 'testtest'
    const identityProvider = `sso:${externalProviderId}`
    const identityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: attackerUser, error: attackerUserError } = await getSupabaseClient().auth.admin.createUser({
      email: attackerEmail,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Profile',
        last_name: 'Poison',
      },
    })
    if (attackerUserError || !attackerUser.user) {
      await pool.end()
      throw attackerUserError ?? new Error('Failed to create profile poisoning user')
    }

    const { data: ssoUser, error: ssoUserError } = await getSupabaseClient().auth.admin.createUser({
      email: targetEmail,
      password,
      email_confirm: true,
      app_metadata: {
        provider: identityProvider,
      },
      user_metadata: {
        first_name: 'SSO',
        last_name: 'Victim',
      },
    })
    if (ssoUserError || !ssoUser.user) {
      await pool.end()
      throw ssoUserError ?? new Error('Failed to create SSO user for profile poisoning regression test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_profile_poison_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `SSO Profile Poison Org ${managedOrgId}`,
        management_email: `sso-profile-poison-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: poisonedPublicUserError } = await getSupabaseClient().from('users').upsert({
        id: attackerUser.user.id,
        email: targetEmail,
        first_name: 'Profile',
        last_name: 'Poison',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      }, { onConflict: 'id' })
      if (poisonedPublicUserError)
        throw poisonedPublicUserError

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [identityProvider, identityProviderId, targetEmail, ssoUser.user.id],
      )

      const ssoAuthHeaders = await getAuthHeadersForCredentials(targetEmail, password)
      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: ssoAuthHeaders,
        body: JSON.stringify({}),
      })

      const responseBody = await response.json() as {
        success: boolean
        merged?: boolean
      }
      expect(response.status).toBe(200)
      expect(responseBody).toMatchObject({ success: true })
      expect(responseBody.merged).toBeUndefined()

      const { data: attackerMembership, error: attackerMembershipError } = await getSupabaseClient()
        .from('org_users')
        .select('id')
        .eq('org_id', managedOrgId)
        .eq('user_id', attackerUser.user.id)
        .maybeSingle()

      expect(attackerMembershipError).toBeNull()
      expect(attackerMembership).toBeNull()

      const { data: ssoMembership, error: ssoMembershipError } = await getSupabaseClient()
        .from('org_users')
        .select('org_id, user_id, rbac_role_name')
        .eq('org_id', managedOrgId)
        .eq('user_id', ssoUser.user.id)
        .maybeSingle()

      expect(ssoMembershipError).toBeNull()
      expect(ssoMembership).toMatchObject({
        org_id: managedOrgId,
        user_id: ssoUser.user.id,
        rbac_role_name: 'org_member',
      })

      const identitiesAfterProvision = await pool.query(
        'select provider, provider_id, user_id from auth.identities where provider = $1 and provider_id = $2',
        [identityProvider, identityProviderId],
      )

      expect(identitiesAfterProvision.rows).toEqual([
        {
          provider: identityProvider,
          provider_id: identityProviderId,
          user_id: ssoUser.user.id,
        },
      ])
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(ssoUser.user.id),
        getSupabaseClient().auth.admin.deleteUser(attackerUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
      await pool.end()
    }
  })

  it('rejects account merge when the authenticating SSO provider does not match the email domain provider', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_merge_mismatch_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const attackerExternalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const targetEmail = `merge-mismatch-user@${domain}`
    const tempSsoEmail = `temp-sso-mismatch-${randomUUID()}@${domain}`
    const password = 'testtest'
    const attackerIdentityProvider = `sso:${attackerExternalProviderId}`
    const attackerIdentityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: originalUser, error: originalUserError } = await getSupabaseClient().auth.admin.createUser({
      email: targetEmail,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Merge',
        last_name: 'MismatchOriginal',
      },
    })
    if (originalUserError || !originalUser.user) {
      await pool.end()
      throw originalUserError ?? new Error('Failed to create original password auth user for provider mismatch test')
    }

    const { data: duplicateUser, error: duplicateUserError } = await getSupabaseClient().auth.admin.createUser({
      email: tempSsoEmail,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: 'Merge',
        last_name: 'MismatchDuplicate',
      },
    })
    if (duplicateUserError || !duplicateUser.user) {
      await pool.end()
      throw duplicateUserError ?? new Error('Failed to create duplicate auth user for provider mismatch test')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_merge_mismatch_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      await pool.query(
        `
          insert into public.orgs (id, name, management_email, created_by, customer_id)
          values ($1, $2, $3, $4, $5)
        `,
        [
          managedOrgId,
          `SSO Merge Mismatch Org ${managedOrgId}`,
          `sso-merge-mismatch-${managedOrgId}@capgo.app`,
          USER_ID,
          managedCustomerId,
        ],
      )

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const { error: originalPublicUserError } = await getSupabaseClient().from('users').insert({
        id: originalUser.user.id,
        email: targetEmail,
        first_name: 'Merge',
        last_name: 'MismatchOriginal',
        country: null,
        enable_notifications: true,
        opt_for_newsletters: true,
      })
      if (originalPublicUserError)
        throw originalPublicUserError

      const duplicateAuthHeaders = await getAuthHeadersForCredentials(tempSsoEmail, password)

      await pool.query(
        `
          update auth.users
          set email = $1,
              email_confirmed_at = coalesce(email_confirmed_at, now()),
              is_sso_user = true,
              raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                || jsonb_build_object('provider', $2::text, 'providers', jsonb_build_array($2::text)),
              updated_at = now()
          where id = $3
        `,
        [targetEmail, attackerIdentityProvider, duplicateUser.user.id],
      )

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [attackerIdentityProvider, attackerIdentityProviderId, targetEmail, duplicateUser.user.id],
      )

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: duplicateAuthHeaders,
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(403)
      const responseBody = await response.json() as { error: string }
      expect(responseBody.error).toBe('provider_mismatch')

      const { data: duplicateAuthLookup } = await getSupabaseClient().auth.admin.getUserById(duplicateUser.user.id)
      expect(duplicateAuthLookup.user?.id).toBe(duplicateUser.user.id)

      const { data: mergedMembership, error: mergedMembershipError } = await getSupabaseClient()
        .from('org_users')
        .select('id')
        .eq('org_id', managedOrgId)
        .eq('user_id', originalUser.user.id)
        .maybeSingle()

      expect(mergedMembershipError).toBeNull()
      expect(mergedMembership).toBeNull()

      const identitiesAfterRejectedMerge = await pool.query(
        'select provider, user_id from auth.identities where provider = $1 and user_id in ($2, $3) order by user_id',
        [attackerIdentityProvider, originalUser.user.id, duplicateUser.user.id],
      )

      expect(identitiesAfterRejectedMerge.rows).toEqual([
        {
          provider: attackerIdentityProvider,
          user_id: duplicateUser.user.id,
        },
      ])
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(duplicateUser.user.id),
        getSupabaseClient().auth.admin.deleteUser(originalUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
      await pool.end()
    }
  })

  it('creates the public.users row before linking a first-time SSO user to the org', async () => {
    const managedOrgId = randomUUID()
    const managedCustomerId = `cus_sso_first_login_${randomUUID()}`
    const providerId = randomUUID()
    const externalProviderId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `first-login-user@${domain}`
    const password = 'testtest'
    const identityProvider = `sso:${externalProviderId}`
    const identityProviderId = `nameid-${randomUUID()}`
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        provider: identityProvider,
      },
      user_metadata: {
        first_name: 'First',
        last_name: 'Login',
      },
    })
    if (createUserError || !createdUser.user) {
      await pool.end()
      throw createUserError ?? new Error('Failed to create first-login SSO auth user')
    }

    try {
      const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
        customer_id: managedCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_sso_first_login_${randomUUID()}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      })
      if (stripeError)
        throw stripeError

      const { error: orgError } = await getSupabaseClient().from('orgs').insert({
        id: managedOrgId,
        name: `SSO First Login Org ${managedOrgId}`,
        management_email: `sso-first-login-${managedOrgId}@capgo.app`,
        created_by: USER_ID,
        customer_id: managedCustomerId,
      })
      if (orgError)
        throw orgError

      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: managedOrgId,
        domain,
        provider_id: externalProviderId,
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      await pool.query(
        'update auth.identities set provider = $1, provider_id = $2, identity_data = jsonb_build_object($$sub$$, $2::text, $$email$$, $3::text, $$email_verified$$, true) where user_id = $4',
        [identityProvider, identityProviderId, email, createdUser.user.id],
      )

      const ssoAuthHeaders = await getAuthHeadersForCredentials(email, password)
      const supabase = getSupabaseClient()
      const { data: existingPublicUser, error: existingPublicUserError } = await supabase
        .from('users')
        .select('id')
        .eq('id', createdUser.user.id)
        .maybeSingle()

      expect(existingPublicUserError).toBeNull()

      if (existingPublicUser) {
        const { error: deletePublicUserError } = await supabase
          .from('users')
          .delete()
          .eq('id', createdUser.user.id)

        expect(deletePublicUserError).toBeNull()
      }

      const { data: missingPublicUser, error: missingPublicUserError } = await supabase
        .from('users')
        .select('id')
        .eq('id', createdUser.user.id)
        .maybeSingle()

      expect(missingPublicUserError).toBeNull()
      expect(missingPublicUser).toBeNull()

      const response = await fetchTestRequest(getEndpointUrl('/private/sso/provision-user'), {
        method: 'POST',
        headers: ssoAuthHeaders,
        body: JSON.stringify({}),
      })

      const responseBody = await response.json() as {
        success: boolean
      }
      expect(response.status).toBe(200)
      expect(responseBody).toMatchObject({ success: true })

      const { data: publicUser, error: publicUserError } = await getSupabaseClient()
        .from('users')
        .select('id, email, first_name, last_name')
        .eq('id', createdUser.user.id)
        .single()

      expect(publicUserError).toBeNull()
      expect(publicUser).toMatchObject({
        id: createdUser.user.id,
        email,
        first_name: 'First',
        last_name: 'Login',
      })

      const { data: membership, error: membershipError } = await getSupabaseClient()
        .from('org_users')
        .select('id, org_id, user_id, rbac_role_name')
        .eq('org_id', managedOrgId)
        .eq('user_id', createdUser.user.id)
        .maybeSingle()

      expect(membershipError).toBeNull()
      expect(membership).toMatchObject({
        org_id: managedOrgId,
        user_id: createdUser.user.id,
        rbac_role_name: 'org_member',
      })
    }
    finally {
      await Promise.allSettled([
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().from('orgs').delete().eq('id', managedOrgId),
        getSupabaseClient().from('stripe_info').delete().eq('customer_id', managedCustomerId),
      ])
      await pool.end()
    }
  })
})

describe('[GET] /private/sso/providers/:orgId', () => {
  it('should return empty array for org with no SSO providers', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/sso/providers/${SSO_TEST_ORG_ID}`), {
      method: 'GET',
      headers: authHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as unknown[]
    expect(Array.isArray(data)).toBe(true)
    expect(data).toHaveLength(0)
  })

  it('should return 401 without authentication', async () => {
    const response = await fetchTestRequest(getEndpointUrl(`/private/sso/providers/${SSO_TEST_ORG_ID}`), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // No Authorization header
      },
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('no_jwt_apikey_or_subkey')
  })
})

describe('[PATCH] /private/sso/providers/:id', () => {
  it('syncs auth.users.is_sso_user when enforce_sso is toggled', async () => {
    const providerId = randomUUID()
    const domain = `${randomUUID()}.sso.test`
    const email = `toggle-user-${randomUUID()}@${domain}`
    const password = 'testtest'
    const pool = new Pool({ connectionString: POSTGRES_URL })

    const { data: createdUser, error: createUserError } = await getSupabaseClient().auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createUserError || !createdUser.user) {
      await pool.end()
      throw createUserError ?? new Error('Failed to create auth user for provider enforcement sync test')
    }

    try {
      const { error: providerError } = await (getSupabaseClient().from as any)('sso_providers').insert({
        id: providerId,
        org_id: SSO_TEST_ORG_ID,
        domain,
        provider_id: randomUUID(),
        status: 'active',
        enforce_sso: false,
        dns_verification_token: `dns-${randomUUID()}`,
      })
      if (providerError)
        throw providerError

      const initialUser = await pool.query<{ is_sso_user: boolean }>(
        'select is_sso_user from auth.users where id = $1',
        [createdUser.user.id],
      )
      expect(initialUser.rows[0]?.is_sso_user).toBe(false)

      const enableResponse = await fetchTestRequest(getEndpointUrl(`/private/sso/providers/${providerId}`), {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ enforce_sso: true }),
      })

      expect(enableResponse.status).toBe(200)
      const enabledProvider = await enableResponse.json() as { enforce_sso: boolean }
      expect(enabledProvider.enforce_sso).toBe(true)

      const enabledUser = await pool.query<{ is_sso_user: boolean }>(
        'select is_sso_user from auth.users where id = $1',
        [createdUser.user.id],
      )
      expect(enabledUser.rows[0]?.is_sso_user).toBe(true)

      const disableResponse = await fetchTestRequest(getEndpointUrl(`/private/sso/providers/${providerId}`), {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ enforce_sso: false }),
      })

      expect(disableResponse.status).toBe(200)
      const disabledProvider = await disableResponse.json() as { enforce_sso: boolean }
      expect(disabledProvider.enforce_sso).toBe(false)

      const disabledUser = await pool.query<{ is_sso_user: boolean }>(
        'select is_sso_user from auth.users where id = $1',
        [createdUser.user.id],
      )
      expect(disabledUser.rows[0]?.is_sso_user).toBe(false)
    }
    finally {
      await Promise.allSettled([
        (getSupabaseClient().from as any)('sso_providers').delete().eq('id', providerId),
        getSupabaseClient().auth.admin.deleteUser(createdUser.user.id),
        pool.end(),
      ])
    }
  })
})
