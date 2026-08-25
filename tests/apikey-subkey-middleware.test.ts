import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_MANAGEMENT_APIKEY_MANAGER,
  APIKEY_MANAGEMENT_ORG_SUPER_ADMIN,
  BASE_URL,
  createDirectApiKeyWithBindings,
  getAuthHeadersForCredentials,
  ORG_ID_APIKEY_MANAGEMENT,
  USER_EMAIL_APIKEY_MANAGEMENT,
  USER_ID_APIKEY_MANAGEMENT,
  USER_PASSWORD,
} from './test-utils.ts'

describe('x-limited-key-id delegation containment', () => {
  const runId = randomUUID().replaceAll('-', '')
  const appA = `com.subkey.contain.a.${runId}`
  const appB = `com.subkey.contain.b.${runId}`
  const createdKeyIds: number[] = []
  const createdKeyRbacIds: string[] = []

  let managerAppAdminSiblingId = 0
  let appScopedParentKey = ''
  let orgScopedSiblingId = 0
  let appAScopedParentKey = ''
  let appBSiblingId = 0
  let limitedChildId = 0
  let privilegedParentKey = APIKEY_MANAGEMENT_ORG_SUPER_ADMIN

  beforeAll(async () => {
    const authHeaders = await getAuthHeadersForCredentials(USER_EMAIL_APIKEY_MANAGEMENT, USER_PASSWORD)

    for (const appId of [appA, appB]) {
      const createApp = await fetch(`${BASE_URL}/app`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          owner_org: ORG_ID_APIKEY_MANAGEMENT,
          app_id: appId,
          name: `Subkey containment ${appId}`,
          icon: 'https://cdn.example/test-icon.png',
        }),
      })
      if (createApp.status !== 200) {
        const body = await createApp.json().catch(() => null) as { error?: string } | null
        expect(createApp.status, JSON.stringify(body)).toBe(200)
      }
    }

    const appAdminSibling = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `app admin sibling ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_member',
      appId: appA,
      appRoleName: 'app_admin',
    })
    managerAppAdminSiblingId = appAdminSibling.id
    createdKeyIds.push(appAdminSibling.id)
    createdKeyRbacIds.push(appAdminSibling.rbac_id)

    const appScopedParent = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `app scoped parent ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_member',
      appId: appA,
      appRoleName: 'app_admin',
    })
    appScopedParentKey = appScopedParent.key ?? ''
    createdKeyIds.push(appScopedParent.id)
    createdKeyRbacIds.push(appScopedParent.rbac_id)

    const orgScopedSibling = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `org scoped sibling ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_admin',
    })
    orgScopedSiblingId = orgScopedSibling.id
    createdKeyIds.push(orgScopedSibling.id)
    createdKeyRbacIds.push(orgScopedSibling.rbac_id)

    const appAParent = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `app A parent ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_member',
      appId: appA,
      appRoleName: 'app_admin',
    })
    appAScopedParentKey = appAParent.key ?? ''
    createdKeyIds.push(appAParent.id)
    createdKeyRbacIds.push(appAParent.rbac_id)

    const appBSibling = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `app B sibling ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_member',
      appId: appB,
      appRoleName: 'app_admin',
    })
    appBSiblingId = appBSibling.id
    createdKeyIds.push(appBSibling.id)
    createdKeyRbacIds.push(appBSibling.rbac_id)

    const limitedChild = await createDirectApiKeyWithBindings({
      userId: USER_ID_APIKEY_MANAGEMENT,
      key: randomUUID(),
      name: `limited child ${runId}`,
      orgId: ORG_ID_APIKEY_MANAGEMENT,
      roleName: 'org_member',
      appId: appA,
      appRoleName: 'app_admin',
    })
    limitedChildId = limitedChild.id
    createdKeyIds.push(limitedChild.id)
    createdKeyRbacIds.push(limitedChild.rbac_id)
  })

  afterAll(async () => {
    const { getSupabaseClient } = await import('./test-utils.ts')
    const supabase = getSupabaseClient()

    for (const rbacId of createdKeyRbacIds) {
      const { error } = await supabase.from('role_bindings').delete().eq('principal_id', rbacId)
      if (error) {
        console.warn(`Failed to delete role_bindings for ${rbacId}:`, error.message)
      }
    }

    for (const keyId of createdKeyIds) {
      const { error } = await supabase.from('apikeys').delete().eq('id', keyId)
      if (error) {
        console.warn(`Failed to delete apikey ${keyId}:`, error.message)
      }
    }

    const { error: appDeleteError } = await supabase.from('apps').delete().in('app_id', [appA, appB])
    if (appDeleteError) {
      console.warn('Failed to delete containment test apps:', appDeleteError.message)
    }
  })

  it.concurrent('rejects apikey_manager parent impersonating same-owner app_admin sibling for app update', async () => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': APIKEY_MANAGEMENT_APIKEY_MANAGER,
        'x-limited-key-id': String(managerAppAdminSiblingId),
      },
      body: JSON.stringify({ name: `Escalated ${runId}` }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })

  it.concurrent('rejects app-scoped parent with broader org-scoped sibling', async () => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': appScopedParentKey,
        'x-limited-key-id': String(orgScopedSiblingId),
      },
      body: JSON.stringify({ name: `Org scoped sibling ${runId}` }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })

  it.concurrent('rejects unrelated same-owner sibling with disjoint app scope', async () => {
    const response = await fetch(`${BASE_URL}/app/${appB}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'authorization': appAScopedParentKey,
        'x-limited-key-id': String(appBSiblingId),
      },
      body: JSON.stringify({ name: `Disjoint sibling ${runId}` }),
    })

    expect(response.status).toBe(401)
    const data = await response.json() as { error?: string }
    expect(data.error).toBe('invalid_subkey')
  })

  it.concurrent('allows privileged parent to adopt a limited child subkey', async () => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': privilegedParentKey,
        'x-limited-key-id': String(limitedChildId),
      },
      body: JSON.stringify({ name: `Delegated limited child ${runId}` }),
    })

    expect(response.status).toBe(200)
  })

  it.concurrent('rejects apikey_manager app update without x-limited-key-id', async () => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': APIKEY_MANAGEMENT_APIKEY_MANAGER,
      },
      body: JSON.stringify({ name: `Manager direct ${runId}` }),
    })

    expect(response.status).toBe(401)
  })
})
