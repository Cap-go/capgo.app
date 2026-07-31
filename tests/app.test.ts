import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createDirectApiKeyWithBindings, executeSQL, fetchTestRequest, getAuthHeaders, getSupabaseClient, headers, ORG_ID, ORG_ID_2, resetAndSeedAppData, resetAppData, resetAppDataStats, USER_ID, USER_ID_2 } from './test-utils.ts'

function isDuplicateAppCreationError(body: any): boolean {
  if (!body || typeof body !== 'object')
    return false

  const errorCode = typeof body.error === 'string' ? body.error : ''
  const supabaseCode = typeof body?.supabaseError?.code === 'string' ? body.supabaseError.code : ''
  const moreInfoConstraint = typeof body?.moreInfo?.constraint === 'string' ? body.moreInfo.constraint : ''
  const constraint = typeof body?.constraint === 'string' ? body.constraint : ''

  if (errorCode === 'app_id_already_exists')
    return true

  const hasExplicitDuplicateSignal
    = supabaseCode === '23505'
      || moreInfoConstraint === 'apps_pkey'
      || constraint === 'apps_pkey'

  return errorCode === 'cannot_create_app' && hasExplicitDuplicateSignal
}

describe('[DELETE] /app operations', () => {
  const id = randomUUID()
  const APPNAME = `com.app.${id}`
  const createBody = {
    app_id: APPNAME,
    owner_org: ORG_ID,
    name: `App ${APPNAME}`,
    icon: 'test-icon',
  }

  afterAll(async () => {
    await resetAppData(APPNAME)
    await resetAppDataStats(APPNAME)
  })

  it('should delete app and all associated data', async () => {
    // Create a test app
    const createApp = await fetchTestRequest(`${BASE_URL}/app`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
    })
    if (createApp.status !== 200) {
      const body = await createApp.json().catch(() => null) as any
      const isDuplicate = isDuplicateAppCreationError(body)
      if (!isDuplicate) {
        expect(createApp.status, JSON.stringify(body)).toBe(200)
      }
    }

    await resetAndSeedAppData(APPNAME)

    // Delete the app
    const deleteApp = await fetchTestRequest(`${BASE_URL}/app/${APPNAME}`, {
      method: 'DELETE',
      headers,
    })
    if (deleteApp.status !== 200) {
      const body = await deleteApp.json().catch(() => null)
      expect(deleteApp.status, JSON.stringify(body)).toBe(200)
    }

    // Verify app is deleted
    const checkApp = await fetchTestRequest(`${BASE_URL}/app/${APPNAME}`, {
      method: 'GET',
      headers,
    })
    expect(checkApp.status).toBe(401)

    // Verify version is deleted
    const checkVersion = await fetchTestRequest(`${BASE_URL}/bundle/${APPNAME}/1.0.0`, {
      method: 'GET',
      headers,
    })
    expect(checkVersion.status).toBe(404)

    // Verify channel devices are deleted
    const checkDevices = await fetchTestRequest(`${BASE_URL}/device/${APPNAME}`, {
      method: 'GET',
      headers,
    })
    expect(checkDevices.status).toBe(404)

    // Verify channels are deleted
    const checkChannels = await fetchTestRequest(`${BASE_URL}/channel/${APPNAME}`, {
      method: 'GET',
      headers,
    })
    expect(checkChannels.status).toBe(404)
  })
})

