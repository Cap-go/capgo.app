import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseSchema, safeParseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'

import {
  BASE_URL,
  createDirectApiKeyWithBindings,
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  normalizeLocalhostUrl,
  orgApiKeyBindings,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  TEST_EMAIL,
  USER_ADMIN_EMAIL,
  USER_EMAIL,
  USER_EMAIL_NONMEMBER,
  USER_ID,
  USER_ID_2,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const normalizedSupabaseBaseUrl = normalizeLocalhostUrl(SUPABASE_BASE_URL) ?? SUPABASE_BASE_URL

const ORG_ID = randomUUID()
const globalId = randomUUID()
const name = `Test Organization ${globalId}`
const customerId = `cus_test_${ORG_ID}`
const website = 'https://test-organization.example/'
let headers: Record<string, string>
let authHeaders: Record<string, string>
let organizationApiKeyId = 0

beforeAll(async () => {
  authHeaders = await getAuthHeaders()

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
    website,
  })
  if (error)
    throw error

  const createdKey = await createDirectApiKeyWithBindings({
    userId: USER_ID,
    key: randomUUID(),
    name: `Organization API suite ${randomUUID()}`,
    orgId: ORG_ID,
    roleName: 'org_super_admin',
  })
  if (!createdKey?.key || typeof createdKey.id !== 'number') {
    throw new Error('Failed to seed organization API key')
  }
  organizationApiKeyId = createdKey.id
  headers = {
    'Content-Type': 'application/json',
    'capgkey': createdKey.key,
  }
})

async function createUserOrgBinding(orgId: string, userId: string, roleName = 'org_member', grantedBy = USER_ID) {
  const { data: role, error: roleError } = await getSupabaseClient()
    .from('roles')
    .select('id')
    .eq('name', roleName)
    .eq('scope_type', 'org')
    .single()
  if (roleError)
    throw roleError

  const { error: bindingError } = await getSupabaseClient()
    .from('role_bindings')
    .insert({
      principal_type: 'user',
      principal_id: userId,
      role_id: role!.id,
      scope_type: 'org',
      org_id: orgId,
      granted_by: grantedBy,
      reason: 'Test RBAC binding',
      is_direct: true,
    })
  if (bindingError && bindingError.code !== '23505')
    throw bindingError
}

afterAll(async () => {
  // Clean up test organization, org_users relation, and stripe_info
  if (organizationApiKeyId) {
    await getSupabaseClient().from('apikeys').delete().eq('id', organizationApiKeyId)
  }
  await getSupabaseClient().from('orgs').delete().eq('id', ORG_ID)
  await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
})

describe('read-only API keys cannot access destructive organization routes', () => {
  const readOnlyOrgId = randomUUID()
  const readOnlyGlobalId = randomUUID()
  const readOnlyName = `Test Read-Only Organization ${readOnlyGlobalId}`
  const readOnlyCustomerId = `cus_test_${readOnlyOrgId}`
  let readOnlyKey = ''
  let readOnlyKeyId = 0
  const readOnlyHeaders = {
    'Content-Type': 'application/json',
  }

  beforeAll(async () => {
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: readOnlyCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${readOnlyGlobalId}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(stripeError).toBeNull()

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: readOnlyOrgId,
      name: readOnlyName,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      customer_id: readOnlyCustomerId,
      require_apikey_expiration: false,
    })
    expect(orgError).toBeNull()

    const createdKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Organization read-only regression ${randomUUID()}`,
      orgId: readOnlyOrgId,
      roleName: 'org_member',
    })
    expect(createdKey?.id).toBeTypeOf('number')
    expect(createdKey?.key).toBeTypeOf('string')
    if (!createdKey?.key || typeof createdKey.id !== 'number') {
      throw new Error('Failed to seed read-only API key')
    }

    readOnlyKey = createdKey.key
    readOnlyKeyId = createdKey.id
  })

  afterAll(async () => {
    if (readOnlyKeyId) {
      await getSupabaseClient().from('apikeys').delete().eq('id', readOnlyKeyId)
    }
    await getSupabaseClient().from('orgs').delete().eq('id', readOnlyOrgId)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', readOnlyCustomerId)
  })

  it.concurrent('rejects POST /organization/members', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'POST',
      body: JSON.stringify({
        orgId: readOnlyOrgId,
        email: USER_ADMIN_EMAIL,
        invite_type: 'org_member',
      }),
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')
  })

  it.concurrent('rejects DELETE /organization/members', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${readOnlyOrgId}&email=${USER_ADMIN_EMAIL}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'DELETE',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')
  })

  it.concurrent('rejects PUT /organization', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'PUT',
      body: JSON.stringify({
        orgId: readOnlyOrgId,
        name: `Blocked update ${randomUUID()}`,
      }),
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')
  })

  it.concurrent('rejects POST /organization without org.create permission', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'POST',
      body: JSON.stringify({
        orgId: readOnlyOrgId,
        name: `Blocked create ${randomUUID()}`,
      }),
    })

    expect(response.status).toBe(403)
    const payload = await response.json() as { error?: string }
    expect(payload.error).toBe('permission_denied')
  })

  it.concurrent('rejects DELETE /organization', async () => {
    const response = await fetch(`${BASE_URL}/organization?orgId=${readOnlyOrgId}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'DELETE',
    })

    expect(response.status).toBe(403)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('invalid_org_id')
  })

  it.concurrent('allows GET /organization for accessible organizations', async () => {
    const response = await fetch(`${BASE_URL}/organization?orgId=${readOnlyOrgId}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'GET',
    })

    expect(response.status).toBe(200)
    const responseType = z.object({ id: z.string(), name: z.string() })
    expect(parseSchema(responseType, await response.json())).toEqual(expect.objectContaining({ id: readOnlyOrgId, name: readOnlyName }))
  })

  it.concurrent('allows GET /organization/members for accessible organizations', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${readOnlyOrgId}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'GET',
    })

    expect(response.status).toBe(200)
    const members = z.array(z.object({
      uid: z.string(),
      email: z.string(),
      role: z.string(),
    }))
    expect(parseSchema(members, await response.json()).some(member => member.uid === USER_ID)).toBe(true)
  })

  it.concurrent('allows GET /organization/members for same user without org scope limits', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers,
      method: 'GET',
    })

    expect(response.status).toBe(200)
    const members = z.array(z.object({
      uid: z.string(),
      email: z.string(),
      role: z.string(),
    }))
    expect(parseSchema(members, await response.json()).some(member => member.uid === USER_ID)).toBe(true)
  })

  it.concurrent('rejects GET /organization/members outside bound organization scope', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'GET',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')
  })

  it.concurrent('rejects GET /organization/audit without audit-log permission', async () => {
    const response = await fetch(`${BASE_URL}/organization/audit?orgId=${readOnlyOrgId}`, {
      headers: { ...readOnlyHeaders, capgkey: readOnlyKey },
      method: 'GET',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('invalid_org_id')
  })
})

describe('scoped write API keys cannot cross organization boundaries', () => {
  const allowedOrgId = randomUUID()
  const targetOrgId = randomUUID()
  const targetOrgName = `Scoped target ${randomUUID()}`
  const targetCustomerId = `cus_scope_target_${randomUUID()}`
  const scopedKeyName = `Scoped org write ${randomUUID()}`
  const imagePath = `org/${targetOrgId}/scope-bypass-${randomUUID()}.txt`
  let scopedKey = ''
  let scopedKeyId = 0

  beforeAll(async () => {
    // Seed private fixtures through Postgres so parallel Cloudflare tests do not
    // compete for PostgREST connections before exercising the worker routes.
    await executeSQL(
      `INSERT INTO public.stripe_info (customer_id, status, product_id, subscription_id, trial_at, is_good_plan)
       VALUES ($1, 'succeeded', 'prod_LQIregjtNduh4q', $2, $3, true)`,
      [targetCustomerId, `sub_${randomUUID()}`, new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString()],
    )

    await executeSQL(
      `INSERT INTO public.orgs (id, name, management_email, created_by)
       VALUES ($1::uuid, $2, $3, $4::uuid)`,
      [allowedOrgId, `Scoped allowed ${randomUUID()}`, TEST_EMAIL, USER_ID],
    )

    await executeSQL(
      `INSERT INTO public.orgs (id, name, management_email, created_by, customer_id)
       VALUES ($1::uuid, $2, $3, $4::uuid, $5)`,
      [targetOrgId, targetOrgName, TEST_EMAIL, USER_ID, targetCustomerId],
    )

    const createdKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: scopedKeyName,
      orgId: allowedOrgId,
      roleName: 'org_admin',
    })
    expect(createdKey?.key).toBeTruthy()
    expect(createdKey?.id).toBeTypeOf('number')

    if (!createdKey?.key || typeof createdKey.id !== 'number') {
      throw new Error('Failed to create scoped write API key')
    }

    scopedKey = createdKey.key
    scopedKeyId = createdKey.id

    const imageContent = new Blob(['scope bypass regression'], { type: 'text/plain' })
    const { error: uploadError } = await getSupabaseClient()
      .storage
      .from('images')
      .upload(imagePath, imageContent, {
        contentType: 'text/plain',
        upsert: true,
      })

    expect(uploadError).toBeNull()
  })

  afterAll(async () => {
    if (scopedKeyId) {
      await getSupabaseClient().from('apikeys').delete().eq('id', scopedKeyId)
    }

    await getSupabaseClient().storage.from('images').remove([imagePath])
    await getSupabaseClient().from('role_bindings').delete().eq('org_id', allowedOrgId)
    await getSupabaseClient().from('role_bindings').delete().eq('org_id', targetOrgId)
    await getSupabaseClient().from('org_users').delete().eq('org_id', allowedOrgId)
    await getSupabaseClient().from('org_users').delete().eq('org_id', targetOrgId)
    await getSupabaseClient().from('orgs').delete().eq('id', allowedOrgId)
    await getSupabaseClient().from('orgs').delete().eq('id', targetOrgId)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', targetCustomerId)
  })

  it.concurrent('rejects DELETE /organization outside bound organization scope without deleting images', async () => {
    const response = await fetch(`${BASE_URL}/organization?orgId=${targetOrgId}`, {
      headers: {
        'Content-Type': 'application/json',
        'capgkey': scopedKey,
      },
      method: 'DELETE',
    })

    expect(response.status).toBe(403)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('invalid_org_id')

    const { data: targetOrg, error: targetOrgError } = await getSupabaseClient()
      .from('orgs')
      .select('id')
      .eq('id', targetOrgId)
      .maybeSingle()

    expect(targetOrgError).toBeNull()
    expect(targetOrg?.id).toBe(targetOrgId)

    const { data: imageList, error: imageError } = await getSupabaseClient()
      .storage
      .from('images')
      .list(`org/${targetOrgId}`)

    expect(imageError).toBeNull()
    expect(imageList?.some(file => file.name === imagePath.split('/').at(-1))).toBe(true)
  })

  it.concurrent('rejects DELETE /organization/members outside bound organization scope without deleting role bindings', async () => {
    const setupKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Scoped target setup ${randomUUID()}`,
      orgId: targetOrgId,
      roleName: 'org_super_admin',
    })
    if (!setupKey?.key || typeof setupKey.id !== 'number')
      throw new Error('Failed to seed scoped setup API key')
    const setupHeaders = {
      'Content-Type': 'application/json',
      'capgkey': setupKey.key,
    }

    const addMemberResponse = await fetch(`${BASE_URL}/organization/members`, {
      headers: setupHeaders,
      method: 'POST',
      body: JSON.stringify({
        orgId: targetOrgId,
        email: USER_ADMIN_EMAIL,
        invite_type: 'org_member',
      }),
    })
    expect(addMemberResponse.status).toBe(200)

    const { data: userData, error: userError } = await getSupabaseClient().from('users').select('id').eq('email', USER_ADMIN_EMAIL).single()
    expect(userError).toBeNull()
    expect(userData?.id).toBeTruthy()

    const { data: bindingsBefore, error: bindingsBeforeError } = await getSupabaseClient()
      .from('role_bindings')
      .select('id')
      .eq('principal_type', 'user')
      .eq('principal_id', userData!.id)
      .eq('org_id', targetOrgId)

    expect(bindingsBeforeError).toBeNull()
    expect(bindingsBefore!.length).toBeGreaterThan(0)

    const response = await fetch(`${BASE_URL}/organization/members?orgId=${targetOrgId}&email=${USER_ADMIN_EMAIL}`, {
      headers: {
        'Content-Type': 'application/json',
        'capgkey': scopedKey,
      },
      method: 'DELETE',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')

    const { data: membershipAfter, error: membershipAfterError } = await getSupabaseClient()
      .from('org_users')
      .select('org_id, user_id')
      .eq('org_id', targetOrgId)
      .eq('user_id', userData!.id)
      .maybeSingle()

    expect(membershipAfterError).toBeNull()
    expect(membershipAfter?.org_id).toBe(targetOrgId)

    const { data: bindingsAfter, error: bindingsAfterError } = await getSupabaseClient()
      .from('role_bindings')
      .select('id')
      .eq('principal_type', 'user')
      .eq('principal_id', userData!.id)
      .eq('org_id', targetOrgId)

    expect(bindingsAfterError).toBeNull()
    expect(bindingsAfter!.length).toBeGreaterThan(0)

    await getSupabaseClient().from('org_users').delete().eq('org_id', targetOrgId).eq('user_id', userData!.id)
    await getSupabaseClient().from('apikeys').delete().eq('id', setupKey.id)
  })
})

