import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createDirectApiKeyWithBindings,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getEndpointUrl,
  getSupabaseClient,
  SUPABASE_ANON_KEY,
  SUPABASE_BASE_URL,
  USER_ID,
  USER_ID_2,
  USER_PASSWORD,
} from './test-utils.ts'

const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const fixtureId = randomUUID()
const orgId = randomUUID()
const lowRankApiKey = randomUUID()
const highRankApiKey = randomUUID()
const rankGuardError = 'Forbidden - Cannot manage a group with higher privileges than your own'

let adminAuthHeaders: Record<string, string>
let memberAuthHeaders: Record<string, string>
let groupId: string
let lowRankApiKeyId: number | null = null
let highRankApiKeyId: number | null = null

async function getOrgRoleId(roleName: string) {
  const { data: role, error } = await getSupabaseClient()
    .from('roles')
    .select('id')
    .eq('name', roleName)
    .eq('scope_type', 'org')
    .single()

  if (error || !role)
    throw error ?? new Error(`Unable to resolve ${roleName}`)

  return role.id
}

async function createUserOrgBinding(userId: string, roleName: string) {
  const { error } = await getSupabaseClient().from('role_bindings').insert({
    principal_type: 'user',
    principal_id: userId,
    role_id: await getOrgRoleId(roleName),
    scope_type: 'org',
    org_id: orgId,
    granted_by: USER_ID,
    reason: 'Private groups rank regression',
    is_direct: true,
  })

  if (error && error.code !== '23505')
    throw error
}

async function createGroupOrgBinding(groupId: string, roleName: string) {
  const { error } = await getSupabaseClient().from('role_bindings').insert({
    principal_type: 'group',
    principal_id: groupId,
    role_id: await getOrgRoleId(roleName),
    scope_type: 'org',
    org_id: orgId,
    granted_by: USER_ID,
    reason: 'Private groups high-rank regression',
    is_direct: true,
  })

  if (error)
    throw error
}

async function expectRankGuard(response: Response) {
  expect(response.status).toBe(403)
  const body = await response.json() as { error: string }
  expect(body.error).toBe(rankGuardError)
}

async function readGroupRows(headers: Record<string, string>) {
  const [groupsResponse, membersResponse] = await Promise.all([
    fetch(`${SUPABASE_BASE_URL}/rest/v1/groups?id=eq.${groupId}&select=id`, { headers }),
    fetch(`${SUPABASE_BASE_URL}/rest/v1/group_members?group_id=eq.${groupId}&select=user_id`, { headers }),
  ])
  const [groupsBody, membersBody] = await Promise.all([
    groupsResponse.text(),
    membersResponse.text(),
  ])

  expect(groupsResponse.status, groupsBody).toBe(200)
  expect(membersResponse.status, membersBody).toBe(200)
  return {
    groupRows: JSON.parse(groupsBody) as Array<{ id: string }>,
    memberRows: JSON.parse(membersBody) as Array<{ user_id: string }>,
  }
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    return

  adminAuthHeaders = await getAuthHeaders()
  memberAuthHeaders = await getAuthHeadersForCredentials('test2@capgo.app', USER_PASSWORD)

  const supabase = getSupabaseClient()

  const { error: orgError } = await supabase.from('orgs').insert({
    id: orgId,
    created_by: USER_ID,
    name: `Private Groups Access Org ${fixtureId}`,
    management_email: `private-groups-${fixtureId}@capgo.app`,
  })
  if (orgError)
    throw orgError

  await createUserOrgBinding(USER_ID, 'org_super_admin')

  const { error: orgUsersError } = await supabase.from('org_users').insert({
    org_id: orgId,
    user_id: USER_ID_2,
    rbac_role_name: 'org_member',
  })
  if (orgUsersError)
    throw orgUsersError

  await createUserOrgBinding(USER_ID_2, 'org_admin')

  const { data: group, error: groupError } = await supabase
    .from('groups')
    .insert({
      org_id: orgId,
      name: `Private Groups Access ${fixtureId}`,
      description: 'Private API authorization regression',
      created_by: USER_ID,
    })
    .select('id')
    .single()
  if (groupError)
    throw groupError

  groupId = group.id

  await createGroupOrgBinding(groupId, 'org_super_admin')

  const { error: groupMemberError } = await supabase.from('group_members').insert({
    group_id: groupId,
    user_id: USER_ID,
    added_by: USER_ID,
  })
  if (groupMemberError)
    throw groupMemberError

  const apiKey = await createDirectApiKeyWithBindings({
    key: lowRankApiKey,
    name: `Private groups rank regression ${fixtureId}`,
    orgId,
    roleName: 'org_admin',
    hashed: true,
  })
  if (!apiKey.id || !apiKey.rbac_id)
    throw new Error('Unable to create private groups rank API key')

  const highRankKey = await createDirectApiKeyWithBindings({
    key: highRankApiKey,
    name: `Private groups super-admin regression ${fixtureId}`,
    orgId,
    roleName: 'org_super_admin',
    hashed: true,
  })
  if (!highRankKey.id || !highRankKey.rbac_id)
    throw new Error('Unable to create private groups super-admin API key')

  lowRankApiKeyId = apiKey.id
  highRankApiKeyId = highRankKey.id
})

