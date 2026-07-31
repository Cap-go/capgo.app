import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ORG_SUPER_ADMIN,
  createDirectApiKeyWithBindings,
  executeSQL,
  fetchTestRequest,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  ORG_ID_2,
  resetAndSeedAppData,
  resetAppData,
  STRIPE_INFO_CUSTOMER_ID_2,
  USER_EMAIL_NONMEMBER,
  USER_ID_2,
  USER_ID_NONMEMBER,
  USER_PASSWORD,
  USER_PASSWORD_NONMEMBER,
} from './test-utils.ts'

const id = randomUUID()
const APP_OWN = `com.demo.manifest-own.${id}`
const APP_OTHER = `com.demo.manifest-other.${id}`
const APP_READ_ONLY = `com.demo.manifest-read-only.${id}`
const READ_ONLY_ORG_ID = randomUUID()
const READ_ONLY_STRIPE_CUSTOMER_ID = `cus_manifest_rls_${id.replaceAll('-', '')}`
const READ_ONLY_VISIBLE_FILE = 'read-only-visible.js'
const OTHER_USER_EMAIL = 'test2@capgo.app'
const otherOrgOnlyApiKeyInput = randomUUID()

let authHeadersUser1: Record<string, string>
let authHeadersUser2: Record<string, string>
let authHeadersNonMember: Record<string, string>
let otherOrgOnlyApiKey: string
let otherOrgOnlyApiKeyId: number | null = null
let ownVersionId: number
let otherVersionId: number
let readOnlyVersionId: number

const restApiKeyHeaders = {
  'Content-Type': 'application/json',
}

async function createUserOrgBinding(orgId: string, userId: string, roleName: string) {
  await executeSQL(`
    INSERT INTO public.role_bindings (
      principal_type,
      principal_id,
      role_id,
      scope_type,
      org_id,
      granted_by,
      reason,
      is_direct
    )
    SELECT
      public.rbac_principal_user(),
      $1::uuid,
      roles.id,
      public.rbac_scope_org(),
      $2::uuid,
      $1::uuid,
      'Manifest RLS test binding',
      true
    FROM public.roles roles
    WHERE roles.name = $3
      AND roles.scope_type = public.rbac_scope_org()
    ON CONFLICT DO NOTHING
  `, [userId, orgId, roleName])
}

async function createUserAppBinding(orgId: string, userId: string, appId: string, roleName: string) {
  await executeSQL(`
    INSERT INTO public.role_bindings (
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
    SELECT
      public.rbac_principal_user(),
      $1::uuid,
      roles.id,
      public.rbac_scope_app(),
      $2::uuid,
      apps.id,
      $1::uuid,
      'Manifest RLS test app binding',
      true
    FROM public.roles roles
    INNER JOIN public.apps apps ON apps.app_id = $3
    WHERE roles.name = $4
      AND roles.scope_type = public.rbac_scope_app()
    ON CONFLICT DO NOTHING
  `, [userId, orgId, appId, roleName])
}

interface ManifestRow {
  id: number
  file_name: string
  file_hash: string
  s3_path: string
  app_version_id: number
}

function getRestManifestUrl(searchParams: Record<string, string>): string {
  const supabaseUrl = process.env.SUPABASE_URL
  if (!supabaseUrl)
    throw new Error('SUPABASE_URL is missing')

  const url = new URL('/rest/v1/manifest', supabaseUrl)
  for (const [key, value] of Object.entries(searchParams))
    url.searchParams.set(key, value)
  return url.toString()
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text)
    return null

  try {
    return JSON.parse(text) as unknown
  }
  catch {
    return text
  }
}

async function fetchManifestRows(headers: Record<string, string>, appVersionId: number) {
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!anonKey)
    throw new Error('SUPABASE_ANON_KEY is missing')

  const response = await fetchTestRequest(getRestManifestUrl({
    select: 'id,file_name,file_hash,s3_path,app_version_id',
    app_version_id: `eq.${appVersionId}`,
  }), {
    method: 'GET',
    headers: {
      ...headers,
      apikey: anonKey,
    },
  })

  const data = await response.json() as ManifestRow[]

  return { response, data }
}

async function insertManifestRow(headers: Record<string, string>, row: Omit<ManifestRow, 'id'>) {
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!anonKey)
    throw new Error('SUPABASE_ANON_KEY is missing')

  const response = await fetchTestRequest(getRestManifestUrl({
    select: 'id,file_name,file_hash,s3_path,app_version_id',
  }), {
    method: 'POST',
    headers: {
      ...headers,
      apikey: anonKey,
      prefer: 'return=representation',
    },
    body: JSON.stringify(row),
  })

  return {
    response,
    body: await parseResponseBody(response),
  }
}