describe('x-limited-key-id subkeys enforce organization scope on middlewareKey routes', () => {
  const scopedOrgId = randomUUID()
  const blockedOrgId = randomUUID()
  const scopedCustomerId = `cus_scoped_${scopedOrgId}`
  const blockedCustomerId = `cus_blocked_${blockedOrgId}`
  let parentKey = ''
  let parentKeyId = 0
  let scopedSubkeyId = 0

  beforeAll(async () => {
    const supabase = getSupabaseClient()

    const { error: scopedStripeError } = await supabase.from('stripe_info').insert({
      customer_id: scopedCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${randomUUID()}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(scopedStripeError).toBeNull()

    const { error: blockedStripeError } = await supabase.from('stripe_info').insert({
      customer_id: blockedCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${randomUUID()}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(blockedStripeError).toBeNull()

    const { error: orgError } = await supabase.from('orgs').insert([
      {
        id: scopedOrgId,
        name: `Scoped org ${randomUUID()}`,
        management_email: TEST_EMAIL,
        created_by: USER_ID,
        customer_id: scopedCustomerId,
      },
      {
        id: blockedOrgId,
        name: `Blocked org ${randomUUID()}`,
        management_email: TEST_EMAIL,
        created_by: USER_ID,
        customer_id: blockedCustomerId,
      },
    ])
    expect(orgError).toBeNull()

    const parentKeyData = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Parent key ${randomUUID()}`,
      orgId: scopedOrgId,
      roleName: 'org_admin',
    })
    if (!parentKeyData?.key || typeof parentKeyData.id !== 'number') {
      throw new TypeError('Failed to seed parent API key')
    }
    parentKey = parentKeyData.key
    parentKeyId = parentKeyData.id

    const { data: orgAdminRole, error: orgAdminRoleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'org_admin')
      .single()
    expect(orgAdminRoleError).toBeNull()
    if (!orgAdminRole?.id)
      throw new TypeError('Failed to resolve org_admin role')

    const { error: parentBlockedBindingError } = await supabase.from('role_bindings').insert({
      principal_type: 'apikey',
      principal_id: parentKeyData.rbac_id,
      role_id: orgAdminRole.id,
      scope_type: 'org',
      org_id: blockedOrgId,
      granted_by: USER_ID,
      reason: 'Organization middleware parent key test binding',
      is_direct: true,
    })
    expect(parentBlockedBindingError).toBeNull()

    const subkeyData = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Scoped subkey ${randomUUID()}`,
      orgId: scopedOrgId,
      roleName: 'org_member',
    })
    if (typeof subkeyData?.id !== 'number') {
      throw new TypeError('Failed to seed scoped subkey')
    }
    scopedSubkeyId = subkeyData.id
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()

    if (scopedSubkeyId) {
      await supabase.from('apikeys').delete().eq('id', scopedSubkeyId)
    }
    if (parentKeyId) {
      await supabase.from('apikeys').delete().eq('id', parentKeyId)
    }

    await supabase.from('org_users').delete().in('org_id', [scopedOrgId, blockedOrgId])
    await supabase.from('orgs').delete().in('id', [scopedOrgId, blockedOrgId])
    await supabase.from('stripe_info').delete().in('customer_id', [scopedCustomerId, blockedCustomerId])
  })

  it.concurrent('limits GET /organization to the subkey org', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: {
        'Content-Type': 'application/json',
        'authorization': parentKey,
        'x-limited-key-id': String(scopedSubkeyId),
      },
      method: 'GET',
    })

    expect(response.status).toBe(200)
    const orgListSchema = z.array(z.object({ id: z.string(), name: z.string() }))
    const payload = parseSchema(orgListSchema, await response.json())
    expect(payload.map(org => org.id)).toEqual([scopedOrgId])
  })

  it.concurrent('rejects GET /organization/members outside the subkey org scope', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${blockedOrgId}`, {
      headers: {
        'Content-Type': 'application/json',
        'authorization': parentKey,
        'x-limited-key-id': String(scopedSubkeyId),
      },
      method: 'GET',
    })

    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')
  })
})

describe('API key organization creation', () => {
  it.concurrent('allows a key with org.create to create an organization and auto-binds that key', async () => {
    const createKeyValue = randomUUID()
    const createKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: createKeyValue,
      name: `Organization create key ${randomUUID()}`,
      orgId: ORG_ID,
      roleName: 'org_admin',
    })
    if (!createKey?.key || !createKey.rbac_id || typeof createKey.id !== 'number') {
      throw new Error('Failed to seed organization create API key')
    }

    await executeSQL(
      `INSERT INTO public.apikey_global_permissions (
         apikey_rbac_id,
         permission_key,
         granted_by,
         reason
       )
       VALUES ($1::uuid, public.rbac_perm_org_create(), $2::uuid, 'Test org.create grant')
       ON CONFLICT DO NOTHING`,
      [createKey.rbac_id, USER_ID],
    )

    let createdOrgId: string | undefined
    try {
      const response = await fetch(`${BASE_URL}/organization`, {
        headers: {
          'Content-Type': 'application/json',
          'capgkey': createKey.key,
        },
        method: 'POST',
        body: JSON.stringify({
          name: `API Key Created Org ${randomUUID()}`,
          website: 'https://created-by-apikey.example',
        }),
      })

      expect(response.status).toBe(200)
      const responseType = z.object({ id: z.uuid() })
      const payload = parseSchema(responseType, await response.json())
      createdOrgId = payload.id

      const bindingRows = await executeSQL(
        `SELECT rb.id
         FROM public.role_bindings rb
         JOIN public.roles r ON r.id = rb.role_id
         WHERE rb.principal_type = public.rbac_principal_apikey()
           AND rb.principal_id = $1::uuid
           AND rb.scope_type = public.rbac_scope_org()
           AND rb.org_id = $2::uuid
           AND r.name = public.rbac_role_org_super_admin()`,
        [createKey.rbac_id, createdOrgId],
      )
      expect(bindingRows.length).toBe(1)

      const getResponse = await fetch(`${BASE_URL}/organization?orgId=${createdOrgId}`, {
        headers: {
          'Content-Type': 'application/json',
          'capgkey': createKey.key,
        },
        method: 'GET',
      })
      expect(getResponse.status).toBe(200)
      const createdOrg = await getResponse.json() as { id: string, website: string | null }
      expect(createdOrg.id).toBe(createdOrgId)
      expect(createdOrg.website).toBe('https://created-by-apikey.example/')

      const auditRows = await executeSQL(
        `SELECT id
         FROM public.audit_logs
         WHERE table_name = 'orgs'
           AND operation = 'INSERT'
           AND org_id = $1::uuid
           AND record_id = $1::text
           AND user_id = $2::uuid`,
        [createdOrgId, USER_ID],
      )
      expect(auditRows.length).toBe(1)
    }
    finally {
      if (createdOrgId) {
        await getSupabaseClient().from('org_users').delete().eq('org_id', createdOrgId)
        await getSupabaseClient().from('orgs').delete().eq('id', createdOrgId)
        await getSupabaseClient().from('stripe_info').delete().eq('customer_id', `pending_${createdOrgId}`)
      }
      await getSupabaseClient().from('apikeys').delete().eq('id', createKey.id)
    }
  })

  it.concurrent('rejects org.create when the key was downgraded after the global grant', async () => {
    const createKeyValue = randomUUID()
    const createKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: createKeyValue,
      name: `Organization create stale grant key ${randomUUID()}`,
      orgId: ORG_ID,
      roleName: 'org_admin',
    })
    if (!createKey?.key || !createKey.rbac_id || typeof createKey.id !== 'number') {
      throw new Error('Failed to seed stale organization create API key')
    }

    try {
      await executeSQL(
        `INSERT INTO public.apikey_global_permissions (
           apikey_rbac_id,
           permission_key,
           granted_by,
           reason
         )
         VALUES ($1::uuid, public.rbac_perm_org_create(), $2::uuid, 'Test stale org.create grant')
         ON CONFLICT DO NOTHING`,
        [createKey.rbac_id, USER_ID],
      )

      const grantRows = await executeSQL(
        `SELECT 1
         FROM public.apikey_global_permissions
         WHERE apikey_rbac_id = $1::uuid
           AND permission_key = public.rbac_perm_org_create()`,
        [createKey.rbac_id],
      )
      expect(grantRows.length).toBe(1)

      const [readOnlyRole] = await executeSQL(
        `SELECT id
         FROM public.roles
         WHERE name = public.rbac_role_org_member()
           AND scope_type = public.rbac_scope_org()
         LIMIT 1`,
      )
      if (!readOnlyRole?.id) {
        throw new Error('Unable to resolve org_member role')
      }

      await executeSQL(
        `DELETE FROM public.role_bindings
         WHERE principal_type = public.rbac_principal_apikey()
           AND principal_id = $1::uuid`,
        [createKey.rbac_id],
      )
      await executeSQL(
        `INSERT INTO public.role_bindings (
           principal_type,
           principal_id,
           role_id,
           scope_type,
           org_id,
           granted_by,
           reason,
           is_direct
         )
         VALUES (
           public.rbac_principal_apikey(),
           $1::uuid,
           $2::uuid,
           public.rbac_scope_org(),
           $3::uuid,
           $4::uuid,
           'Test downgraded API key binding',
           true
         )`,
        [createKey.rbac_id, readOnlyRole.id, ORG_ID, USER_ID],
      )

      const response = await fetch(`${BASE_URL}/organization`, {
        headers: {
          'Content-Type': 'application/json',
          'capgkey': createKey.key,
        },
        method: 'POST',
        body: JSON.stringify({
          name: `Blocked stale grant org ${randomUUID()}`,
        }),
      })

      expect(response.status).toBe(403)
      const payload = await response.json() as { error?: string }
      expect(payload.error).toBe('permission_denied')
    }
    finally {
      await getSupabaseClient().from('apikeys').delete().eq('id', createKey.id)
    }
  })

  it.concurrent('rejects org.create for app-scoped admin keys even with the global grant', async () => {
    const createKeyValue = randomUUID()
    const appId = `com.org-create-app-scope.${randomUUID()}`
    const createKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: createKeyValue,
      name: `Organization create app-scoped key ${randomUUID()}`,
      orgId: ORG_ID,
      roleName: 'org_member',
    })
    if (!createKey?.key || !createKey.rbac_id || typeof createKey.id !== 'number') {
      throw new Error('Failed to seed app-scoped organization create API key')
    }

    try {
      await executeSQL(
        `INSERT INTO public.apikey_global_permissions (
           apikey_rbac_id,
           permission_key,
           granted_by,
           reason
         )
         VALUES ($1::uuid, public.rbac_perm_org_create(), $2::uuid, 'Test app-scoped org.create grant')
         ON CONFLICT DO NOTHING`,
        [createKey.rbac_id, USER_ID],
      )

      await executeSQL(
        `DELETE FROM public.role_bindings
         WHERE principal_type = public.rbac_principal_apikey()
           AND principal_id = $1::uuid
           AND scope_type = public.rbac_scope_org()`,
        [createKey.rbac_id],
      )

      const { error: appError } = await getSupabaseClient().from('apps').insert({
        app_id: appId,
        name: `Organization create app-scope fixture ${randomUUID()}`,
        icon_url: 'https://example.com/icon.png',
        owner_org: ORG_ID,
      })
      if (appError) {
        throw appError
      }

      const [appScopedRole] = await executeSQL(
        `SELECT roles.id AS role_id, apps.id AS app_id
         FROM public.roles
         JOIN public.apps ON apps.app_id = $1::varchar
         WHERE roles.name = public.rbac_role_app_admin()
           AND roles.scope_type = public.rbac_scope_app()
           AND apps.owner_org = $2::uuid
         LIMIT 1`,
        [appId, ORG_ID],
      )
      if (!appScopedRole?.role_id || !appScopedRole.app_id) {
        throw new Error('Unable to resolve app-scoped admin binding data')
      }

      await executeSQL(
        `INSERT INTO public.role_bindings (
           principal_type,
           principal_id,
           role_id,
           scope_type,
           org_id,
           app_id,
           granted_by,
           reason,
           is_direct
         )
         VALUES (
           public.rbac_principal_apikey(),
           $1::uuid,
           $2::uuid,
           public.rbac_scope_app(),
           $3::uuid,
           $4::uuid,
           $5::uuid,
           'Test app-scoped API key binding',
           true
         )`,
        [createKey.rbac_id, appScopedRole.role_id, ORG_ID, appScopedRole.app_id, USER_ID],
      )

      const response = await fetch(`${BASE_URL}/organization`, {
        headers: {
          'Content-Type': 'application/json',
          'capgkey': createKey.key,
        },
        method: 'POST',
        body: JSON.stringify({
          name: `Blocked app-scoped grant org ${randomUUID()}`,
        }),
      })

      expect(response.status).toBe(403)
      const payload = await response.json() as { error?: string }
      expect(payload.error).toBe('permission_denied')
    }
    finally {
      await getSupabaseClient().from('apikeys').delete().eq('id', createKey.id)
      await getSupabaseClient().from('apps').delete().eq('app_id', appId)
    }
  })
})

describe('[GET] /organization', () => {
  it('get organization', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
    })
    expect(response.status).toBe(200)
    const responseType = z.array(z.object({ id: z.string(), name: z.string() }))
    expect(parseSchema(responseType, await response.json()).length).toBeGreaterThan(0)
  })

  it('get organization by id', async () => {
    const response = await fetch(`${BASE_URL}/organization?orgId=${ORG_ID}`, {
      headers,
    })
    expect(response.status).toBe(200)
    const responseType = z.object({ id: z.string(), name: z.string(), website: z.string().nullable() })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data).toEqual(expect.objectContaining({ id: ORG_ID, name, website }))
  })

  it('get organization with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/organization?orgId=${invalidOrgId}`, {
      headers,
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_org_id')
  })
})