afterAll(async () => {
  if (USE_CLOUDFLARE)
    return

  const supabase = getSupabaseClient()
  if (lowRankApiKeyId !== null)
    await supabase.from('apikeys').delete().eq('id', lowRankApiKeyId)
  if (highRankApiKeyId !== null)
    await supabase.from('apikeys').delete().eq('id', highRankApiKeyId)

  await supabase.from('orgs').delete().eq('id', orgId)
})

describe.skipIf(USE_CLOUDFLARE)('/private/groups access', () => {
  it('denies org members from reading group members', async () => {
    const response = await fetch(getEndpointUrl(`/private/groups/${groupId}/members`), {
      headers: memberAuthHeaders,
    })

    expect(response.status).toBe(403)
    const body = await response.json() as { error: string, message: string }
    expect(body.error).toBe('forbidden')
    expect(body.message).toBe('Forbidden')
  })

  it('allows org admins to read group members', async () => {
    const response = await fetch(getEndpointUrl(`/private/groups/${groupId}/members`), {
      headers: adminAuthHeaders,
    })

    expect(response.status).toBe(200)
    const data = await response.json() as Array<{ user_id: string }>
    expect(data.every(row => row.user_id === USER_ID)).toBe(true)
    expect(data).toHaveLength(1)
  })

  it('does not disclose high-rank group data through direct JWT PostgREST reads', async () => {
    const rows = await readGroupRows({
      apikey: SUPABASE_ANON_KEY,
      ...memberAuthHeaders,
    })

    expect(rows.groupRows).toEqual([])
    expect(rows.memberRows).toEqual([])
  })

  it('applies group rank to direct API-key PostgREST reads', async () => {
    const lowRankRows = await readGroupRows({
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      capgkey: lowRankApiKey,
    })
    expect(lowRankRows.groupRows).toEqual([])
    expect(lowRankRows.memberRows).toEqual([])

    const highRankRows = await readGroupRows({
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      capgkey: highRankApiKey,
    })
    expect(highRankRows.groupRows).toEqual([{ id: groupId }])
    expect(highRankRows.memberRows).toEqual([{ user_id: USER_ID }])
  })

  it('blocks lower-rank principals from updating high-role groups, changing membership, or deleting the group', async () => {
    const headers = { ...memberAuthHeaders, 'Content-Type': 'application/json' }

    const addResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}/members`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: USER_ID }),
    })
    await expectRankGuard(addResponse)

    const removeResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}/members/${USER_ID}`), {
      method: 'DELETE',
      headers,
    })
    await expectRankGuard(removeResponse)

    const updateResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}`), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ description: 'lower-rank update' }),
    })
    await expectRankGuard(updateResponse)

    const deleteResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}`), {
      method: 'DELETE',
      headers,
    })
    await expectRankGuard(deleteResponse)
  })

  it('uses the API key RBAC principal instead of its higher-rank owner', async () => {
    const headers = {
      'Content-Type': 'application/json',
      'capgkey': lowRankApiKey,
    }

    const addResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}/members`), {
      method: 'POST',
      headers,
      body: JSON.stringify({ user_id: USER_ID }),
    })
    await expectRankGuard(addResponse)

    const removeResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}/members/${USER_ID}`), {
      method: 'DELETE',
      headers,
    })
    await expectRankGuard(removeResponse)

    const updateResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}`), {
      method: 'PUT',
      headers,
      body: JSON.stringify({ description: 'API key lower-rank update' }),
    })
    await expectRankGuard(updateResponse)

    const deleteResponse = await fetch(getEndpointUrl(`/private/groups/${groupId}`), {
      method: 'DELETE',
      headers,
    })
    await expectRankGuard(deleteResponse)
  })
})
