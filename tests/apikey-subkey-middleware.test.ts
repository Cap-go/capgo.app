import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_MANAGEMENT_APIKEY_MANAGER,
  APIKEY_MANAGEMENT_ORG_SUPER_ADMIN,
  BASE_URL,
  createDirectApiKeyWithBindings,
  executeSQL,
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
  const privilegedParentKey = APIKEY_MANAGEMENT_ORG_SUPER_ADMIN
  let sharedParentKey = ''
  const sharedChildIds: Record<string, number> = {}

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

    for (const state of ['parent', 'active', 'never-issued', 'revoked', 'expired']) {
      const key = randomUUID()
      // The schema permits both hash and plaintext on service-created rows.
      // Normal API-created shared keys have no plaintext and already fail the
      // existing plaintext-only subkey guard.
      const [shared] = await executeSQL<{ id: number, rbac_id: string }>(`
        INSERT INTO public.apikeys (user_id, key, key_hash, name, owner_org_id)
        VALUES ($1::uuid, CASE WHEN $5::boolean THEN NULL ELSE $2 END, encode(extensions.digest($2::text, 'sha256'), 'hex'), $3, $4::uuid)
        RETURNING id, rbac_id`, [USER_ID_APIKEY_MANAGEMENT, key, `shared subkey ${state} ${runId}`, ORG_ID_APIKEY_MANAGEMENT, state === 'parent'])
      createdKeyIds.push(Number(shared.id))
      createdKeyRbacIds.push(shared.rbac_id)
      await executeSQL(`
        INSERT INTO public.role_bindings (principal_type, principal_id, role_id, scope_type, org_id, granted_by)
        SELECT 'apikey', $1::uuid, id, 'org', $2::uuid, $3::uuid
        FROM public.roles WHERE name=$4 AND scope_type='org'`, [shared.rbac_id, ORG_ID_APIKEY_MANAGEMENT, USER_ID_APIKEY_MANAGEMENT, state === 'parent' ? 'org_super_admin' : 'org_admin'])
      if (state !== 'never-issued' && state !== 'revoked') {
        await executeSQL(`UPDATE public.apikeys
          SET shared_secret_user_id=$2::uuid,
              shared_secret_expires_at=CASE WHEN $3::boolean THEN now()-interval '1 second' ELSE NULL END
          WHERE id=$1`, [shared.id, USER_ID_APIKEY_MANAGEMENT, state === 'expired'])
      }
      if (state === 'revoked') {
        await executeSQL('UPDATE public.apikeys SET key=NULL, key_hash=encode(extensions.digest(gen_random_uuid()::text, \'sha256\'), \'hex\') WHERE id=$1', [shared.id])
      }
      if (state === 'parent')
        sharedParentKey = key
      else
        sharedChildIds[state] = Number(shared.id)
    }
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

  it.concurrent.each(['active', 'never-issued', 'revoked', 'expired'])('rejects a shared parent adopting a %s same-org shared subkey', async (state) => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': sharedParentKey,
        'x-limited-key-id': String(sharedChildIds[state]),
      },
      body: JSON.stringify({ name: `Shared subkey ${state} ${runId}` }),
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_subkey' })
  })

  it.concurrent('rejects a personal parent adopting a shared subkey', async () => {
    const response = await fetch(`${BASE_URL}/app/${appA}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': privilegedParentKey,
        'x-limited-key-id': String(sharedChildIds.active),
      },
      body: JSON.stringify({ name: `Personal parent shared child ${runId}` }),
    })
    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_subkey' })
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