describe('[GET] /organization/members', () => {
  it('get organization members', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers,
    })
    expect(response.status).toBe(200)
    const responseType = z.array(z.object({
      uid: z.string(),
      email: z.string(),
      image_url: z.string(),
      role: z.string(),
    }))
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data.length).toBeGreaterThanOrEqual(1)

    const testUser = safe.data.find(m => m.uid === USER_ID)
    expect(testUser).toBeTruthy()
    expect(testUser?.email).toBe(USER_EMAIL)
    expect(testUser?.role).toBe('org_super_admin')
  })

  it('get organization members with missing orgId', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers,
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('get organization members with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${invalidOrgId}`, {
      headers,
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('cannot_access_organization')
  })

  it('get organization members includes pending invitations (tmp_users)', async () => {
    const testEmail = `pending-invite-${randomUUID()}@test.com`

    // Insert a pending invitation directly into tmp_users
    const { error: insertError } = await getSupabaseClient().from('tmp_users').insert({
      email: testEmail,
      org_id: ORG_ID,
      rbac_role_name: 'org_admin',
      first_name: 'Test',
      last_name: 'User',
    })
    expect(insertError).toBeNull()

    // Fetch members via API
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers,
    })
    expect(response.status).toBe(200)

    const members = await response.json() as Array<{
      uid: string
      email: string
      role: string
      is_tmp?: boolean
    }>

    // Find the pending invitation
    const pendingMember = members.find(m => m.email === testEmail)
    expect(pendingMember).toBeTruthy()
    expect(pendingMember?.is_tmp).toBe(true)
    expect(pendingMember?.role).toBe('org_admin')

    // Cleanup
    await getSupabaseClient().from('tmp_users').delete().eq('email', testEmail).eq('org_id', ORG_ID)
  })

  it('get organization members excludes cancelled pending invitations', async () => {
    const testEmail = `cancelled-invite-${randomUUID()}@test.com`

    // Insert a cancelled pending invitation
    const { error: insertError } = await getSupabaseClient().from('tmp_users').insert({
      email: testEmail,
      org_id: ORG_ID,
      rbac_role_name: 'org_admin',
      first_name: 'Cancelled',
      last_name: 'User',
      cancelled_at: new Date().toISOString(),
    })
    expect(insertError).toBeNull()

    // Fetch members via API
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers,
    })
    expect(response.status).toBe(200)

    const members = await response.json() as Array<{
      uid: string
      email: string
      role: string
      is_tmp?: boolean
    }>

    // The cancelled invitation should NOT be in the list
    const cancelledMember = members.find(m => m.email === testEmail)
    expect(cancelledMember).toBeUndefined()

    // Cleanup
    await getSupabaseClient().from('tmp_users').delete().eq('email', testEmail).eq('org_id', ORG_ID)
  })

  it('get organization members excludes expired pending invitations (older than 7 days)', async () => {
    const testEmail = `expired-invite-${randomUUID()}@test.com`

    // Insert an expired pending invitation (8 days ago)
    const expiredDate = new Date()
    expiredDate.setDate(expiredDate.getDate() - 8)

    const { error: insertError } = await getSupabaseClient().from('tmp_users').insert({
      email: testEmail,
      org_id: ORG_ID,
      rbac_role_name: 'org_member',
      first_name: 'Expired',
      last_name: 'User',
      created_at: expiredDate.toISOString(),
      updated_at: expiredDate.toISOString(),
    })
    expect(insertError).toBeNull()

    // Fetch members via API
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}`, {
      headers,
    })
    expect(response.status).toBe(200)

    const members = await response.json() as Array<{
      uid: string
      email: string
      role: string
      is_tmp?: boolean
    }>

    // The expired invitation should NOT be in the list
    const expiredMember = members.find(m => m.email === testEmail)
    expect(expiredMember).toBeUndefined()

    // Cleanup
    await getSupabaseClient().from('tmp_users').delete().eq('email', testEmail).eq('org_id', ORG_ID)
  })
})

describe('[POST] /organization/members', () => {
  it('add organization member', async () => {
    if (!normalizedSupabaseBaseUrl || !SUPABASE_ANON_KEY)
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for this test')

    let invitedUserId: string | undefined
    const inviteeSupabase = createClient(normalizedSupabaseBaseUrl, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })

    try {
      const response = await fetch(`${BASE_URL}/organization/members`, {
        headers,
        method: 'POST',
        body: JSON.stringify({
          orgId: ORG_ID,
          email: USER_ADMIN_EMAIL,
          invite_type: 'org_member',
        }),
      })

      const responseData = await response.json()
      expect(response.status).toBe(200)
      const responseType = z.object({
        status: z.string(),
      })
      const safe = safeParseSchema(responseType, responseData)
      expect(safe.success).toBe(true)
      if (!safe.success)
        throw safe.error
      expect(safe.data.status).toBe('ok')

      const { data: userData, error: userError } = await getSupabaseClient().from('users').select().eq('email', USER_ADMIN_EMAIL).single()
      expect(userError).toBeNull()
      expect(userData).toBeTruthy()
      expect(userData?.email).toBe(USER_ADMIN_EMAIL)
      invitedUserId = userData!.id

      const { data, error } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID).eq('user_id', invitedUserId).single()
      expect(error).toBeNull()
      expect(data).toBeTruthy()
      expect(data?.org_id).toBe(ORG_ID)
      expect(data?.rbac_role_name).toBe('org_member')
      expect(data?.is_invite).toBe(true)

      const { error: signInError } = await inviteeSupabase.auth.signInWithPassword({
        email: USER_ADMIN_EMAIL,
        password: 'adminadmin',
      })
      expect(signInError).toBeNull()

      const { data: invitedOrgs, error: invitedOrgsError } = await inviteeSupabase.rpc('get_orgs_v7')
      expect(invitedOrgsError).toBeNull()
      const invitedOrg = invitedOrgs?.find((org: { gid: string }) => org.gid === ORG_ID)
      expect(invitedOrg).toBeTruthy()
      expect(invitedOrg?.is_invite).toBe(true)
      expect(invitedOrg?.role).toBe('org_member')
    }
    finally {
      await inviteeSupabase.auth.signOut()
      if (invitedUserId) {
        await getSupabaseClient().from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', invitedUserId).eq('org_id', ORG_ID)
        await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID).eq('user_id', invitedUserId)
      }
    }
  })

  it('add organization member with invalid body', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers,
      method: 'POST',
      body: JSON.stringify({}), // Missing required fields
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_json_parse_body')
  })

  it('add organization member with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        orgId: invalidOrgId,
        email: USER_ADMIN_EMAIL,
        invite_type: 'org_member',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('cannot_access_organization')
  })

  it('add organization member with missing email', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers,
      method: 'POST',
      body: JSON.stringify({
        orgId: ORG_ID,
        invite_type: 'org_member',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })
})

describe('[DELETE] /organization/members', () => {
  it('delete organization member', async () => {
    const { data: userData, error: userError } = await getSupabaseClient().from('users').select().eq('email', USER_ADMIN_EMAIL).single()
    expect(userError).toBeNull()
    expect(userData).toBeTruthy()
    expect(userData?.email).toBe(USER_ADMIN_EMAIL)

    const { error } = await getSupabaseClient().from('org_users').insert({
      org_id: ORG_ID,
      user_id: userData!.id,
      rbac_role_name: 'org_member',
    })
    expect(error).toBeNull()

    await createUserOrgBinding(ORG_ID, userData!.id, 'org_member')

    const { data: rbacData, error: rbacFetchError } = await getSupabaseClient()
      .from('role_bindings')
      .select()
      .eq('principal_type', 'user')
      .eq('principal_id', userData!.id)
      .eq('org_id', ORG_ID)
    expect(rbacFetchError).toBeNull()
    expect(rbacData).toBeTruthy()
    expect(rbacData!.length).toBeGreaterThan(0)

    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}&email=${USER_ADMIN_EMAIL}`, {
      headers,
      method: 'DELETE',
    })
    expect(response.status).toBe(200)
    const responseType = z.object({
      status: z.string(),
    })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data.status).toBe('ok')

    const { data, error: orgUserError } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID).eq('user_id', userData!.id).single()
    expect(orgUserError).toBeTruthy()
    expect(data).toBeNull()

    // Verify role_bindings were also cleaned up
    const { data: rbacDataAfterDelete } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID)
    expect(rbacDataAfterDelete).toHaveLength(0)
  })

  it('delete organization member with invalid body', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers,
      method: 'DELETE',
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_json_parse_body')
  })

  it('delete organization member with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${invalidOrgId}&email=${USER_ADMIN_EMAIL}`, {
      headers,
      method: 'DELETE',
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('cannot_access_organization')
  })

  it('delete organization member with non-existent email', async () => {
    const nonExistentEmail = `nonexistent-${randomUUID()}@example.com`
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID}&email=${nonExistentEmail}`, {
      headers,
      method: 'DELETE',
    })
    expect(response.status).toBe(404)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('user_not_found')
  })
})

describe('[POST] /organization', () => {
  async function expectCreatedOrganizationPlan(estimatedMau: number, planName: string) {
    const name = `Created ${planName} Plan Organization ${randomUUID()}`
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({ name, estimatedMau }),
    })
    expect(response.status).toBe(200)
    const responseType = z.object({
      id: z.uuid(),
    })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error

    let customerId: string | null = null

    try {
      const { data: expectedPlan, error: planError } = await getSupabaseClient()
        .from('plans')
        .select('stripe_id')
        .eq('name', planName)
        .single()
      expect(planError).toBeNull()

      const { data: org, error: orgError } = await getSupabaseClient()
        .from('orgs')
        .select('customer_id')
        .eq('id', safe.data.id)
        .single()
      expect(orgError).toBeNull()
      customerId = org?.customer_id ?? null
      expect(customerId).toBeTruthy()

      const { data: stripeInfo, error: stripeError } = await getSupabaseClient()
        .from('stripe_info')
        .select('product_id')
        .eq('customer_id', customerId!)
        .single()
      expect(stripeError).toBeNull()
      expect(stripeInfo?.product_id).toBe(expectedPlan?.stripe_id)
    }
    finally {
      await getSupabaseClient().from('orgs').delete().eq('id', safe.data.id)
      if (customerId)
        await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
    }
  }

  it('create organization', async () => {
    const name = `Created Organization ${new Date().toISOString()}`
    const website = 'HTTPS://capgo.app'
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({ name, website }),
    })
    expect(response.status).toBe(200)
    const responseType = z.object({
      id: z.uuid(),
    })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data.id).toBeDefined()

    try {
      const { data, error } = await getSupabaseClient().from('orgs').select().eq('id', safe.data.id).single()
      expect(error).toBeNull()
      expect(data).toBeTruthy()
      expect(data?.name).toBe(name)
      expect(data?.website).toBe('https://capgo.app/')
    }
    finally {
      await getSupabaseClient().from('orgs').delete().eq('id', safe.data.id)
    }
  })

  it('create organization with missing name', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({}), // Missing name
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_json_parse_body')
  })

  it('create organization with invalid body format', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: 'invalid json', // Invalid JSON
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })

  it('create organization with empty name', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({ name: '' }), // Empty name
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('create organization rejects invalid website scheme', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({
        name: `Created Organization ${new Date().toISOString()}`,
        website: 'ftp://capgo.app',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('create organization rejects credential-bearing website urls', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({
        name: `Created Organization ${new Date().toISOString()}`,
        website: 'https://user:pass@capgo.app',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it('create organization uses the estimated active users to choose the initial plan', async () => {
    await expectCreatedOrganizationPlan(100000, 'Team')
  })

  it('create organization keeps Solo through 2K active users', async () => {
    await expectCreatedOrganizationPlan(2000, 'Solo')
  })

  it('create organization moves above the Solo active user limit to Maker', async () => {
    await expectCreatedOrganizationPlan(2001, 'Maker')
  })

  it('create organization rejects an estimated active user count above the largest plan stop', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({
        name: `Created Organization ${randomUUID()}`,
        estimatedMau: 1000001,
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })
})

describe('[PUT] /organization', () => {
  it.concurrent('update organization', async () => {
    const orgId = randomUUID()
    const originalName = `Update Base Organization ${new Date().toISOString()}`
    const name = `Updated Organization ${new Date().toISOString()}`
    const website = 'https://www.capgo.app/docs'
    const { error: createError } = await getSupabaseClient().from('orgs').insert({
      id: orgId,
      name: originalName,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      website: 'https://base.example/',
    })
    if (createError)
      throw createError

    try {
      const response = await fetch(`${BASE_URL}/organization`, {
        headers: authHeaders,
        method: 'PUT',
        body: JSON.stringify({ orgId, name, website }),
      })
      expect(response.status).toBe(200)
      const responseType = z.object({
        id: z.uuid(),
        data: z.unknown(),
      })
      const safe = safeParseSchema(responseType, await response.json())
      expect(safe.success).toBe(true)
      if (!safe.success)
        throw safe.error
      expect(safe.data.id).toBe(orgId)

      const { data, error } = await getSupabaseClient().from('orgs').select().eq('id', orgId).single()
      expect(error).toBeNull()
      expect(data).toBeTruthy()
      expect(data?.name).toBe(name)
      expect(data?.website).toBe(website)
    }
    finally {
      await getSupabaseClient().from('orgs').delete().eq('id', orgId)
    }
  })

  it('update organization with invalid body', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({}), // Missing required fields
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_json_parse_body')
  })

  it('update organization with invalid orgId', async () => {
    const invalidOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({ orgId: invalidOrgId, name: 'New Name' }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('cannot_access_organization')
  })

  it('update organization with missing orgId', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({ name: 'New Name' }), // Missing orgId
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it.concurrent('update organization rejects invalid website scheme', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        name: `Updated Organization ${new Date().toISOString()}`,
        website: 'ftp://www.capgo.app/docs',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })

  it.concurrent('update organization rejects credential-bearing website urls', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        name: `Updated Organization ${new Date().toISOString()}`,
        website: 'https://user:pass@www.capgo.app/docs',
      }),
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })
})

describe('[DELETE] /organization', () => {
  it('delete organization successfully', async () => {
    const id = randomUUID()
    const customerId = `cus_test_${id}`
    const startDate = '2026-01-01'
    const endDate = '2026-01-31'

    // Create stripe_info for this test org
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: customerId,
      status: 'succeeded',
      subscription_id: `sub_${id}`,
      product_id: 'prod_LQIregjtNduh4q',
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(stripeError).toBeNull()

    const { error } = await getSupabaseClient().from('orgs').insert({
      id,
      name: `Test Organization ${new Date().toISOString()}`,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
      customer_id: customerId,
    })
    expect(error).toBeNull()

    const { data: dataOrg, error: errorOrg } = await getSupabaseClient().from('orgs').select().eq('id', id).single()
    expect(errorOrg).toBeNull()
    expect(dataOrg).toBeTruthy()

    const { error: metricsCacheError } = await getSupabaseClient().from('org_metrics_cache').insert({
      org_id: id,
      start_date: startDate,
      end_date: endDate,
      mau: 1,
      storage: 2,
      bandwidth: 3,
      build_time_unit: 4,
      get: 5,
      fail: 6,
      install: 7,
      uninstall: 8,
    })
    expect(metricsCacheError).toBeNull()

    const deleteKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Delete org key ${randomUUID()}`,
      orgId: id,
      roleName: 'org_super_admin',
    })
    if (!deleteKey?.key || typeof deleteKey.id !== 'number')
      throw new Error('Failed to seed delete organization API key')
    const deleteHeaders = {
      'Content-Type': 'application/json',
      'capgkey': deleteKey.key,
    }

    const response = await fetch(`${BASE_URL}/organization?orgId=${id}`, {
      headers: deleteHeaders,
      method: 'DELETE',
    })
    expect(response.status).toBe(200)
    const responseData = await response.json() as { status: string }
    expect(responseData.status).toBe('ok')

    const { data: dataOrg2, error: errorOrg2 } = await getSupabaseClient().from('orgs').select().eq('id', id).single()
    expect(errorOrg2).toBeTruthy()
    expect(dataOrg2).toBeNull()

    const { data: cachedMetrics, error: cachedMetricsError } = await getSupabaseClient()
      .from('org_metrics_cache')
      .select('org_id')
      .eq('org_id', id)
      .maybeSingle()
    expect(cachedMetricsError).toBeNull()
    expect(cachedMetrics).toBeNull()

    await getSupabaseClient().from('apikeys').delete().eq('id', deleteKey.id)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
  })

  it('delete organization with missing orgId', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'DELETE',
    })
    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_json_parse_body')
  })

  it('fail to delete non-existent organization', async () => {
    const nonExistentId = randomUUID()

    const response = await fetch(`${BASE_URL}/organization?orgId=${nonExistentId}`, {
      headers,
      method: 'DELETE',
    })

    // Should return error as the organization doesn't exist
    expect(response.status).toBeGreaterThanOrEqual(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).not.toBe('Organization deleted')
  })

  it('fail to delete organization not owned by user', async () => {
    // First, get an existing user that's not our test user
    const { data: anotherUser, error: userError } = await getSupabaseClient()
      .from('users')
      .select('id')
      .neq('id', USER_ID)
      .limit(1)
      .single()

    expect(userError).toBeNull()
    expect(anotherUser).toBeTruthy()

    // Skip the test if we couldn't find another user
    if (!anotherUser) {
      console.warn('Skipping test: Could not find another user to use as owner')
      return
    }

    // Create organization with a different owner
    const id = randomUUID()
    const differentOwnerId = anotherUser.id
    const customerId = `cus_test_${id}`

    // Create stripe_info for this test org
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: customerId,
      status: 'succeeded',
      subscription_id: `sub_${id}`,
      product_id: 'prod_LQIregjtNduh4q',
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(stripeError).toBeNull()

    const { error } = await getSupabaseClient().from('orgs').insert({
      id,
      name: `Organization Not Owned ${new Date().toISOString()}`,
      management_email: `not-owned-${id}@example.com`,
      created_by: differentOwnerId, // Use an existing user ID
      customer_id: customerId,
    })
    expect(error).toBeNull()

    // Verify organization was created
    const { data: dataOrg, error: errorOrg } = await getSupabaseClient().from('orgs').select().eq('id', id).single()
    expect(errorOrg).toBeNull()
    expect(dataOrg).toBeTruthy()

    if (dataOrg) {
      expect(dataOrg.created_by).toBe(differentOwnerId)
    }

    // Add test user as a member but not owner
    const { error: memberError } = await getSupabaseClient().from('org_users').insert({
      org_id: id,
      user_id: USER_ID,
      rbac_role_name: 'org_admin', // Even with admin rights, shouldn't be able to delete
    })
    expect(memberError).toBeNull()

    const orgAdminKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `Non-owner org key ${randomUUID()}`,
      orgId: id,
      roleName: 'org_admin',
    })
    if (!orgAdminKey?.key || typeof orgAdminKey.id !== 'number')
      throw new Error('Failed to seed non-owner organization API key')
    const orgAdminHeaders = {
      'Content-Type': 'application/json',
      'capgkey': orgAdminKey.key,
    }

    // Try to delete the organization
    const response = await fetch(`${BASE_URL}/organization?orgId=${id}`, {
      headers: orgAdminHeaders,
      method: 'DELETE',
    })

    // Should be forbidden since the user isn't the owner
    expect(response.status).toBe(403)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_org_id')

    // Verify the organization still exists
    const { data: dataOrgAfter, error: errorOrgAfter } = await getSupabaseClient().from('orgs').select().eq('id', id).single()
    expect(errorOrgAfter).toBeNull()
    expect(dataOrgAfter).toBeTruthy()

    // Clean up
    await getSupabaseClient().from('apikeys').delete().eq('id', orgAdminKey.id)
    await getSupabaseClient().from('orgs').delete().eq('id', id)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', customerId)
  })
})