describe('[GET] /app operations with subkey', () => {
  const id = randomUUID()
  const APPNAME = `com.subkey.${id}`
  let subkey = 0

  afterAll(async () => {
    await resetAppData(APPNAME)
    await resetAppDataStats(APPNAME)
  })

  it('should create app and subkey with limited rights', async () => {
    // Create a test app
    const createApp = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        owner_org: ORG_ID,
        app_id: APPNAME,
        name: `App ${APPNAME}`,
        icon: 'test-icon',
      }),
    })
    // Handle duplicate app creation gracefully on retry (app may already exist from a previous attempt)
    if (createApp.status !== 200) {
      const body = await createApp.json().catch(() => null) as any
      const isDuplicate = isDuplicateAppCreationError(body)
      if (!isDuplicate) {
        expect(createApp.status, JSON.stringify(body)).toBe(200)
      }
    }

    // Create a V2 subkey with limited rights to this app.
    const subkeyData = await createDirectApiKeyWithBindings({
      key: randomUUID(),
      name: `Limited Subkey ${id}`,
      orgId: ORG_ID,
      roleName: 'org_member',
      appId: APPNAME,
      appRoleName: 'app_admin',
    })
    subkey = subkeyData.id
  })

  it('should access app with subkey', async () => {
    // Access app with subkey
    const subkeyHeaders = { 'x-limited-key-id': String(subkey) }
    const getAppWithSubkey = await fetch(`${BASE_URL}/app/${APPNAME}`, {
      method: 'GET',
      headers: { ...headers, ...subkeyHeaders },
    })
    expect(getAppWithSubkey.status).toBe(200)
    const data = await getAppWithSubkey.json() as { name: string }
    expect(data.name).toBe(`App ${APPNAME}`)
  })

  it('should not access another app with subkey', async () => {
    // Create another app
    const otherAppId = randomUUID()
    const OTHER_APPNAME = `com.other.subkey.${otherAppId}`
    const createOtherApp = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        owner_org: ORG_ID,
        app_id: OTHER_APPNAME,
        name: `App ${OTHER_APPNAME}`,
        icon: 'test-icon',
      }),
    })
    if (createOtherApp.status !== 200) {
      const body = await createOtherApp.json().catch(() => null) as any
      const isDuplicate = isDuplicateAppCreationError(body)
      if (!isDuplicate) {
        expect(createOtherApp.status, JSON.stringify(body)).toBe(200)
      }
    }

    // Try to access the other app with the subkey
    const subkeyHeaders = { 'x-limited-key-id': String(subkey) }
    const getOtherAppWithSubkey = await fetch(`${BASE_URL}/app/${OTHER_APPNAME}`, {
      method: 'GET',
      headers: { ...headers, ...subkeyHeaders },
    })
    const data = await getOtherAppWithSubkey.json()
    expect(data).toHaveProperty('error', 'cannot_access_app')
    expect(getOtherAppWithSubkey.status).toBe(401)

    // Clean up the other app
    await resetAppData(OTHER_APPNAME)
    await resetAppDataStats(OTHER_APPNAME)
  })

  it('should update app with subkey', async () => {
    // Update app with subkey
    const subkeyHeaders = { 'x-limited-key-id': String(subkey) }
    const updateApp = await fetch(`${BASE_URL}/app/${APPNAME}`, {
      method: 'PUT',
      headers: { ...headers, ...subkeyHeaders },
      body: JSON.stringify({
        name: APPNAME,
        icon: 'updated-icon',
      }),
    })
    expect(updateApp.status).toBe(200)
  })

  it('should not delete app with subkey if rights are read-only', async () => {
    // Attempt to delete app with subkey
    const subkeyData = await createDirectApiKeyWithBindings({
      key: randomUUID(),
      name: `Limited reader subkey ${id}`,
      orgId: ORG_ID,
      roleName: 'org_member',
      appId: APPNAME,
      appRoleName: 'app_reader',
    })
    const subkeyHeaders = { 'x-limited-key-id': String(subkeyData.id) }
    const deleteApp = await fetch(`${BASE_URL}/app/${APPNAME}`, {
      method: 'DELETE',
      headers: { ...headers, ...subkeyHeaders },
    })
    expect(deleteApp.status).toBe(400)
    const deleteAppData = await deleteApp.json() as { error: string }
    expect(deleteAppData.error).toBe('cannot_delete_app')
  })

  it('should get all apps with subkey', async () => {
    // Get all apps with subkey
    const subkeyHeaders = { 'x-limited-key-id': String(subkey) }
    const getAllApps = await fetch(`${BASE_URL}/app`, {
      method: 'GET',
      headers: { ...headers, ...subkeyHeaders },
    })
    expect(getAllApps.status).toBe(200)
    const appsDataWithSubkey = await getAllApps.json() as { name: string }[]
    const appNamesWithSubkey = appsDataWithSubkey.map(app => app.name)
    expect(appNamesWithSubkey).toContain(APPNAME)
  })

  it('should get all apps without subkey', async () => {
    // Get all apps without subkey
    const getAllApps = await fetch(`${BASE_URL}/app`, {
      method: 'GET',
      headers,
    })
    expect(getAllApps.status).toBe(200)
    const appsDataWithoutSubkey = await getAllApps.json() as { app_id: string }[]
    const appNamesWithoutSubkey = appsDataWithoutSubkey.map(app => app.app_id)
    expect(appNamesWithoutSubkey).toContain(APPNAME)
  })
})