async function deleteManifestRow(headers: Record<string, string>, manifestId: number) {
  const anonKey = process.env.SUPABASE_ANON_KEY
  if (!anonKey)
    throw new Error('SUPABASE_ANON_KEY is missing')

  const response = await fetchTestRequest(getRestManifestUrl({
    select: 'id',
    id: `eq.${manifestId}`,
  }), {
    method: 'DELETE',
    headers: {
      ...headers,
      apikey: anonKey,
      prefer: 'return=representation',
    },
  })

  return {
    response,
    body: await parseResponseBody(response),
  }
}

beforeAll(async () => {
  await resetAndSeedAppData(APP_OWN)
  await resetAndSeedAppData(APP_OTHER, {
    orgId: ORG_ID_2,
    userId: USER_ID_2,
    stripeCustomerId: STRIPE_INFO_CUSTOMER_ID_2,
  })
  await resetAndSeedAppData(APP_READ_ONLY, {
    orgId: READ_ONLY_ORG_ID,
    stripeCustomerId: READ_ONLY_STRIPE_CUSTOMER_ID,
  })

  authHeadersUser1 = await getAuthHeaders()
  authHeadersUser2 = await getAuthHeadersForCredentials(OTHER_USER_EMAIL, USER_PASSWORD)
  authHeadersNonMember = await getAuthHeadersForCredentials(USER_EMAIL_NONMEMBER, USER_PASSWORD_NONMEMBER)

  const supabase = getSupabaseClient()
  const { data: ownVersion, error: ownVersionError } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', APP_OWN)
    .eq('name', '1.0.0')
    .single()

  if (ownVersionError || !ownVersion)
    throw ownVersionError ?? new Error('Missing own app version')

  ownVersionId = ownVersion.id

  const { data: otherVersion, error: otherVersionError } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', APP_OTHER)
    .eq('name', '1.0.0')
    .single()

  if (otherVersionError || !otherVersion)
    throw otherVersionError ?? new Error('Missing foreign app version')

  otherVersionId = otherVersion.id

  const { data: readOnlyVersion, error: readOnlyVersionError } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', APP_READ_ONLY)
    .eq('name', '1.0.0')
    .single()

  if (readOnlyVersionError || !readOnlyVersion)
    throw readOnlyVersionError ?? new Error('Missing read-only app version')

  readOnlyVersionId = readOnlyVersion.id

  const apiKey = await createDirectApiKeyWithBindings({
    userId: USER_ID_2,
    key: otherOrgOnlyApiKeyInput,
    name: `manifest-other-org-${id}`,
    orgId: ORG_ID_2,
    roleName: 'org_super_admin',
    appId: APP_OTHER,
    appRoleName: 'app_admin',
  })
  if (!apiKey.key)
    throw new Error('Failed to create manifest API key')
  otherOrgOnlyApiKey = apiKey.key
  otherOrgOnlyApiKeyId = apiKey.id

  await supabase.from('org_users').insert({
    org_id: READ_ONLY_ORG_ID,
    user_id: USER_ID_NONMEMBER,
    rbac_role_name: 'org_member',
  }).throwOnError()
  await createUserOrgBinding(READ_ONLY_ORG_ID, USER_ID_NONMEMBER, 'org_member')
  await createUserAppBinding(READ_ONLY_ORG_ID, USER_ID_NONMEMBER, APP_READ_ONLY, 'app_reader')

  await supabase.from('manifest').insert([
    {
      app_version_id: ownVersionId,
      file_name: 'own-entry.js',
      s3_path: '/own-entry.js',
      file_hash: 'own-hash',
      file_size: 101,
    },
    {
      app_version_id: otherVersionId,
      file_name: 'other-entry.js',
      s3_path: '/other-entry.js',
      file_hash: 'other-hash',
      file_size: 102,
    },
    {
      app_version_id: readOnlyVersionId,
      file_name: READ_ONLY_VISIBLE_FILE,
      s3_path: `orgs/${READ_ONLY_ORG_ID}/apps/${APP_READ_ONLY}/baseline/${READ_ONLY_VISIBLE_FILE}`,
      file_hash: 'read-only-visible-hash',
      file_size: 103,
    },
  ]).throwOnError()
}, 120000)

afterAll(async () => {
  if (otherOrgOnlyApiKeyId !== null) {
    await getSupabaseClient()
      .from('apikeys')
      .delete()
      .eq('id', otherOrgOnlyApiKeyId)
      .throwOnError()
  }

  await getSupabaseClient()
    .from('org_users')
    .delete()
    .eq('org_id', READ_ONLY_ORG_ID)
    .eq('user_id', USER_ID_NONMEMBER)
    .throwOnError()

  await Promise.all([
    resetAppData(APP_OWN),
    resetAppData(APP_OTHER),
    resetAppData(APP_READ_ONLY),
  ])
}, 120000)