describe('[PUT] /organization - encrypted bundles settings', () => {
  afterAll(async () => {
    await getSupabaseClient().from('orgs').update({
      enforce_encrypted_bundles: false,
      required_encryption_key: null,
    }).eq('id', ORG_ID)
  })

  it('updates encrypted bundle enforcement and required key', async () => {
    const requiredEncryptionKey = 'ABCDEFGHIJKLMNOPQRSTU'

    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        enforce_encrypted_bundles: true,
        required_encryption_key: requiredEncryptionKey,
      }),
    })
    expect(response.status).toBe(200)

    const { data, error } = await getSupabaseClient()
      .from('orgs')
      .select('enforce_encrypted_bundles, required_encryption_key')
      .eq('id', ORG_ID)
      .single()

    expect(error).toBeNull()
    expect(data?.enforce_encrypted_bundles).toBe(true)
    expect(data?.required_encryption_key).toBe(requiredEncryptionKey)
  })

  it('rejects invalid required encryption key length', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: authHeaders,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        required_encryption_key: 'too-short',
      }),
    })

    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_required_encryption_key')
  })
})

describe('[PUT] /organization - password policy settings', () => {
  afterAll(async () => {
    await getSupabaseClient().from('orgs').update({
      password_policy_config: null,
    }).eq('id', ORG_ID)
  })

  it('updates password policy config through the API route', async () => {
    const policyConfig = {
      enabled: true,
      min_length: 12,
      require_uppercase: true,
      require_number: true,
      require_special: true,
    }

    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        password_policy_config: policyConfig,
      }),
    })
    expect(response.status).toBe(200)

    const { data, error } = await getSupabaseClient()
      .from('orgs')
      .select('password_policy_config')
      .eq('id', ORG_ID)
      .single()

    expect(error).toBeNull()
    expect(data?.password_policy_config).toEqual(policyConfig)
  })

  it('rejects invalid password policy lengths before updating the org', async () => {
    const response = await fetch(`${BASE_URL}/organization`, {
      headers,
      method: 'PUT',
      body: JSON.stringify({
        orgId: ORG_ID,
        password_policy_config: {
          enabled: true,
          min_length: 73,
          require_uppercase: true,
          require_number: true,
          require_special: true,
        },
      }),
    })

    expect(response.status).toBe(400)
    const responseData = await response.json() as { error: string }
    expect(responseData.error).toBe('invalid_body')
  })
})

