import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BASE_URL,
  executeSQL,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  USER_PASSWORD,
} from './test-utils.ts'

const TEST_ID = randomUUID()
const ORG_ID = randomUUID()
const OTHER_ORG_ID = randomUUID()
const OWNER_EMAIL = `shared-key-owner-${TEST_ID}@capgo.app`
const ADMIN_EMAIL = `shared-key-admin-${TEST_ID}@capgo.app`
const MANAGER_EMAIL = `shared-key-manager-${TEST_ID}@capgo.app`
const MEMBER_EMAIL = `shared-key-member-${TEST_ID}@capgo.app`

let ownerUserId: string
let adminUserId: string
let managerUserId: string
let memberUserId: string
let adminHeaders: Record<string, string>
let managerHeaders: Record<string, string>
let memberHeaders: Record<string, string>
let sharedKeyId: number
let sharedKeySecret: string

interface ApiKeyResponse {
  id: number
  key: string | null
  name: string
  owner_org_id: string | null
  user_id: string
  is_hashed_key?: boolean
  key_hash?: string | null
}

async function createConfirmedAuthUser(email: string) {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: USER_PASSWORD,
    email_confirm: true,
  })
  if (error || !data.user)
    throw error ?? new Error(`Failed to create auth user for ${email}`)

  const { error: userError } = await supabase.from('users').insert({ id: data.user.id, email })
  if (userError)
    throw userError

  return data.user.id
}

