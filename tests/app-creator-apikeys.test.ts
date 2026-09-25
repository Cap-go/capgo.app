import type { Database } from '../src/types/supabase.types.ts'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchTestRequest, getAuthHeaders, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, SUPABASE_ANON_KEY, SUPABASE_BASE_URL, USER_ID } from './test-utils.ts'

const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

// Dedicated org: the shared test user is super admin, a fresh user is org_member.
const TEST_ID = randomUUID().slice(0, 8)
const ORG_ID = randomUUID()
const CUSTOMER_ID = `cus_app_creator_${TEST_ID}`
const MEMBER_EMAIL = `app-creator-member-${TEST_ID}@capgo.app`
const MEMBER_PASSWORD = 'testtest'

let adminHeaders: Record<string, string>
let memberHeaders: Record<string, string>
let memberId = ''
const createdAppIds: string[] = []
const createdKeyIds: number[] = []

async function createApp(headers: Record<string, string>, suffix: string) {
  const appId = `com.test.appcreator.${TEST_ID}.${suffix}`
  const response = await fetchTestRequest(getEndpointUrl('/app'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ owner_org: ORG_ID, app_id: appId, name: `App creator ${suffix}` }),
  })
  const body = await response.json() as { id: string, app_id: string }
  expect(response.status, JSON.stringify(body)).toBe(200)
  createdAppIds.push(appId)
  return body
}

async function appRolesOf(userId: string, appUuid: string) {
  const { data, error } = await getSupabaseClient()
    .from('role_bindings')
    .select('roles(name)')
    .eq('principal_type', 'user')
    .eq('principal_id', userId)
    .eq('scope_type', 'app')
    .eq('app_id', appUuid)
  if (error)
    throw error
  return (data ?? []).map(row => (row as unknown as { roles: { name: string } }).roles.name)
}

function createKey(headers: Record<string, string>, bindings: Record<string, unknown>[]) {
  return fetchTestRequest(getEndpointUrl('/apikey'), {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: `app-creator-key-${randomUUID().slice(0, 8)}`, bindings }),
  })
}

beforeAll(async () => {
  const supabase = getSupabaseClient()
  adminHeaders = await getAuthHeaders()

  const { error: stripeError } = await supabase.from('stripe_info').insert({
    customer_id: CUSTOMER_ID,
    product_id: 'prod_LQIregjtNduh4q',
    status: 'succeeded',
    is_good_plan: true,
  })
  if (stripeError)
    throw stripeError
  const { error: orgError } = await supabase.from('orgs').insert({
    id: ORG_ID,
    created_by: USER_ID,
    name: `App Creator Org ${TEST_ID}`,
    management_email: `app-creator-${TEST_ID}@capgo.app`,
    customer_id: CUSTOMER_ID,
  })
  if (orgError)
    throw orgError
  const { error: adminMembershipError } = await supabase.from('org_users').insert({ org_id: ORG_ID, user_id: USER_ID, rbac_role_name: 'org_super_admin' })
  if (adminMembershipError)
    throw adminMembershipError

  const { data: member, error: memberError } = await supabase.auth.admin.createUser({
    email: MEMBER_EMAIL,
    password: MEMBER_PASSWORD,
    email_confirm: true,
  })
  if (memberError || !member.user)
    throw memberError ?? new Error('Failed to create member user')
  memberId = member.user.id
  const { error: profileError } = await supabase.from('users').upsert({ id: memberId, email: MEMBER_EMAIL })
  if (profileError)
    throw profileError
  const { error: memberMembershipError } = await supabase.from('org_users').insert({ org_id: ORG_ID, user_id: memberId, rbac_role_name: 'org_member' })
  if (memberMembershipError)
    throw memberMembershipError
  const { data: memberRole, error: memberRoleError } = await supabase.from('roles').select('id').eq('name', 'org_member').single()
  if (memberRoleError)
    throw memberRoleError
  const { error: memberBindingError } = await supabase.from('role_bindings').insert({
    principal_type: 'user',
    principal_id: memberId,
    role_id: memberRole.id,
    scope_type: 'org',
    org_id: ORG_ID,
    granted_by: USER_ID,
  })
  if (memberBindingError)
    throw memberBindingError
  memberHeaders = await getAuthHeadersForCredentials(MEMBER_EMAIL, MEMBER_PASSWORD)
})

afterAll(async () => {
  const supabase = getSupabaseClient()
  for (const keyId of createdKeyIds)
    await supabase.from('apikeys').delete().eq('id', keyId)
  for (const appId of createdAppIds)
    await supabase.from('apps').delete().eq('app_id', appId)
  await supabase.from('role_bindings').delete().eq('org_id', ORG_ID)
  await supabase.from('org_users').delete().eq('org_id', ORG_ID)
  await supabase.from('orgs').delete().eq('id', ORG_ID)
  await supabase.from('stripe_info').delete().eq('customer_id', CUSTOMER_ID)
  if (memberId)
    await supabase.auth.admin.deleteUser(memberId)
})

describe.skipIf(USE_CLOUDFLARE)('app creators and app-scoped API keys', () => {
  it('makes an org_member admin of the app they create, and only of that one', async () => {
    const memberApp = await createApp(memberHeaders, 'member')
    expect(await appRolesOf(memberId, memberApp.id)).toEqual(['app_admin'])

    // The creator can now read their app through RLS, and only that one.
    const memberClient = createClient<Database>(SUPABASE_BASE_URL!, SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })
    const { error: signInError } = await memberClient.auth.signInWithPassword({ email: MEMBER_EMAIL, password: MEMBER_PASSWORD })
    if (signInError)
      throw signInError

    // An org admin already administers every app: no redundant app binding.
    const adminApp = await createApp(adminHeaders, 'admin')
    expect(await appRolesOf(USER_ID, adminApp.id)).toEqual([])
    const { data: visibleApps } = await memberClient.from('apps').select('id').eq('owner_org', ORG_ID)
    expect((visibleApps ?? []).map(app => app.id)).toEqual([memberApp.id])
  })

  it('lets an app admin create keys limited to their own app, nothing wider', async () => {
    const memberApp = await createApp(memberHeaders, 'keys')
    const adminApp = await createApp(adminHeaders, 'keys-admin')

    const ownApp = await createKey(memberHeaders, [{ role_name: 'app_developer', scope_type: 'app', org_id: ORG_ID, app_id: memberApp.id }])
    const ownAppBody = await ownApp.json() as { id: number }
    expect(ownApp.status, JSON.stringify(ownAppBody)).toBe(200)
    createdKeyIds.push(ownAppBody.id)

    const orgWide = await createKey(memberHeaders, [{ role_name: 'org_member', scope_type: 'org', org_id: ORG_ID }])
    expect(orgWide.status).toBe(403)

    const otherApp = await createKey(memberHeaders, [{ role_name: 'app_reader', scope_type: 'app', org_id: ORG_ID, app_id: adminApp.id }])
    expect(otherApp.status).toBe(403)

    // Capped by the creator: app admins cannot hand out app_admin itself.
    const escalation = await createKey(memberHeaders, [{ role_name: 'app_admin', scope_type: 'app', org_id: ORG_ID, app_id: memberApp.id }])
    expect(escalation.status).toBe(403)
  })
})
