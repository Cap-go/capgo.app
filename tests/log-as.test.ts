import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, ORG_ID_2, USER_ADMIN_EMAIL, USER_ID, USER_ID_2, USER_ID_STATS } from './test-utils.ts'

let adminHeaders: Record<string, string>

function getJwtSub(jwt: string): string {
  const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as { sub?: string }
  return payload.sub ?? ''
}

async function callLogAs(body: Record<string, string>) {
  const response = await fetch(getEndpointUrl('/private/log_as'), {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify(body),
  })

  const data = await response.json() as { jwt?: string, refreshToken?: string, error?: string }

  expect(response.status).toBe(200)
  expect(data.error).toBeUndefined()
  expect(data.jwt).toBeTruthy()
  expect(data.refreshToken).toBeTruthy()

  return data.jwt!
}

async function seedStaleCreatedByOrg() {
  const supabase = getSupabaseClient()
  const staleCreatedByOrgId = randomUUID()

  const { error: cleanupError } = await supabase
    .from('orgs')
    .delete()
    .eq('id', staleCreatedByOrgId)
  expect(cleanupError).toBeNull()

  const { error: stripeInfoCleanupError } = await supabase
    .from('stripe_info')
    .delete()
    .eq('customer_id', `pending_${staleCreatedByOrgId}`)
  expect(stripeInfoCleanupError).toBeNull()

  const { error: orgError } = await supabase
    .from('orgs')
    .insert({
      id: staleCreatedByOrgId,
      created_by: USER_ID,
      name: `Log as stale created_by org ${staleCreatedByOrgId}`,
      management_email: `log-as-stale-owner-${staleCreatedByOrgId}@capgo.app`,
    })
  expect(orgError).toBeNull()

  const { data: superAdminRole, error: roleError } = await supabase
    .from('roles')
    .select('id')
    .eq('name', 'org_super_admin')
    .eq('scope_type', 'org')
    .single()
  expect(roleError).toBeNull()
  expect(superAdminRole?.id).toBeTruthy()

  const { error: currentAdminError } = await supabase
    .from('role_bindings')
    .insert({
      principal_type: 'user',
      principal_id: USER_ID_2,
      role_id: superAdminRole!.id,
      scope_type: 'org',
      org_id: staleCreatedByOrgId,
      granted_by: USER_ID_2,
    })
  expect(currentAdminError).toBeNull()

  const { error: staleLegacyError } = await supabase
    .from('org_users')
    .delete()
    .eq('org_id', staleCreatedByOrgId)
    .eq('user_id', USER_ID)
  expect(staleLegacyError).toBeNull()

  const { error: staleBindingError } = await supabase
    .from('role_bindings')
    .delete()
    .eq('org_id', staleCreatedByOrgId)
    .eq('principal_id', USER_ID)
  expect(staleBindingError).toBeNull()

  return staleCreatedByOrgId
}

describe('[POST] /private/log_as', () => {
  beforeAll(async () => {
    adminHeaders = await getAuthHeadersForCredentials(USER_ADMIN_EMAIL, 'adminadmin')
  })

  it('keeps user_id impersonation compatibility', async () => {
    const jwt = await callLogAs({ user_id: USER_ID })

    expect(getJwtSub(jwt)).toBe(USER_ID)
  })

  it('impersonates a user by auth email', async () => {
    const jwt = await callLogAs({ identifier: 'stats@capgo.app' })

    expect(getJwtSub(jwt)).toBe(USER_ID_STATS)
  })

  it('impersonates an organization owner by org id', async () => {
    const jwt = await callLogAs({ org_id: ORG_ID_2 })

    expect(getJwtSub(jwt)).toBe(USER_ID_2)
  })

  it('impersonates a current organization owner when created_by is stale', async () => {
    const staleCreatedByOrgId = await seedStaleCreatedByOrg()

    const jwt = await callLogAs({ org_id: staleCreatedByOrgId })

    expect(getJwtSub(jwt)).toBe(USER_ID_2)
  })

  it('treats an unresolved UUID identifier as an organization id', async () => {
    const jwt = await callLogAs({ identifier: ORG_ID_2 })

    expect(getJwtSub(jwt)).toBe(USER_ID_2)
  })
})