describe('manifest RLS', () => {
  it.concurrent('allows an authenticated user to read manifest entries for their own org', async () => {
    const { response, data } = await fetchManifestRows(authHeadersUser1, ownVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0]?.file_name).toBe('own-entry.js')
  })

  it.concurrent('prevents an authenticated user from reading manifest entries for another org', async () => {
    const { response, data } = await fetchManifestRows(authHeadersNonMember, otherVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(0)
  })

  it.concurrent('still allows the other org owner to read their own manifest entries', async () => {
    const { response, data } = await fetchManifestRows(authHeadersUser2, otherVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0]?.file_name).toBe('other-entry.js')
  })

  it.concurrent('allows an app reader binding to read manifest entries for its app', async () => {
    const { response, data } = await fetchManifestRows(authHeadersNonMember, readOnlyVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0]?.file_name).toBe(READ_ONLY_VISIBLE_FILE)
  })

  it.concurrent('allows an API key for the owning org to read manifest entries', async () => {
    const { response, data } = await fetchManifestRows({
      ...restApiKeyHeaders,
      capgkey: APIKEY_TEST_ORG_SUPER_ADMIN,
    }, ownVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(1)
    expect(data[0]?.file_name).toBe('own-entry.js')
  })

  it.concurrent('prevents an API key from reading another org\'s manifest entries', async () => {
    const { response, data } = await fetchManifestRows({
      ...restApiKeyHeaders,
      capgkey: otherOrgOnlyApiKey,
    }, ownVersionId)

    expect(response.status).toBe(200)
    expect(data).toHaveLength(0)
  })

  it('prevents an org owner from inserting manifest entries directly', async () => {
    const { response, body } = await insertManifestRow(authHeadersUser1, {
      app_version_id: ownVersionId,
      file_name: 'blocked-owner.js',
      s3_path: `orgs/${READ_ONLY_ORG_ID}/apps/${APP_OWN}/blocked-owner.js`,
      file_hash: 'blocked-owner-hash',
    })

    expect(response.ok).toBe(false)
    expect([401, 403]).toContain(response.status)
    expect(JSON.stringify(body).toLowerCase()).toContain('row-level security')
  })

  it('prevents an app reader binding from inserting manifest entries', async () => {
    const { response, body } = await insertManifestRow(authHeadersNonMember, {
      app_version_id: readOnlyVersionId,
      file_name: 'blocked-readonly.js',
      s3_path: `orgs/${READ_ONLY_ORG_ID}/apps/${APP_READ_ONLY}/blocked-readonly.js`,
      file_hash: 'blocked-readonly-hash',
    })

    expect(response.ok).toBe(false)
    expect([401, 403]).toContain(response.status)
    expect(JSON.stringify(body).toLowerCase()).toContain('row-level security')
  })

  it('prevents an org owner from deleting manifest entries directly', async () => {
    const { data: createdRow, error: createError } = await getSupabaseClient()
      .from('manifest')
      .insert({
        app_version_id: ownVersionId,
        file_name: 'owner-delete-guard.js',
        s3_path: `orgs/${READ_ONLY_ORG_ID}/apps/${APP_OWN}/owner-delete-guard.js`,
        file_hash: 'owner-delete-guard-hash',
      })
      .select('id')
      .single()

    expect(createError).toBeNull()
    expect(createdRow?.id).toBeTypeOf('number')

    const createdRowId = createdRow!.id

    const { response: blockedDeleteResponse, body: blockedDeleteBody } = await deleteManifestRow(authHeadersUser1, createdRowId)

    expect(blockedDeleteResponse.status).toBe(200)
    expect(blockedDeleteBody).toEqual([])

    const { data: stillPresent, error: stillPresentError } = await getSupabaseClient()
      .from('manifest')
      .select('id')
      .eq('id', createdRowId)
      .maybeSingle()

    expect(stillPresentError).toBeNull()
    expect(stillPresent?.id).toBe(createdRowId)

    await getSupabaseClient()
      .from('manifest')
      .delete()
      .eq('id', createdRowId)
      .throwOnError()
  })

  it('prevents an app reader binding from deleting manifest entries', async () => {
    const { data: createdRow, error: createError } = await getSupabaseClient()
      .from('manifest')
      .insert({
        app_version_id: readOnlyVersionId,
        file_name: 'readonly-delete-guard.js',
        s3_path: `orgs/${READ_ONLY_ORG_ID}/apps/${APP_READ_ONLY}/readonly-delete-guard.js`,
        file_hash: 'readonly-delete-guard-hash',
      })
      .select('id')
      .single()

    expect(createError).toBeNull()
    expect(createdRow?.id).toBeTypeOf('number')

    const createdRowId = createdRow!.id

    const { response: blockedDeleteResponse, body: blockedDeleteBody } = await deleteManifestRow(authHeadersNonMember, createdRowId)

    expect(blockedDeleteResponse.status).toBe(200)
    expect(blockedDeleteBody).toEqual([])

    const { data: stillPresent, error: stillPresentError } = await getSupabaseClient()
      .from('manifest')
      .select('id')
      .eq('id', createdRowId)
      .maybeSingle()

    expect(stillPresentError).toBeNull()
    expect(stillPresent?.id).toBe(createdRowId)

    await getSupabaseClient()
      .from('manifest')
      .delete()
      .eq('id', createdRowId)
      .throwOnError()
  })
})