describe('[PUT] /organization - enforce_hashed_api_keys setting', () => {
  const enforceOrgId = randomUUID()
  const enforceGlobalId = randomUUID()
  const enforceCustomerId = `cus_test_${enforceOrgId}`
  const enforceWebsite = 'https://hashed-enforcement.example/'
  let user2AuthHeaders: Record<string, string> | null = null

  beforeAll(async () => {
    const { error: stripeError } = await getSupabaseClient().from('stripe_info').insert({
      customer_id: enforceCustomerId,
      status: 'succeeded',
      product_id: 'prod_LQIregjtNduh4q',
      subscription_id: `sub_${enforceGlobalId}`,
      trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
      is_good_plan: true,
    })
    expect(stripeError).toBeNull()

    const { error: orgError } = await getSupabaseClient().from('orgs').insert({
      id: enforceOrgId,
      name: `Hashed Enforcement Organization ${enforceGlobalId}`,
      management_email: TEST_EMAIL,
      created_by: USER_ID_2,
      customer_id: enforceCustomerId,
      website: enforceWebsite,
    })
    expect(orgError).toBeNull()

    user2AuthHeaders = await getAuthHeadersForCredentials('test2@capgo.app', USER_PASSWORD)
  })

  afterAll(async () => {
    await getSupabaseClient().from('orgs').delete().eq('id', enforceOrgId)
    await getSupabaseClient().from('stripe_info').delete().eq('customer_id', enforceCustomerId)
  })

  it('update organization enforce_hashed_api_keys to true', async () => {
    if (!user2AuthHeaders)
      throw new Error('Missing auth headers for test2@capgo.app')

    // First, ensure it's false
    await getSupabaseClient().from('orgs').update({ enforce_hashed_api_keys: false }).eq('id', enforceOrgId)

    const response = await fetch(`${BASE_URL}/organization`, {
      headers: user2AuthHeaders,
      method: 'PUT',
      body: JSON.stringify({
        orgId: enforceOrgId,
        enforce_hashed_api_keys: true,
      }),
    })
    expect(response.status).toBe(200)
    const responseData = await response.json() as { id: string, data: any }
    expect(responseData.id).toBe(enforceOrgId)

    // Verify the setting was updated
    const { data, error } = await getSupabaseClient().from('orgs').select('enforce_hashed_api_keys').eq('id', enforceOrgId).single()
    expect(error).toBeNull()
    expect(data?.enforce_hashed_api_keys).toBe(true)

    // Reset to false
    await getSupabaseClient().from('orgs').update({ enforce_hashed_api_keys: false }).eq('id', enforceOrgId)
  })

  it('update organization enforce_hashed_api_keys to false', async () => {
    if (!user2AuthHeaders)
      throw new Error('Missing auth headers for test2@capgo.app')

    // First, set it to true
    await getSupabaseClient().from('orgs').update({ enforce_hashed_api_keys: true }).eq('id', enforceOrgId)

    const response = await fetch(`${BASE_URL}/organization`, {
      headers: user2AuthHeaders,
      method: 'PUT',
      body: JSON.stringify({
        orgId: enforceOrgId,
        enforce_hashed_api_keys: false,
      }),
    })
    expect(response.status).toBe(200)
    const responseData = await response.json() as { id: string, data: any }
    expect(responseData.id).toBe(enforceOrgId)

    // Verify the setting was updated
    const { data, error } = await getSupabaseClient().from('orgs').select('enforce_hashed_api_keys').eq('id', enforceOrgId).single()
    expect(error).toBeNull()
    expect(data?.enforce_hashed_api_keys).toBe(false)
  })

  it('get_orgs_v7 returns enforce_hashed_api_keys field', async () => {
    // Set a known value
    const rpcWebsite = enforceWebsite
    const previousWebsite = enforceWebsite
    await getSupabaseClient().from('orgs').update({ enforce_hashed_api_keys: true, website: rpcWebsite }).eq('id', enforceOrgId)

    // Call get_orgs_v7 via RPC
    const { data, error } = await getSupabaseClient().rpc('get_orgs_v7', { userid: USER_ID_2 })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)

    // Find our test org
    const testOrg = data?.find((org: { gid: string }) => org.gid === enforceOrgId)
    expect(testOrg).toBeTruthy()
    expect(testOrg).toHaveProperty('enforce_hashed_api_keys')
    expect(testOrg!.enforce_hashed_api_keys).toBe(true)
    expect(testOrg).toHaveProperty('stats_updated_at')
    expect(testOrg).toHaveProperty('stats_refresh_requested_at')
    expect(testOrg).toHaveProperty('website')
    expect(testOrg!.website).toBe(rpcWebsite)

    // Reset
    await getSupabaseClient().from('orgs').update({ enforce_hashed_api_keys: false, website: previousWebsite }).eq('id', enforceOrgId)
  })

  it.concurrent('get_orgs_v6 exposes only the request-scoped RBAC return shape', async () => {
    const expectedColumns = [
      'gid',
      'created_by',
      'logo',
      'name',
      'role',
      'paying',
      'trial_left',
      'can_use_more',
      'is_canceled',
      'app_count',
      'subscription_start',
      'subscription_end',
      'management_email',
      'is_yearly',
    ]

    const rows = await executeSQL(`
      SELECT overload, array_agg(arg_name ORDER BY ordinality) AS columns
      FROM (
        SELECT 'no_args' AS overload, args.arg_name, args.ordinality
        FROM pg_proc proc
        JOIN LATERAL unnest(proc.proallargtypes, proc.proargmodes, proc.proargnames)
          WITH ORDINALITY AS args(type_oid, arg_mode, arg_name, ordinality) ON true
        WHERE proc.oid = 'public.get_orgs_v6()'::regprocedure
          AND args.arg_mode = 't'
      ) output_args
      GROUP BY overload
      ORDER BY overload
    `)

    expect(rows).toHaveLength(1)
    expect(rows.map((row: { overload: string }) => row.overload)).toEqual(['no_args'])
    for (const row of rows)
      expect(row.columns).toEqual(expectedColumns)
  })

  it.concurrent('rejects public RPC access to get_orgs_v7(userid)', async () => {
    if (!normalizedSupabaseBaseUrl || !SUPABASE_ANON_KEY)
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for this test')

    const publicSupabase = createClient(normalizedSupabaseBaseUrl, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })

    const { data, error } = await publicSupabase.rpc('get_orgs_v7', {
      userid: USER_ID,
    })

    expect(data).toBeNull()
    expect(error?.code).toBe('42501')
  })

  it.concurrent('rejects authenticated RPC access to get_orgs_v7(userid)', async () => {
    if (!normalizedSupabaseBaseUrl || !SUPABASE_ANON_KEY)
      throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY are required for this test')

    const authClient = createClient(normalizedSupabaseBaseUrl, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: false,
      },
    })

    const { error: signInError } = await authClient.auth.signInWithPassword({
      email: USER_EMAIL,
      password: USER_PASSWORD,
    })
    expect(signInError).toBeNull()

    const { data, error } = await authClient.rpc('get_orgs_v7', {
      userid: USER_ID,
    })

    expect(data).toBeNull()
    expect(error?.code).toBe('42501')

    await authClient.auth.signOut()
  })
})