describe('[GET] /app subkey ownership enforcement', () => {
  const appId = 'com.test2.app'
  let subkeyId = 0

  afterAll(async () => {
    if (subkeyId) {
      await getSupabaseClient().from('apikeys').delete().eq('id', subkeyId)
    }
  })

  it('should reject subkey id owned by another user', async () => {
    const subkeyData = await createDirectApiKeyWithBindings({
      userId: USER_ID_2,
      key: randomUUID(),
      name: `Cross-tenant subkey ${randomUUID()}`,
      orgId: ORG_ID_2,
      roleName: 'org_member',
      appId,
      appRoleName: 'app_reader',
    })
    expect(subkeyData?.id).toBeTruthy()
    subkeyId = subkeyData.id

    const subkeyHeaders = { 'x-limited-key-id': String(subkeyId) }
    const response = await fetch(`${BASE_URL}/app/${appId}`, {
      method: 'GET',
      headers: { ...headers, ...subkeyHeaders },
    })
    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })
})

describe('/app hashed subkey enforcement', () => {
  const id = randomUUID()
  const ALLOWED_APPNAME = `com.hashed-subkey.allowed.${id}`
  const BLOCKED_APPNAME = `com.hashed-subkey.blocked.${id}`
  const SUBKEY_NAME = `Hashed Limited Subkey ${id}`
  let subkeyId = 0

  async function createAppForTest(appName: string) {
    const createApp = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        owner_org: ORG_ID,
        app_id: appName,
        name: `App ${appName}`,
        icon: 'test-icon',
      }),
    })
    if (createApp.status !== 200) {
      const body = await createApp.json().catch(() => null) as any
      const isDuplicate = isDuplicateAppCreationError(body)
      if (!isDuplicate) {
        expect(createApp.status, JSON.stringify(body)).toBe(200)
      }
    }
  }

  beforeAll(async () => {
    await createAppForTest(ALLOWED_APPNAME)
    const subkeyData = await createDirectApiKeyWithBindings({
      key: randomUUID(),
      name: SUBKEY_NAME,
      orgId: ORG_ID,
      roleName: 'org_member',
      appId: ALLOWED_APPNAME,
      appRoleName: 'app_admin',
      hashed: true,
    })
    subkeyId = subkeyData.id
  })

  afterAll(async () => {
    if (subkeyId) {
      await getSupabaseClient().from('apikeys').delete().eq('id', subkeyId)
    }
    await resetAppData(ALLOWED_APPNAME)
    await resetAppDataStats(ALLOWED_APPNAME)
    await resetAppData(BLOCKED_APPNAME)
    await resetAppDataStats(BLOCKED_APPNAME)
  })

  it('should reject hashed subkeys on middlewareKey routes', async () => {
    const response = await fetch(`${BASE_URL}/app/${ALLOWED_APPNAME}`, {
      method: 'GET',
      headers: { ...headers, 'x-limited-key-id': String(subkeyId) },
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })

  it('should reject hashed subkeys on JWT/API-key auth routes', async () => {
    const response = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers: { ...headers, 'x-limited-key-id': String(subkeyId) },
      body: JSON.stringify({
        owner_org: ORG_ID,
        app_id: BLOCKED_APPNAME,
        name: `App ${BLOCKED_APPNAME}`,
        icon: 'test-icon',
      }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })
})

describe('[GET] /app invalid subkey header handling', () => {
  it.concurrent('should reject malformed x-limited-key-id values instead of ignoring them', async () => {
    const invalidSubkeyValues = ['', '0', '73603x', '73603,', ' 73603', '9007199254740992']

    for (const invalidSubkeyValue of invalidSubkeyValues) {
      const response = await fetch(`${BASE_URL}/app?limit=1`, {
        method: 'GET',
        headers: {
          ...headers,
          'x-limited-key-id': invalidSubkeyValue,
        },
      })

      expect(response.status).toBe(401)
      const data = await response.json() as { error?: string }
      expect(data.error).toBe('invalid_subkey')
    }
  })
})

describe('[POST] /app operations with non-owner user', () => {
  const id = randomUUID()
  const safeId = id.replaceAll('-', '')
  const noAccessOrgId = randomUUID()
  const adminAccessOrgId = randomUUID()
  const noAccessCustomerId = `cus_nonowner_no_${safeId}`
  const adminAccessCustomerId = `cus_nonowner_admin_${safeId}`
  const noAccessAppName = `com.nonowner.denied.${safeId}`
  const adminAccessAppName = `com.nonowner.allowed.${safeId}`
  let authHeaders: Record<string, string>

  beforeAll(async () => {
    authHeaders = await getAuthHeaders()
    const supabase = getSupabaseClient()

    const { error: stripeError } = await supabase.from('stripe_info').insert([
      {
        customer_id: noAccessCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_no_${safeId}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      },
      {
        customer_id: adminAccessCustomerId,
        status: 'succeeded',
        product_id: 'prod_LQIregjtNduh4q',
        subscription_id: `sub_admin_${safeId}`,
        trial_at: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
        is_good_plan: true,
      },
    ])
    if (stripeError)
      throw stripeError

    const { error: orgError } = await supabase.from('orgs').insert([
      {
        id: noAccessOrgId,
        name: `No access app org ${safeId}`,
        management_email: `no-access-${safeId}@capgo.test`,
        created_by: USER_ID_2,
        customer_id: noAccessCustomerId,
      },
      {
        id: adminAccessOrgId,
        name: `Admin access app org ${safeId}`,
        management_email: `admin-access-${safeId}@capgo.test`,
        created_by: USER_ID_2,
        customer_id: adminAccessCustomerId,
      },
    ])
    if (orgError)
      throw orgError

    const { error: orgUserError } = await supabase.from('org_users').insert({
      org_id: noAccessOrgId,
      user_id: USER_ID,
      rbac_role_name: 'org_member',
    })
    if (orgUserError)
      throw orgUserError

    await executeSQL(`
      DELETE FROM public.role_bindings
      WHERE principal_type = public.rbac_principal_user()
        AND principal_id = $1::uuid
        AND org_id = $2::uuid
    `, [USER_ID, noAccessOrgId])

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
        'app creation test admin binding',
        true
      FROM public.roles
      WHERE roles.name = public.rbac_role_org_admin()
        AND roles.scope_type = public.rbac_scope_org()
      LIMIT 1
    `, [USER_ID, adminAccessOrgId])
  })

  afterAll(async () => {
    await resetAppData(noAccessAppName)
    await resetAppDataStats(noAccessAppName)
    await resetAppData(adminAccessAppName)
    await resetAppDataStats(adminAccessAppName)
    const supabase = getSupabaseClient()
    await executeSQL(`
      DELETE FROM public.role_bindings
      WHERE principal_type = public.rbac_principal_user()
        AND principal_id = $1::uuid
        AND org_id = ANY($2::uuid[])
    `, [USER_ID, [noAccessOrgId, adminAccessOrgId]])
    await supabase.from('org_users').delete().eq('user_id', USER_ID).in('org_id', [noAccessOrgId, adminAccessOrgId])
    await supabase.from('orgs').delete().in('id', [noAccessOrgId, adminAccessOrgId])
    await supabase.from('stripe_info').delete().in('customer_id', [noAccessCustomerId, adminAccessCustomerId])
  })

  it('should ignore stale org_users role metadata when creating an app', async () => {
    const createApp = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        owner_org: noAccessOrgId,
        app_id: noAccessAppName,
        name: `${noAccessAppName}_no_access`,
        icon: 'test-icon',
      }),
    })
    expect(createApp.status).toBe(403)
    const responseData = await createApp.json()
    expect(responseData).toHaveProperty('error', 'cannot_access_organization')
  })

  it('should allow app creation in an organization where user has an RBAC admin binding', async () => {
    const createApp = await fetch(`${BASE_URL}/app`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        owner_org: adminAccessOrgId,
        app_id: adminAccessAppName,
        name: `App ${adminAccessAppName}`,
        icon: 'test-icon',
      }),
    })
    expect(createApp.status).toBe(200)
    const responseData = await createApp.json()
    expect(responseData).toHaveProperty('app_id', adminAccessAppName)
  })
})