function apiRequest(path: string, headers: Record<string, string>, init: { method?: string, body?: unknown } = {}) {
  return fetch(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
}

function orgMemberBinding(orgId = ORG_ID) {
  return { role_name: 'org_member', scope_type: 'org', org_id: orgId }
}

beforeAll(async () => {
  const supabase = getSupabaseClient()
  ownerUserId = await createConfirmedAuthUser(OWNER_EMAIL)
  adminUserId = await createConfirmedAuthUser(ADMIN_EMAIL)
  managerUserId = await createConfirmedAuthUser(MANAGER_EMAIL)
  memberUserId = await createConfirmedAuthUser(MEMBER_EMAIL)

  for (const [id, name] of [[ORG_ID, 'Shared key org'], [OTHER_ORG_ID, 'Shared key other org']] as const) {
    const { error } = await supabase.from('orgs').insert({
      id,
      created_by: ownerUserId,
      name: `${name} ${TEST_ID}`,
      management_email: OWNER_EMAIL,
    })
    if (error)
      throw error
  }

  await executeSQL(`
    INSERT INTO public.org_users (org_id, user_id, rbac_role_name, is_invite)
    SELECT principal.org_id, principal.user_id, principal.role_name, false
    FROM (
      VALUES
        ($1::uuid, $3::uuid, public.rbac_role_org_super_admin()),
        ($2::uuid, $3::uuid, public.rbac_role_org_super_admin()),
        ($1::uuid, $4::uuid, public.rbac_role_org_admin()),
        ($2::uuid, $4::uuid, public.rbac_role_org_admin()),
        ($1::uuid, $5::uuid, public.rbac_role_apikey_manager()),
        ($1::uuid, $6::uuid, public.rbac_role_org_member())
    ) AS principal(org_id, user_id, role_name)
    ON CONFLICT DO NOTHING
  `, [ORG_ID, OTHER_ORG_ID, ownerUserId, adminUserId, managerUserId, memberUserId])

  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type, principal_id, role_id, scope_type, org_id, granted_by, reason, is_direct
    )
    SELECT public.rbac_principal_user(), principal.user_id, roles.id, public.rbac_scope_org(), principal.org_id, $3::uuid, 'shared apikey test binding', true
    FROM (
      VALUES
        ($1::uuid, $3::uuid, public.rbac_role_org_super_admin()),
        ($2::uuid, $3::uuid, public.rbac_role_org_super_admin()),
        ($1::uuid, $4::uuid, public.rbac_role_org_admin()),
        ($2::uuid, $4::uuid, public.rbac_role_org_admin()),
        ($1::uuid, $5::uuid, public.rbac_role_apikey_manager()),
        ($1::uuid, $6::uuid, public.rbac_role_org_member())
    ) AS principal(org_id, user_id, role_name)
    JOIN public.roles roles
      ON roles.name = principal.role_name
      AND roles.scope_type = public.rbac_scope_org()
    ON CONFLICT DO NOTHING
  `, [ORG_ID, OTHER_ORG_ID, ownerUserId, adminUserId, managerUserId, memberUserId])

  adminHeaders = await getAuthHeadersForCredentials(ADMIN_EMAIL, USER_PASSWORD)
  managerHeaders = await getAuthHeadersForCredentials(MANAGER_EMAIL, USER_PASSWORD)
  memberHeaders = await getAuthHeadersForCredentials(MEMBER_EMAIL, USER_PASSWORD)
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  await supabase.from('orgs').delete().in('id', [ORG_ID, OTHER_ORG_ID])
  for (const userId of [ownerUserId, adminUserId, managerUserId, memberUserId]) {
    if (userId)
      await supabase.auth.admin.deleteUser(userId)
  }
})

describe('org-owned (shared) API keys', () => {
  it('creates a hashed shared key owned by one org', async () => {
    const response = await apiRequest('/apikey', adminHeaders, {
      method: 'POST',
      body: {
        name: `shared-ci-${TEST_ID.slice(0, 8)}`,
        owner_org_id: ORG_ID,
        bindings: [orgMemberBinding()],
      },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as ApiKeyResponse
    expect(body.owner_org_id).toBe(ORG_ID)
    expect(body.user_id).toBe(adminUserId)
    expect(body.key_hash).toBeTruthy()
    expect(typeof body.key).toBe('string')
    sharedKeyId = body.id
    sharedKeySecret = body.key!
  })

  it('rejects shared keys with bindings outside the owner org', async () => {
    const response = await apiRequest('/apikey', adminHeaders, {
      method: 'POST',
      body: {
        name: 'shared-multi-org',
        owner_org_id: ORG_ID,
        bindings: [orgMemberBinding(), orgMemberBinding(OTHER_ORG_ID)],
      },
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'shared_apikey_single_org' })
  })

  it('rejects shared keys from callers without org.manage_apikeys', async () => {
    const response = await apiRequest('/apikey', memberHeaders, {
      method: 'POST',
      body: {
        name: 'shared-by-member',
        owner_org_id: ORG_ID,
        bindings: [orgMemberBinding()],
      },
    })
    expect(response.status).toBe(403)
  })

  it('lists the shared key for org key managers but not for members', async () => {
    const managerResponse = await apiRequest('/apikey?shared=true', managerHeaders)
    expect(managerResponse.status).toBe(200)
    const managerKeys = await managerResponse.json() as ApiKeyResponse[]
    expect(managerKeys.map(key => key.id)).toContain(sharedKeyId)
    expect(managerKeys.every(key => key.owner_org_id !== null)).toBe(true)

    const personalResponse = await apiRequest('/apikey?shared=false', managerHeaders)
    const personalKeys = await personalResponse.json() as ApiKeyResponse[]
    expect(personalKeys.map(key => key.id)).not.toContain(sharedKeyId)

    const memberResponse = await apiRequest('/apikey', memberHeaders)
    expect(memberResponse.status).toBe(200)
    const memberKeys = await memberResponse.json() as ApiKeyResponse[]
    expect(memberKeys.map(key => key.id)).not.toContain(sharedKeyId)
  })

  it('authenticates requests with the shared key', async () => {
    const response = await apiRequest('/organization', { capgkey: sharedKeySecret })
    expect(response.status).toBe(200)
  })

  it('does not let a lower-privileged key manager take over the key by regenerating it', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, managerHeaders, {
      method: 'PUT',
      body: { regenerate: true },
    })
    expect(response.status).toBe(403)

    const stillWorks = await apiRequest('/organization', { capgkey: sharedKeySecret })
    expect(stillWorks.status).toBe(200)
  })

  it('lets an admin holding every key permission regenerate the shared key', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, adminHeaders, {
      method: 'PUT',
      body: { regenerate: true },
    })
    expect(response.status).toBe(200)
    const body = await response.json() as ApiKeyResponse
    expect(typeof body.key).toBe('string')
    expect(body.key).not.toBe(sharedKeySecret)

    const oldKey = await apiRequest('/organization', { capgkey: sharedKeySecret })
    expect(oldKey.status).toBe(401)
    sharedKeySecret = body.key!
  })

  it('lets a key manager rename the shared key', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, managerHeaders, {
      method: 'PUT',
      body: { name: `renamed-${TEST_ID.slice(0, 8)}` },
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ owner_org_id: ORG_ID })
  })

  it('rejects rebinding the shared key to another org', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, adminHeaders, {
      method: 'PUT',
      body: { bindings: [orgMemberBinding(OTHER_ORG_ID)] },
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: 'shared_apikey_single_org' })
  })

  it('requires channel allow-overrides of the shared key before regenerating it', async () => {
    const supabase = getSupabaseClient()
    const appId = `com.shared.key.override.${TEST_ID.slice(0, 8)}`
    const { error: appError } = await supabase.from('apps').insert({
      app_id: appId,
      owner_org: ORG_ID,
      icon_url: 'shared-key-override-icon',
      name: 'Shared key override app',
      user_id: ownerUserId,
    })
    expect(appError).toBeNull()
    const { data: version, error: versionError } = await supabase
      .from('app_versions')
      .insert({ app_id: appId, name: '1.0.0', owner_org: ORG_ID, user_id: ownerUserId, storage_provider: 'r2', deleted: false })
      .select('id')
      .single()
    expect(versionError).toBeNull()
    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .insert({ app_id: appId, name: 'override-channel', version: version!.id, owner_org: ORG_ID, created_by: ownerUserId, public: false })
      .select('id')
      .single()
    expect(channelError).toBeNull()

    // The key gets promote on this channel through an allow-override; the admin
    // is explicitly denied promote there, so regenerating would escalate.
    await executeSQL(`
      INSERT INTO public.channel_permission_overrides (principal_type, principal_id, channel_id, permission_key, is_allowed)
      SELECT public.rbac_principal_apikey(), a.rbac_id, $2::bigint, 'channel.promote_bundle', true FROM public.apikeys a WHERE a.id = $1
      UNION ALL
      SELECT public.rbac_principal_user(), $3::uuid, $2::bigint, 'channel.promote_bundle', false
    `, [sharedKeyId, channel!.id, adminUserId])

    try {
      const response = await apiRequest(`/apikey/${sharedKeyId}`, adminHeaders, {
        method: 'PUT',
        body: { regenerate: true },
      })
      expect(response.status).toBe(403)
      await expect(response.text()).resolves.toContain('channel.promote_bundle')
    }
    finally {
      await executeSQL('DELETE FROM public.channel_permission_overrides WHERE channel_id = $1', [channel!.id])
      await supabase.from('channels').delete().eq('app_id', appId)
      await supabase.from('app_versions').delete().eq('app_id', appId)
      await supabase.from('apps').delete().eq('app_id', appId)
    }
  })

  it('does not let a plain member manage the shared key', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, memberHeaders, { method: 'DELETE' })
    expect(response.status).toBe(404)
  })

  it('keeps working with unchanged privileges after its creator leaves the org', async () => {
    const before = await executeSQL(`
      SELECT count(*)::int AS count FROM public.role_bindings rb
      JOIN public.apikeys a ON a.rbac_id = rb.principal_id
      WHERE rb.principal_type = public.rbac_principal_apikey() AND a.id = $1
    `, [sharedKeyId])

    await executeSQL('DELETE FROM public.org_users WHERE org_id = $1 AND user_id = $2', [ORG_ID, adminUserId])

    const after = await executeSQL(`
      SELECT a.user_id::text AS user_id, count(rb.id)::int AS count
      FROM public.apikeys a
      LEFT JOIN public.role_bindings rb ON rb.principal_id = a.rbac_id AND rb.principal_type = public.rbac_principal_apikey()
      WHERE a.id = $1
      GROUP BY a.user_id
    `, [sharedKeyId])
    expect(after[0]?.user_id).toBe(ownerUserId)
    expect(after[0]?.count).toBe(before[0]?.count)

    const stillWorks = await apiRequest('/organization', { capgkey: sharedKeySecret })
    expect(stillWorks.status).toBe(200)
  })

  it('records shared key changes in the owner org audit log with the real actor', async () => {
    const rows = await executeSQL<{ operation: string, actor_type: string, actor_user_id: string | null, has_secret: boolean }>(`
      SELECT operation, actor_type, actor_user_id::text AS actor_user_id,
        (COALESCE(new_record, '{}'::jsonb) ? 'key_hash') OR (COALESCE(old_record, '{}'::jsonb) ? 'key_hash') AS has_secret
      FROM public.audit_logs
      WHERE org_id = $1 AND table_name = 'apikeys' AND record_id = $2
      ORDER BY id
    `, [ORG_ID, String(sharedKeyId)])

    expect(rows.find(row => row.operation === 'INSERT')).toMatchObject({ actor_type: 'user', actor_user_id: adminUserId })
    expect(rows.some(row => row.operation === 'UPDATE' && row.actor_user_id === managerUserId)).toBe(true)
    expect(rows.some(row => row.operation === 'UPDATE' && row.actor_user_id === adminUserId)).toBe(true)
    expect(rows.every(row => !row.has_secret)).toBe(true)

    const bindingRows = await executeSQL<{ role_name: string }>(`
      SELECT new_record->>'role_name' AS role_name
      FROM public.audit_logs
      WHERE org_id = $1 AND table_name = 'role_bindings' AND record_id = $2 AND operation = 'INSERT'
    `, [ORG_ID, String(sharedKeyId)])
    expect(bindingRows.map(row => row.role_name)).toContain('org_member')
  })

  it('lets a key manager delete the shared key', async () => {
    const response = await apiRequest(`/apikey/${sharedKeyId}`, managerHeaders, { method: 'DELETE' })
    expect(response.status).toBe(200)

    const revoked = await apiRequest('/organization', { capgkey: sharedKeySecret })
    expect(revoked.status).toBe(401)

    const deleted = await executeSQL<{ actor_user_id: string }>(`
      SELECT actor_user_id::text AS actor_user_id
      FROM public.audit_logs
      WHERE org_id = $1 AND table_name = 'apikeys' AND record_id = $2 AND operation = 'DELETE'
    `, [ORG_ID, String(sharedKeyId)])
    expect(deleted.map(row => row.actor_user_id)).toContain(managerUserId)
  })
})