// ─── RBAC Coverage ───────────────────────────────────────────────────────────
// The suite below runs key member operations against a dedicated org so the
// role_bindings permission path is exercised in isolation.

const ORG_ID_RBAC = randomUUID()
const globalIdRbac = randomUUID()
const nameRbac = `RBAC Test Organization ${globalIdRbac}`

describe('rbac mode - organization member operations', () => {
  let rbacHeaders: Record<string, string>
  let rbacApiKeyId = 0

  beforeAll(async () => {
    const { error } = await getSupabaseClient().from('orgs').insert({
      id: ORG_ID_RBAC,
      name: nameRbac,
      management_email: TEST_EMAIL,
      created_by: USER_ID,
    })
    if (error)
      throw error

    // The generate_org_user_on_org_create trigger creates org_users(super_admin)
    // and role_bindings(org_super_admin) for created_by automatically.
    const createdKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `RBAC organization suite ${randomUUID()}`,
      orgId: ORG_ID_RBAC,
      roleName: 'org_super_admin',
    })
    if (!createdKey?.key || typeof createdKey.id !== 'number')
      throw new Error('Failed to seed RBAC organization API key')
    rbacApiKeyId = createdKey.id
    rbacHeaders = {
      'Content-Type': 'application/json',
      'capgkey': createdKey.key,
    }
  })

  afterAll(async () => {
    if (rbacApiKeyId) {
      await getSupabaseClient().from('apikeys').delete().eq('id', rbacApiKeyId)
    }
    await getSupabaseClient().from('orgs').delete().eq('id', ORG_ID_RBAC)
  })

  it('[GET] /organization - get RBAC org by id', async () => {
    const response = await fetch(`${BASE_URL}/organization?orgId=${ORG_ID_RBAC}`, {
      headers: rbacHeaders,
    })
    expect(response.status).toBe(200)
    const responseType = z.object({ id: z.string(), name: z.string() })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data).toEqual(expect.objectContaining({ id: ORG_ID_RBAC, name: nameRbac }))
  })

  it('[GET] /organization/members - returns members via role_bindings (RBAC path)', async () => {
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}`, {
      headers: rbacHeaders,
    })
    expect(response.status).toBe(200)
    const responseType = z.array(z.object({
      uid: z.string(),
      email: z.string(),
      image_url: z.string(),
      role: z.string(),
    }))
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error

    const testUser = safe.data.find(m => m.uid === USER_ID)
    expect(testUser).toBeTruthy()
    expect(testUser?.email).toBe(USER_EMAIL)
    expect(testUser?.role).toBe('org_super_admin')
  })

  it('[PUT] /organization - update RBAC org name', async () => {
    const updatedName = `RBAC Updated ${new Date().toISOString()}`
    const response = await fetch(`${BASE_URL}/organization`, {
      headers: rbacHeaders,
      method: 'PUT',
      body: JSON.stringify({ orgId: ORG_ID_RBAC, name: updatedName }),
    })
    expect(response.status).toBe(200)
    const responseType = z.object({ id: z.uuid(), data: z.unknown() })
    const safe = safeParseSchema(responseType, await response.json())
    expect(safe.success).toBe(true)
    if (!safe.success)
      throw safe.error
    expect(safe.data.id).toBe(ORG_ID_RBAC)
  })

  it('[POST] /organization/members - add member in RBAC mode (sync trigger creates role_binding)', async () => {
    const response = await fetch(`${BASE_URL}/organization/members`, {
      headers: rbacHeaders,
      method: 'POST',
      body: JSON.stringify({
        orgId: ORG_ID_RBAC,
        email: USER_ADMIN_EMAIL,
        invite_type: 'org_member',
      }),
    })
    expect(response.status).toBe(200)

    const { data: userData } = await getSupabaseClient().from('users').select().eq('email', USER_ADMIN_EMAIL).single()
    expect(userData).toBeTruthy()

    // Verify org_users entry exists
    const { data: orgUser } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id).single()
    expect(orgUser).toBeTruthy()
    expect(orgUser?.rbac_role_name).toBe('org_member')
    expect(orgUser?.is_invite).toBe(true)

    // Verify role_binding was created by sync trigger
    const { data: binding } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    expect(binding).toBeTruthy()
    expect(binding!.length).toBeGreaterThan(0)

    // Cleanup
    await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
  })

  it('[DELETE] /organization/members - remove member in RBAC mode cleans up role_bindings', async () => {
    const { data: userData } = await getSupabaseClient().from('users').select().eq('email', USER_ADMIN_EMAIL).single()
    expect(userData).toBeTruthy()

    // Add member metadata and the RBAC binding explicitly.
    await getSupabaseClient().from('org_users').insert({
      org_id: ORG_ID_RBAC,
      user_id: userData!.id,
      rbac_role_name: 'org_member',
    })
    await createUserOrgBinding(ORG_ID_RBAC, userData!.id, 'org_member')

    const { data: bindingsBefore } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    expect(bindingsBefore!.length).toBeGreaterThan(0)

    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}&email=${USER_ADMIN_EMAIL}`, {
      headers: rbacHeaders,
      method: 'DELETE',
    })
    expect(response.status).toBe(200)

    // org_users removed
    const { data: orgUserAfter } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
    expect(orgUserAfter).toHaveLength(0)

    // role_bindings also cleaned up
    const { data: bindingsAfter } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    expect(bindingsAfter).toHaveLength(0)
  })

  it('[DELETE] /organization/members - removes group membership and inherited organization access', async () => {
    const supabase = getSupabaseClient()
    const targetGroupId = randomUUID()
    const { data: targetUser, error: targetUserError } = await supabase
      .from('users')
      .select('id')
      .eq('email', USER_ADMIN_EMAIL)
      .single()
    if (targetUserError || !targetUser)
      throw targetUserError ?? new Error('Expected target user')

    try {
      await supabase.from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', targetUser.id).eq('org_id', ORG_ID_RBAC)
      await supabase.from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', targetUser.id)

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: ORG_ID_RBAC,
        user_id: targetUser.id,
        rbac_role_name: 'org_member',
      })
      expect(memberError).toBeNull()
      await createUserOrgBinding(ORG_ID_RBAC, targetUser.id, 'org_member')

      const { data: orgMemberRole, error: orgMemberRoleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'org_member')
        .eq('scope_type', 'org')
        .single()
      expect(orgMemberRoleError).toBeNull()
      expect(orgMemberRole?.id).toBeTruthy()

      const { error: groupError } = await supabase.from('groups').insert({
        id: targetGroupId,
        org_id: ORG_ID_RBAC,
        name: `Removal access group ${targetGroupId}`,
        description: 'Member removal group membership regression',
        created_by: USER_ID,
      })
      expect(groupError).toBeNull()
      const { error: groupMemberError } = await supabase.from('group_members').insert({
        group_id: targetGroupId,
        user_id: targetUser.id,
        added_by: USER_ID,
      })
      expect(groupMemberError).toBeNull()
      const { error: groupBindingError } = await supabase.from('role_bindings').insert({
        principal_type: 'group',
        principal_id: targetGroupId,
        role_id: orgMemberRole!.id,
        scope_type: 'org',
        org_id: ORG_ID_RBAC,
        granted_by: USER_ID,
        reason: 'Member removal group access regression',
        is_direct: true,
      })
      expect(groupBindingError).toBeNull()

      const { data: accessBefore, error: accessBeforeError } = await supabase.rpc('rbac_check_permission_direct' as any, {
        p_permission_key: 'org.read',
        p_user_id: targetUser.id,
        p_org_id: ORG_ID_RBAC,
        p_app_id: null,
        p_channel_id: null,
        p_apikey: null,
      })
      expect(accessBeforeError).toBeNull()
      expect(accessBefore).toBe(true)

      const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}&email=${USER_ADMIN_EMAIL}`, {
        headers: rbacHeaders,
        method: 'DELETE',
      })
      expect(response.status).toBe(200)

      const { data: groupMembershipAfter, error: groupMembershipAfterError } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('group_id', targetGroupId)
        .eq('user_id', targetUser.id)
      expect(groupMembershipAfterError).toBeNull()
      expect(groupMembershipAfter).toHaveLength(0)

      const { data: accessAfter, error: accessAfterError } = await supabase.rpc('rbac_check_permission_direct' as any, {
        p_permission_key: 'org.read',
        p_user_id: targetUser.id,
        p_org_id: ORG_ID_RBAC,
        p_app_id: null,
        p_channel_id: null,
        p_apikey: null,
      })
      expect(accessAfterError).toBeNull()
      expect(accessAfter).toBe(false)
    }
    finally {
      await supabase.from('role_bindings').delete().eq('principal_type', 'group').eq('principal_id', targetGroupId)
      await supabase.from('group_members').delete().eq('group_id', targetGroupId)
      await supabase.from('groups').delete().eq('id', targetGroupId)
      await supabase.from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', targetUser.id).eq('org_id', ORG_ID_RBAC)
      await supabase.from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', targetUser.id)
    }
  })

  it('[DELETE] /organization/members - lower-priority org admin cannot remove member with a higher group role', async () => {
    const supabase = getSupabaseClient()
    const targetGroupId = randomUUID()
    const { data: targetUser, error: targetUserError } = await supabase
      .from('users')
      .select('id')
      .eq('email', USER_ADMIN_EMAIL)
      .single()
    if (targetUserError || !targetUser)
      throw targetUserError ?? new Error('Expected target user')

    let lowerPriorityKeyId = 0
    let lowerPriorityKeyRbacId = ''
    try {
      await supabase.from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', targetUser.id).eq('org_id', ORG_ID_RBAC)
      await supabase.from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', targetUser.id)

      const { error: memberError } = await supabase.from('org_users').insert({
        org_id: ORG_ID_RBAC,
        user_id: targetUser.id,
        rbac_role_name: 'org_member',
      })
      if (memberError)
        throw memberError
      await createUserOrgBinding(ORG_ID_RBAC, targetUser.id, 'org_member')

      const { error: groupError } = await supabase.from('groups').insert({
        id: targetGroupId,
        org_id: ORG_ID_RBAC,
        name: `Higher-priority member group ${targetGroupId}`,
        description: 'Member removal rank regression',
        created_by: USER_ID,
      })
      if (groupError)
        throw groupError
      const { error: groupMemberError } = await supabase.from('group_members').insert({
        group_id: targetGroupId,
        user_id: targetUser.id,
        added_by: USER_ID,
      })
      if (groupMemberError)
        throw groupMemberError

      const { data: superAdminRole, error: superAdminRoleError } = await supabase
        .from('roles')
        .select('id')
        .eq('name', 'org_super_admin')
        .eq('scope_type', 'org')
        .single()
      if (superAdminRoleError || !superAdminRole)
        throw superAdminRoleError ?? new Error('Expected org_super_admin role')
      const { error: groupBindingError } = await supabase.from('role_bindings').insert({
        principal_type: 'group',
        principal_id: targetGroupId,
        role_id: superAdminRole.id,
        scope_type: 'org',
        org_id: ORG_ID_RBAC,
        granted_by: USER_ID,
        reason: 'Member removal rank regression',
        is_direct: true,
      })
      if (groupBindingError)
        throw groupBindingError

      const lowerPriorityKey = await createDirectApiKeyWithBindings({
        userId: USER_ID,
        key: randomUUID(),
        name: `Lower-priority member removal ${randomUUID()}`,
        orgId: ORG_ID_RBAC,
        roleName: 'org_admin',
      })
      lowerPriorityKeyId = lowerPriorityKey.id
      lowerPriorityKeyRbacId = lowerPriorityKey.rbac_id

      const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}&email=${USER_ADMIN_EMAIL}`, {
        headers: {
          'Content-Type': 'application/json',
          'capgkey': lowerPriorityKey.key!,
        },
        method: 'DELETE',
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual(expect.objectContaining({ error: 'cannot_delete_higher_priority_role' }))

      const { data: memberAfter, error: memberAfterError } = await supabase
        .from('org_users')
        .select('user_id')
        .eq('org_id', ORG_ID_RBAC)
        .eq('user_id', targetUser.id)
        .maybeSingle()
      expect(memberAfterError).toBeNull()
      expect(memberAfter?.user_id).toBe(targetUser.id)

      const { data: groupBindingAfter, error: groupBindingAfterError } = await supabase
        .from('role_bindings')
        .select('id')
        .eq('principal_type', 'group')
        .eq('principal_id', targetGroupId)
        .eq('org_id', ORG_ID_RBAC)
      expect(groupBindingAfterError).toBeNull()
      expect(groupBindingAfter?.length).toBeGreaterThan(0)

      const { data: groupMembershipAfter, error: groupMembershipAfterError } = await supabase
        .from('group_members')
        .select('group_id')
        .eq('group_id', targetGroupId)
        .eq('user_id', targetUser.id)
      expect(groupMembershipAfterError).toBeNull()
      expect(groupMembershipAfter?.length).toBe(1)
    }
    finally {
      if (lowerPriorityKeyRbacId) {
        await supabase.from('role_bindings').delete().eq('principal_type', 'apikey').eq('principal_id', lowerPriorityKeyRbacId)
      }
      if (lowerPriorityKeyId) {
        await supabase.from('apikeys').delete().eq('id', lowerPriorityKeyId)
      }
      await supabase.from('role_bindings').delete().eq('principal_type', 'group').eq('principal_id', targetGroupId)
      await supabase.from('group_members').delete().eq('group_id', targetGroupId)
      await supabase.from('groups').delete().eq('id', targetGroupId)
      await supabase.from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', targetUser.id).eq('org_id', ORG_ID_RBAC)
      await supabase.from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', targetUser.id)
    }
  })

  it('[DELETE] /organization/members - org member can leave self and cleans role_bindings', async () => {
    const { data: userData } = await getSupabaseClient().from('users').select('id').eq('email', USER_EMAIL_NONMEMBER).single()
    expect(userData).toBeTruthy()

    await getSupabaseClient().from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
    await getSupabaseClient().from('org_users').insert({
      org_id: ORG_ID_RBAC,
      user_id: userData!.id,
      rbac_role_name: 'org_member',
    })
    await createUserOrgBinding(ORG_ID_RBAC, userData!.id, 'org_member')

    const memberHeaders = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}&email=${encodeURIComponent(USER_EMAIL_NONMEMBER)}`, {
      headers: memberHeaders,
      method: 'DELETE',
    })
    expect(response.status).toBe(200)

    const { data: orgUserAfter } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
    expect(orgUserAfter).toHaveLength(0)

    const { data: bindingsAfter } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    expect(bindingsAfter).toHaveLength(0)
  })

  it('[DELETE] /organization/members - org member cannot delete another member', async () => {
    const { data: userData } = await getSupabaseClient().from('users').select('id').eq('email', USER_EMAIL_NONMEMBER).single()
    expect(userData).toBeTruthy()

    await getSupabaseClient().from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
    await getSupabaseClient().from('org_users').insert({
      org_id: ORG_ID_RBAC,
      user_id: userData!.id,
      rbac_role_name: 'org_member',
    })
    await createUserOrgBinding(ORG_ID_RBAC, userData!.id, 'org_member')

    const memberHeaders = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)
    const response = await fetch(`${BASE_URL}/organization/members?orgId=${ORG_ID_RBAC}&email=${USER_ADMIN_EMAIL}`, {
      headers: memberHeaders,
      method: 'DELETE',
    })
    expect(response.status).toBe(400)
    const payload = await response.json() as { error: string }
    expect(payload.error).toBe('cannot_access_organization')

    const { data: orgUserAfter } = await getSupabaseClient().from('org_users').select().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
    expect(orgUserAfter).toHaveLength(1)

    const { data: bindingsAfter } = await getSupabaseClient().from('role_bindings').select().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    expect(bindingsAfter!.length).toBeGreaterThan(0)

    await getSupabaseClient().from('role_bindings').delete().eq('principal_type', 'user').eq('principal_id', userData!.id).eq('org_id', ORG_ID_RBAC)
    await getSupabaseClient().from('org_users').delete().eq('org_id', ORG_ID_RBAC).eq('user_id', userData!.id)
  })
})

describe('hashed API key enforcement integration', () => {
  it('find_apikey_by_value finds hashed key', async () => {
    // Create a hashed API key via API
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({
        name: 'test-hashed-key-for-find',
        bindings: orgApiKeyBindings(ORG_ID),
        hashed: true,
      }),
    })
    const createData = await createResponse.json<{ key: string, key_hash: string, id: number }>()
    expect(createResponse.status).toBe(200)
    expect(createData.key).toBeTruthy()
    expect(createData.key_hash).toBeTruthy()

    // Use the plain key to find it via the database function
    const { data, error } = await getSupabaseClient().rpc('find_apikey_by_value', { key_value: createData.key })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect(data!.length).toBe(1)
    expect(data![0].id).toBe(createData.id)
    expect(data![0].key_hash).toBe(createData.key_hash)
    // The key column should be null for hashed keys
    expect(data![0].key).toBeNull()

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      headers: authHeaders,
      method: 'DELETE',
    })
  })

  it('find_apikey_by_value returns empty for non-existent key', async () => {
    const { data, error } = await getSupabaseClient().rpc('find_apikey_by_value', { key_value: 'non-existent-key-abc123' })
    expect(error).toBeNull()
    expect(Array.isArray(data)).toBe(true)
    expect(data!.length).toBe(0)
  })

  it('verify_api_key_hash works correctly', async () => {
    const testKey = 'test-verification-key-xyz'

    // First, get what the hash should be by creating and checking a key
    // The hash is SHA-256 hex encoded
    const { data: hashResult, error: hashError } = await getSupabaseClient().rpc('verify_api_key_hash', {
      plain_key: testKey,
      stored_hash: '4b3c5c3c3b3a3938373635343332313029282726252423222120', // Wrong hash
    })
    expect(hashError).toBeNull()
    expect(hashResult).toBe(false)

    // Calculate correct hash using the function itself
    // We can test this by creating a hashed key and verifying
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      headers: authHeaders,
      method: 'POST',
      body: JSON.stringify({
        name: 'test-verify-hash-key',
        bindings: orgApiKeyBindings(ORG_ID),
        hashed: true,
      }),
    })
    const createData = await createResponse.json<{ key: string, key_hash: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Verify the hash matches the plain key
    const { data: verifyResult, error: verifyError } = await getSupabaseClient().rpc('verify_api_key_hash', {
      plain_key: createData.key,
      stored_hash: createData.key_hash,
    })
    expect(verifyError).toBeNull()
    expect(verifyResult).toBe(true)

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      headers: authHeaders,
      method: 'DELETE',
    })
  })
})
