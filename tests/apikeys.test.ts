import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_MANAGEMENT_APIKEY_MANAGER,
  APIKEY_MANAGEMENT_APIKEY_MANAGER_ID,
  APIKEY_MANAGEMENT_ORG_SUPER_ADMIN,
  appApiKeyBindings,
  BASE_URL,
  executeSQL,
  getAuthHeaders,
  getAuthHeadersForCredentials,
  getSupabaseClient,
  ORG_ID_APIKEY_MANAGEMENT,
  orgApiKeyBindings,
  resetAndSeedAppData,
  resetAppData,
  USER_EMAIL_APIKEY_MANAGEMENT,
  USER_ID,
  USER_PASSWORD,
} from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.app.key.${id}`
let authHeaders: Record<string, string>

function orgKeyBody(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    bindings: orgApiKeyBindings(),
    ...extra,
  }
}

async function appKeyBody(name: string, appId = APPNAME, extra: Record<string, unknown> = {}) {
  return {
    name,
    bindings: await appApiKeyBindings(appId),
    ...extra,
  }
}

beforeAll(async () => {
  authHeaders = await getAuthHeaders()
  await resetAndSeedAppData(APPNAME)
})

afterAll(async () => {
  await resetAppData(APPNAME)
})

describe('[GET] /apikey operations', () => {
  it('get api keys for the user without key material', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'GET',
      headers: authHeaders,
    })

    const data = await response.json() as Array<Record<string, unknown>>
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
    expect(data.every(apikey => !('key' in apikey) && !('key_hash' in apikey))).toBe(true)
    expect(data.every(apikey => typeof apikey.is_hashed_key === 'boolean')).toBe(true)
  })

  it('get specific api key by id without key material', async () => {
    // Using seeded API key ID 10 (dedicated test key)
    const response = await fetch(`${BASE_URL}/apikey/10`, {
      method: 'GET',
      headers: authHeaders,
    })

    const data = await response.json() as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('id', 10)
    expect(data).not.toHaveProperty('key')
    expect(typeof data.is_hashed_key).toBe('boolean')
    expect(data).not.toHaveProperty('key_hash')
  })

  it('get legacy plain api key token without key material', async () => {
    const legacyKey = `legacy-key-${randomUUID()}`
    const [insertedKey] = await executeSQL(
      `
      WITH skip_apikey_trigger AS (
        SELECT set_config('capgo.skip_apikey_trigger', 'true', true)
      )
      INSERT INTO public.apikeys (user_id, key, key_hash, name)
      SELECT $1, $2, NULL, 'legacy-key-lookup-test'
      FROM skip_apikey_trigger
      RETURNING id
      `,
      [USER_ID, legacyKey],
    )
    expect(insertedKey).toHaveProperty('id')

    try {
      const response = await fetch(`${BASE_URL}/apikey/${legacyKey}`, {
        method: 'GET',
        headers: authHeaders,
      })

      const data = await response.json() as Record<string, unknown>
      expect(response.status).toBe(200)
      expect(data).toHaveProperty('id', Number(insertedKey?.id))
      expect(data).toHaveProperty('is_hashed_key', false)
      expect(data).not.toHaveProperty('key')
      expect(data).not.toHaveProperty('key_hash')
    }
    finally {
      if (insertedKey?.id)
        await getSupabaseClient().from('apikeys').delete().eq('id', Number(insertedKey.id))
    }
  })

  it('get api key with invalid id', async () => {
    const response = await fetch(`${BASE_URL}/apikey/424242`, {
      method: 'GET',
      headers: authHeaders,
    })
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'failed_to_get_apikey')
    expect(response.status).toBe(404)
  })
})

describe('[POST] /apikey operations', () => {
  it('create api key', async () => {
    const keyName = 'test-key-creation'
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody(keyName)),
    })
    const data = await response.json<{ key: string, id: number }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data).toHaveProperty('id')
    expect(typeof data.key).toBe('string')
    expect(typeof data.id).toBe('number')

    // Verify the created key
    const verifyResponse = await fetch(`${BASE_URL}/apikey/${data.id}`, { headers: authHeaders })
    const verifyData = await verifyResponse.json() as { name: string }
    expect(verifyData.name).toBe(keyName)
  })

  it.concurrent('creates an app-only preview key bound to its owning organization', async () => {
    const appBindings = await appApiKeyBindings(APPNAME, 'app_preview')
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: `app-preview-key-${id.slice(0, 8)}`,
        bindings: appBindings,
      }),
    })
    expect(response.status).toBe(200)
    const data = await response.json<{ id: number, rbac_id: string }>()

    try {
      const bindings = await executeSQL(
        `
        SELECT role_bindings.scope_type, role_bindings.org_id, role_bindings.app_id, roles.name AS role_name
        FROM public.role_bindings
        INNER JOIN public.roles ON roles.id = role_bindings.role_id
        WHERE role_bindings.principal_type = public.rbac_principal_apikey()
          AND role_bindings.principal_id = $1::uuid
        ORDER BY role_bindings.scope_type, roles.name
        `,
        [data.rbac_id],
      )

      expect(bindings).toEqual([expect.objectContaining({
        scope_type: 'app',
        org_id: appBindings[0].org_id,
        app_id: appBindings[0].app_id,
        role_name: 'app_preview',
      })])
    }
    finally {
      await fetch(`${BASE_URL}/apikey/${data.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
    }
  })

  it('app-limited key cannot create another API key', async () => {
    const limitedCreatorResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(await appKeyBody('app-key-creator')),
    })
    expect(limitedCreatorResponse.status).toBe(200)
    const limitedCreatorData = await limitedCreatorResponse.json<{ id: number, key: string }>()

    const limitedHeaders = {
      'Content-Type': 'application/json',
      'capgkey': limitedCreatorData.key,
    }

    const escalationResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: limitedHeaders,
      body: JSON.stringify(await appKeyBody('blocked-key-creation')),
    })
    const escalationData = await escalationResponse.json() as { error: string }
    expect(escalationResponse.status).toBe(400)
    expect(escalationData).toHaveProperty('error', 'cannot_create_apikey')

    await fetch(`${BASE_URL}/apikey/${limitedCreatorData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('app-limited key cannot manage sibling API keys', async () => {
    const createdKeyIds: number[] = []

    try {
      const limitedResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(await appKeyBody('app-management-blocked')),
      })
      expect(limitedResponse.status).toBe(200)
      const limitedData = await limitedResponse.json<{ id: number, key: string }>()
      createdKeyIds.push(limitedData.id)

      const siblingResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(orgKeyBody('sibling-management-target')),
      })
      expect(siblingResponse.status).toBe(200)
      const siblingData = await siblingResponse.json<{ id: number }>()
      createdKeyIds.push(siblingData.id)

      const limitedHeaders = {
        'Content-Type': 'application/json',
        'capgkey': limitedData.key,
      }

      const listResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'GET',
        headers: limitedHeaders,
      })
      expect(listResponse.status).toBe(401)
      await expect(listResponse.json()).resolves.toHaveProperty('error', 'cannot_list_apikeys')

      const getResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'GET',
        headers: limitedHeaders,
      })
      expect(getResponse.status).toBe(401)
      await expect(getResponse.json()).resolves.toHaveProperty('error', 'cannot_get_apikey')

      const updateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: limitedHeaders,
        body: JSON.stringify({
          name: 'sibling-renamed-by-limited-key',
        }),
      })
      expect(updateResponse.status).toBe(401)
      await expect(updateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const deleteResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'DELETE',
        headers: limitedHeaders,
      })
      expect(deleteResponse.status).toBe(401)
      await expect(deleteResponse.json()).resolves.toHaveProperty('error', 'cannot_delete_apikey')

      const verifyResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, { headers: authHeaders })
      expect(verifyResponse.status).toBe(200)
      const verifyData = await verifyResponse.json<{ name: string }>()
      expect(verifyData.name).toBe('sibling-management-target')
    }
    finally {
      for (const keyId of createdKeyIds.reverse()) {
        await fetch(`${BASE_URL}/apikey/${keyId}`, {
          method: 'DELETE',
          headers: authHeaders,
        })
      }
    }
  })

  it.concurrent('org-scoped non-admin API key cannot manage or upgrade API keys', async () => {
    const createdKeyIds: number[] = []
    const orgId = orgApiKeyBindings()[0].org_id

    try {
      const managerResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(orgKeyBody('org-management-blocked', {
          bindings: orgApiKeyBindings(orgId, 'org_member'),
        })),
      })
      expect(managerResponse.status).toBe(200)
      const managerData = await managerResponse.json<{ id: number, key: string }>()
      createdKeyIds.push(managerData.id)

      const siblingResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(orgKeyBody('org-sibling-management-target')),
      })
      expect(siblingResponse.status).toBe(200)
      const siblingData = await siblingResponse.json<{ id: number }>()
      createdKeyIds.push(siblingData.id)

      const managerHeaders = {
        'Content-Type': 'application/json',
        'capgkey': managerData.key,
      }

      const listResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'GET',
        headers: managerHeaders,
      })
      expect(listResponse.status).toBe(401)
      await expect(listResponse.json()).resolves.toHaveProperty('error', 'cannot_list_apikeys')

      const getResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'GET',
        headers: managerHeaders,
      })
      expect(getResponse.status).toBe(401)
      await expect(getResponse.json()).resolves.toHaveProperty('error', 'cannot_get_apikey')

      const updateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: managerHeaders,
        body: JSON.stringify({
          name: 'org-sibling-renamed-by-api-key',
        }),
      })
      expect(updateResponse.status).toBe(401)
      await expect(updateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const selfUpgradeResponse = await fetch(`${BASE_URL}/apikey/${managerData.id}`, {
        method: 'PUT',
        headers: managerHeaders,
        body: JSON.stringify({
          bindings: orgApiKeyBindings(orgId, 'org_super_admin'),
        }),
      })
      expect(selfUpgradeResponse.status).toBe(401)
      await expect(selfUpgradeResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const regenerateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: managerHeaders,
        body: JSON.stringify({
          regenerate: true,
        }),
      })
      expect(regenerateResponse.status).toBe(401)
      await expect(regenerateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const deleteResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'DELETE',
        headers: managerHeaders,
      })
      expect(deleteResponse.status).toBe(401)
      await expect(deleteResponse.json()).resolves.toHaveProperty('error', 'cannot_delete_apikey')

      const verifySiblingResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, { headers: authHeaders })
      expect(verifySiblingResponse.status).toBe(200)
      const verifySiblingData = await verifySiblingResponse.json<{ name: string }>()
      expect(verifySiblingData.name).toBe('org-sibling-management-target')

      const verifyManagerResponse = await fetch(`${BASE_URL}/apikey/${managerData.id}`, { headers: authHeaders })
      expect(verifyManagerResponse.status).toBe(200)
      const verifyManagerData = await verifyManagerResponse.json<{ name: string }>()
      expect(verifyManagerData.name).toBe('org-management-blocked')
    }
    finally {
      for (const keyId of createdKeyIds.reverse()) {
        await fetch(`${BASE_URL}/apikey/${keyId}`, {
          method: 'DELETE',
          headers: authHeaders,
        })
      }
    }
  })

  it.concurrent('org super admin API key can manage sibling API keys without self-upgrade', async () => {
    const createdKeyIds: number[] = []
    const dedicatedAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_APIKEY_MANAGEMENT, USER_PASSWORD)
    const superAdminKeyHeaders = {
      'Content-Type': 'application/json',
      'capgkey': APIKEY_MANAGEMENT_ORG_SUPER_ADMIN,
    }

    try {
      const siblingResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: dedicatedAuthHeaders,
        body: JSON.stringify(orgKeyBody('org-super-admin-key-sibling-management-target', {
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT),
        })),
      })
      expect(siblingResponse.status).toBe(200)
      const siblingData = await siblingResponse.json<{ id: number }>()
      createdKeyIds.push(siblingData.id)

      const listResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'GET',
        headers: superAdminKeyHeaders,
      })
      expect(listResponse.status).toBe(200)
      const listData = await listResponse.json<Array<{ id: number }>>()
      expect(listData.some(apikey => apikey.id === siblingData.id)).toBe(true)

      const getResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'GET',
        headers: superAdminKeyHeaders,
      })
      expect(getResponse.status).toBe(200)
      await expect(getResponse.json()).resolves.toHaveProperty('id', siblingData.id)

      const updateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: superAdminKeyHeaders,
        body: JSON.stringify({
          name: 'org-super-admin-key-renamed-sibling',
        }),
      })
      expect(updateResponse.status).toBe(200)
      await expect(updateResponse.json()).resolves.toHaveProperty('name', 'org-super-admin-key-renamed-sibling')

      const bindingUpdateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: superAdminKeyHeaders,
        body: JSON.stringify({
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_super_admin'),
        }),
      })
      expect(bindingUpdateResponse.status).toBe(401)
      await expect(bindingUpdateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const regenerateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: superAdminKeyHeaders,
        body: JSON.stringify({
          regenerate: true,
        }),
      })
      expect(regenerateResponse.status).toBe(200)
      await expect(regenerateResponse.json()).resolves.toHaveProperty('id', siblingData.id)

      const selfUpdateResponse = await fetch(`${BASE_URL}/apikey/112`, {
        method: 'PUT',
        headers: superAdminKeyHeaders,
        body: JSON.stringify({
          name: 'org-super-admin-key-self-update-blocked',
        }),
      })
      expect(selfUpdateResponse.status).toBe(401)
      await expect(selfUpdateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const selfBindingUpdateResponse = await fetch(`${BASE_URL}/apikey/112`, {
        method: 'PUT',
        headers: superAdminKeyHeaders,
        body: JSON.stringify({
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_super_admin'),
        }),
      })
      expect(selfBindingUpdateResponse.status).toBe(401)
      await expect(selfBindingUpdateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const selfDeleteResponse = await fetch(`${BASE_URL}/apikey/112`, {
        method: 'DELETE',
        headers: superAdminKeyHeaders,
      })
      expect(selfDeleteResponse.status).toBe(401)
      await expect(selfDeleteResponse.json()).resolves.toHaveProperty('error', 'cannot_delete_apikey')

      const deleteResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'DELETE',
        headers: superAdminKeyHeaders,
      })
      expect(deleteResponse.status).toBe(200)
      await expect(deleteResponse.json()).resolves.toHaveProperty('status', 'ok')

      const verifySiblingResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, { headers: dedicatedAuthHeaders })
      expect(verifySiblingResponse.status).toBe(404)
    }
    finally {
      for (const keyId of createdKeyIds.reverse()) {
        await fetch(`${BASE_URL}/apikey/${keyId}`, {
          method: 'DELETE',
          headers: dedicatedAuthHeaders,
        })
      }
    }
  })

  it.concurrent('apikey_manager API key can manage sibling keys but cannot create them', async () => {
    const dedicatedAuthHeaders = await getAuthHeadersForCredentials(USER_EMAIL_APIKEY_MANAGEMENT, USER_PASSWORD)
    const managerKeyHeaders = {
      'Content-Type': 'application/json',
      'capgkey': APIKEY_MANAGEMENT_APIKEY_MANAGER,
    }
    const createdKeyIds: number[] = []

    try {
      const siblingResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: dedicatedAuthHeaders,
        body: JSON.stringify(orgKeyBody('apikey-manager-sibling-target', {
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_member'),
        })),
      })
      expect(siblingResponse.status).toBe(200)
      const siblingData = await siblingResponse.json<{ id: number }>()
      createdKeyIds.push(siblingData.id)

      const listResponse = await fetch(`${BASE_URL}/apikey`, { method: 'GET', headers: managerKeyHeaders })
      expect(listResponse.status).toBe(200)
      const listData = await listResponse.json<Array<{ id: number }>>()
      expect(listData.some(apikey => apikey.id === siblingData.id)).toBe(true)

      const createResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: managerKeyHeaders,
        body: JSON.stringify(orgKeyBody('apikey-manager-created-sibling', {
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_member'),
        })),
      })
      expect(createResponse.status).toBe(400)
      await expect(createResponse.json()).resolves.toHaveProperty('error', 'cannot_create_apikey')

      const updateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: managerKeyHeaders,
        body: JSON.stringify({ name: 'apikey-manager-renamed-sibling' }),
      })
      expect(updateResponse.status).toBe(200)

      const bindingUpdateResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'PUT',
        headers: managerKeyHeaders,
        body: JSON.stringify({
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_super_admin'),
        }),
      })
      expect(bindingUpdateResponse.status).toBe(401)
      await expect(bindingUpdateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const privilegedCreateResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: managerKeyHeaders,
        body: JSON.stringify(orgKeyBody('apikey-manager-blocked-privileged-create', {
          bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_super_admin'),
        })),
      })
      expect(privilegedCreateResponse.status).toBe(400)
      await expect(privilegedCreateResponse.json()).resolves.toHaveProperty('error', 'cannot_create_apikey')

      const appAdminCreateResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: managerKeyHeaders,
        body: JSON.stringify({
          name: 'apikey-manager-blocked-app-admin-create',
          bindings: [{
            role_name: 'app_admin',
            scope_type: 'app',
            org_id: ORG_ID_APIKEY_MANAGEMENT,
            app_id: APPNAME,
          }],
        }),
      })
      expect(appAdminCreateResponse.status).toBe(400)
      await expect(appAdminCreateResponse.json()).resolves.toHaveProperty('error', 'cannot_create_apikey')

      const allowSystemRoleBypassResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: managerKeyHeaders,
        body: JSON.stringify({
          name: 'apikey-manager-blocked-allow-system-role-bypass',
          bindings: [{
            role_name: 'app_admin',
            scope_type: 'app',
            org_id: ORG_ID_APIKEY_MANAGEMENT,
            app_id: APPNAME,
            allowSystemRole: true,
          }],
        }),
      })
      expect(allowSystemRoleBypassResponse.status).toBe(400)
      await expect(allowSystemRoleBypassResponse.json()).resolves.toHaveProperty('error', 'cannot_create_apikey')

      const selfUpdateResponse = await fetch(`${BASE_URL}/apikey/${APIKEY_MANAGEMENT_APIKEY_MANAGER_ID}`, {
        method: 'PUT',
        headers: managerKeyHeaders,
        body: JSON.stringify({ name: 'apikey-manager-self-update-blocked' }),
      })
      expect(selfUpdateResponse.status).toBe(401)
      await expect(selfUpdateResponse.json()).resolves.toHaveProperty('error', 'cannot_update_apikey')

      const deleteResponse = await fetch(`${BASE_URL}/apikey/${siblingData.id}`, {
        method: 'DELETE',
        headers: managerKeyHeaders,
      })
      expect(deleteResponse.status).toBe(200)
      createdKeyIds.splice(createdKeyIds.indexOf(siblingData.id), 1)
    }
    finally {
      for (const keyId of createdKeyIds.reverse()) {
        await fetch(`${BASE_URL}/apikey/${keyId}`, {
          method: 'DELETE',
          headers: dedicatedAuthHeaders,
        })
      }
    }
  })

  it.concurrent('rejects API key POST creation even for an org super admin key', async () => {
    const superAdminKeyHeaders = {
      'Content-Type': 'application/json',
      'capgkey': APIKEY_MANAGEMENT_ORG_SUPER_ADMIN,
    }

    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: superAdminKeyHeaders,
      body: JSON.stringify(orgKeyBody('org-super-admin-key-creation-blocked', {
        bindings: orgApiKeyBindings(ORG_ID_APIKEY_MANAGEMENT, 'org_member'),
      })),
    })

    expect(createResponse.status).toBe(400)
    await expect(createResponse.json()).resolves.toHaveProperty('error', 'cannot_create_apikey')
  })

  it('create api key with missing name', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'name_is_required')
  })

  it('create api key with empty name', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: '' }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'name_is_required')
  })

  it('create api key with invalid binding scope', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'test-key',
        bindings: [{ role_name: 'org_admin', scope_type: 'invalid', org_id: randomUUID() }],
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'invalid_bindings')
  })

  it('create api key with non-existent org_id', async () => {
    const nonExistentOrgId = randomUUID()
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'test-key',
        bindings: orgApiKeyBindings(nonExistentOrgId),
      }),
    })
    expect(response.status).toBe(403)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'forbidden_binding')
  })

  it('create api key with non-existent app_id', async () => {
    const nonExistentAppId = randomUUID()
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'test-key',
        bindings: [{
          role_name: 'app_admin',
          scope_type: 'app',
          org_id: orgApiKeyBindings()[0].org_id,
          app_id: nonExistentAppId,
        }],
      }),
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error', 'binding_failed')
  })

  it('create api key with invalid JSON body', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: 'invalid json',
    })
    expect(response.status).toBeGreaterThanOrEqual(400)
  })
})

describe('[PUT] /apikey/:id operations', () => {
  it('update api key name', async () => {
    // Using seeded API key ID 11 (dedicated test key for update name)
    const newName = 'updated-test-key-name'
    const response = await fetch(`${BASE_URL}/apikey/11`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        name: newName,
      }),
    })

    const data = await response.json()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('name', newName)

    // Verify the update
    const verifyResponse = await fetch(`${BASE_URL}/apikey/11`, { headers: authHeaders })
    const verifyData = await verifyResponse.json() as { name: string }
    expect(verifyData.name).toBe(newName)
  })

  it.concurrent('metadata updates do not return plain or hashed key material', async () => {
    const createdKeyIds: number[] = []

    try {
      for (const hashed of [false, true]) {
        const suffix = hashed ? 'hashed' : 'plain'
        const createResponse = await fetch(`${BASE_URL}/apikey`, {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify(orgKeyBody(`temp-metadata-no-leak-${suffix}-${randomUUID()}`, { hashed })),
        })
        expect(createResponse.status).toBe(200)
        const createData = await createResponse.json<{ id: number }>()
        createdKeyIds.push(createData.id)

        const newName = `temp-metadata-updated-${suffix}-${randomUUID()}`
        const updateResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
          method: 'PUT',
          headers: authHeaders,
          body: JSON.stringify({ name: newName }),
        })
        const updateData = await updateResponse.json() as Record<string, unknown>

        expect(updateResponse.status).toBe(200)
        expect(updateData).toHaveProperty('id', createData.id)
        expect(updateData).toHaveProperty('name', newName)
        expect(updateData).not.toHaveProperty('key')
        expect(updateData).not.toHaveProperty('key_hash')
      }
    }
    finally {
      for (const keyId of createdKeyIds.reverse()) {
        await fetch(`${BASE_URL}/apikey/${keyId}`, {
          method: 'DELETE',
          headers: authHeaders,
        })
      }
    }
  })

  it.concurrent('updates api key role bindings', async () => {
    let createData: { id: number, rbac_id: string } | undefined

    try {
      const createResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify(orgKeyBody('temp-key-update-bindings')),
      })
      expect(createResponse.status).toBe(200)
      createData = await createResponse.json<{ id: number, rbac_id: string }>()

      const appBindings = await appApiKeyBindings(APPNAME, 'app_reader')
      const updateResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          bindings: appBindings,
        }),
      })
      expect(updateResponse.status).toBe(200)

      const { data: bindings, error } = await getSupabaseClient()
        .from('role_bindings')
        .select('scope_type, app_id, roles(name)')
        .eq('principal_type', 'apikey')
        .eq('principal_id', createData.rbac_id)

      expect(error).toBeNull()
      const bindingRows = (bindings || []) as any[]
      expect(bindingRows).toEqual([
        expect.objectContaining({
          scope_type: 'app',
          app_id: appBindings[0].app_id,
          roles: expect.objectContaining({ name: 'app_reader' }),
        }),
      ])
    }
    finally {
      if (createData) {
        await fetch(`${BASE_URL}/apikey/${createData.id}`, { method: 'DELETE', headers: authHeaders })
      }
    }
  })

  it('update api key with invalid id', async () => {
    const response = await fetch(`${BASE_URL}/apikey/424242`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ name: 'wont-work' }),
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error')
  })

  it('update api key with unsupported field has no valid fields', async () => {
    // Using seeded API key ID 12 (dedicated test key)
    const response = await fetch(`${BASE_URL}/apikey/12`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        unsupported_field: 'invalid',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toContain('no_valid_fields_provided_for_update')
  })

  it('update api key with unsupported app scope field has no valid fields', async () => {
    // Using seeded API key ID 13 (dedicated test key for update apps)
    const response = await fetch(`${BASE_URL}/apikey/13`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        unsupported_app_scope: 'not_an_array',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toContain('no_valid_fields_provided_for_update')
  })

  it('update api key with unsupported org scope field has no valid fields', async () => {
    // Create a temporary key for this test
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('temp-test-key')),
    })
    const createData = await createResponse.json<{ id: number }>()

    const response = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({
        unsupported_org_scope: 'not_an_array',
      }),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toContain('no_valid_fields_provided_for_update')
  })

  it('update api key with no valid fields', async () => {
    // Create a temporary key for this test
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('temp-test-key-2')),
    })
    const createData = await createResponse.json<{ id: number }>()

    const response = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({}),
    })
    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toContain('no_valid_fields_provided_for_update')
  })

  it('regenerate plain api key (key changes and old key no longer works)', async () => {
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('temp-plain-key-regenerate', { hashed: false })),
    })
    const createData = await createResponse.json<{ id: number, key: string }>()
    expect(createResponse.status).toBe(200)
    expect(typeof createData.key).toBe('string')

    const oldKey = createData.key

    const regenerateResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ regenerate: true }),
    })
    const regenerateData = await regenerateResponse.json<{ id: number, key: string }>()
    expect(regenerateResponse.status).toBe(200)
    expect(regenerateData.id).toBe(createData.id)
    expect(typeof regenerateData.key).toBe('string')
    expect(regenerateData.key).not.toBe(oldKey)

    // Old key must no longer authenticate.
    const oldAuthHeaders = { 'Content-Type': 'application/json', 'Authorization': oldKey }
    const oldAuthResponse = await fetch(`${BASE_URL}/apikey`, { method: 'GET', headers: oldAuthHeaders })
    expect(oldAuthResponse.status).toBe(401)

    // New key must authenticate and keep its RBAC management permission.
    const newAuthHeaders = { 'Content-Type': 'application/json', 'Authorization': regenerateData.key }
    const newAuthResponse = await fetch(`${BASE_URL}/apikey`, { method: 'GET', headers: newAuthHeaders })
    expect(newAuthResponse.status).toBe(200)
    await expect(newAuthResponse.json()).resolves.toEqual(expect.any(Array))

    await fetch(`${BASE_URL}/apikey/${createData.id}`, { method: 'DELETE', headers: authHeaders })
  })

  it('regenerate hashed api key (key changes and remains hashed in DB)', async () => {
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('temp-hashed-key-regenerate', { hashed: true })),
    })
    const createData = await createResponse.json<{ id: number, key: string, key_hash: string }>()
    expect(createResponse.status).toBe(200)

    const oldKey = createData.key
    const oldHash = createData.key_hash

    const regenerateResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ regenerate: true }),
    })
    const regenerateData = await regenerateResponse.json<{ id: number, key: string, key_hash: string }>()
    expect(regenerateResponse.status).toBe(200)
    expect(regenerateData.id).toBe(createData.id)
    expect(regenerateData.key).not.toBe(oldKey)
    expect(regenerateData.key_hash).not.toBe(oldHash)

    const { data: verifyData, error: verifyError } = await getSupabaseClient()
      .from('apikeys')
      .select('key, key_hash')
      .eq('id', createData.id)
      .single()
    expect(verifyError).toBeNull()
    expect(verifyData?.key).toBeNull()
    expect(verifyData?.key_hash).toBe(regenerateData.key_hash)

    // Old key must no longer authenticate.
    const oldAuthHeaders = { 'Content-Type': 'application/json', 'Authorization': oldKey }
    const oldAuthResponse = await fetch(`${BASE_URL}/apikey`, { method: 'GET', headers: oldAuthHeaders })
    expect(oldAuthResponse.status).toBe(401)

    // New key must authenticate and keep its RBAC management permission.
    const newAuthHeaders = { 'Content-Type': 'application/json', 'Authorization': regenerateData.key }
    const newAuthResponse = await fetch(`${BASE_URL}/apikey`, { method: 'GET', headers: newAuthHeaders })
    expect(newAuthResponse.status).toBe(200)
    await expect(newAuthResponse.json()).resolves.toEqual(expect.any(Array))

    await fetch(`${BASE_URL}/apikey/${createData.id}`, { method: 'DELETE', headers: authHeaders })
  })

  it('regenerate and update name in a single request', async () => {
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('temp-key-regenerate-and-rename', { hashed: false })),
    })
    const createData = await createResponse.json<{ id: number, key: string }>()
    expect(createResponse.status).toBe(200)

    const newName = 'temp-key-regenerated-renamed'
    const regenerateResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ regenerate: true, name: newName }),
    })
    const regenerateData = await regenerateResponse.json() as { id: number, name: string, key: string }
    expect(regenerateResponse.status).toBe(200)
    expect(regenerateData.name).toBe(newName)
    expect(regenerateData.key).not.toBe(createData.key)

    await fetch(`${BASE_URL}/apikey/${createData.id}`, { method: 'DELETE', headers: authHeaders })
  })

  it('regenerate non-existent key returns 404', async () => {
    const response = await fetch(`${BASE_URL}/apikey/424242`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ regenerate: true }),
    })
    expect(response.status).toBe(404)
  })
})

describe('[DELETE] /apikey/:id operations', () => {
  it('delete api key', async () => {
    // Create a key specifically for deletion
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-to-delete')),
    })
    const createData = await createResponse.json<{ id: number }>()

    const response = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })

    const data = await response.json() as { status: string }
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('status', 'ok')

    // Verify deletion
    const verifyResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, { headers: authHeaders })
    expect(verifyResponse.status).toBe(404)
  })

  it('delete api key with invalid id', async () => {
    const response = await fetch(`${BASE_URL}/apikey/424242`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error')
  })

  it('delete already deleted api key', async () => {
    // Create and delete a key, then try to delete again
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(orgKeyBody('key-to-double-delete')),
    })
    const createData = await createResponse.json<{ id: number }>()

    // First deletion
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })

    // Second deletion attempt
    const response = await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
    expect(response.status).toBe(404)
    const data = await response.json() as { error: string }
    expect(data).toHaveProperty('error')
  })
})

describe('[POST] /apikey hashed key operations', () => {
  it('create hashed api key', async () => {
    const keyName = 'test-hashed-key'
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: keyName,
        hashed: true,
        bindings: orgApiKeyBindings(),
      }),
    })
    const data = await response.json<{ key: string, key_hash: string, id: number }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data).toHaveProperty('key_hash')
    expect(data).toHaveProperty('id')
    expect(typeof data.key).toBe('string')
    expect(typeof data.key_hash).toBe('string')
    // The key should be a UUID format
    expect(data.key).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
    // The key_hash should be a SHA-256 hex string (64 characters)
    expect(data.key_hash).toMatch(/^[\da-f]{64}$/i)

    // Verify the created key exists but key column in DB should be null
    const { data: verifyData, error: verifyError } = await getSupabaseClient()
      .from('apikeys')
      .select('name, key, key_hash')
      .eq('id', data.id)
      .single()
    expect(verifyError).toBeNull()
    expect(verifyData?.name).toBe(keyName)
    // In the database, the key should be null for hashed keys
    expect(verifyData?.key).toBeNull()
    expect(verifyData?.key_hash).toBe(data.key_hash)

    // Public GET must not expose key material.
    const publicResponse = await fetch(`${BASE_URL}/apikey/${data.id}`, { headers: authHeaders })
    const publicData = await publicResponse.json() as Record<string, unknown>
    expect(publicData).toHaveProperty('is_hashed_key', true)
    expect(publicResponse.status).toBe(200)
    expect(publicData).not.toHaveProperty('key')
    expect(publicData).not.toHaveProperty('key_hash')

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${data.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('create plain api key (hashed: false)', async () => {
    const keyName = 'test-plain-key-explicit'
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: keyName,
        hashed: false,
        bindings: orgApiKeyBindings(),
      }),
    })
    const data = await response.json<{ key: string, key_hash: string | null, id: number }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(typeof data.key).toBe('string')
    // Plain key should not have key_hash set
    expect(data.key_hash).toBeNull()

    // Verify the key is stored in plain
    const { data: verifyData, error: verifyError } = await getSupabaseClient()
      .from('apikeys')
      .select('key, key_hash')
      .eq('id', data.id)
      .single()
    expect(verifyError).toBeNull()
    expect(verifyData?.key).toBe(data.key)
    expect(verifyData?.key_hash).toBeNull()

    // Public GET must not expose key material.
    const publicResponse = await fetch(`${BASE_URL}/apikey/${data.id}`, { headers: authHeaders })
    const publicData = await publicResponse.json() as Record<string, unknown>
    expect(publicResponse.status).toBe(200)
    expect(publicData).toHaveProperty('is_hashed_key', false)
    expect(publicData).not.toHaveProperty('key')
    expect(publicData).not.toHaveProperty('key_hash')

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${data.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('create hashed api key with V2 bindings', async () => {
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-with-options',
        hashed: true,
        bindings: orgApiKeyBindings(),
      }),
    })
    const data = await response.json<{ key: string, key_hash: string, id: number }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data).toHaveProperty('key_hash')

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${data.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('hashed key can be used for authentication', async () => {
    // Create a hashed key
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-for-auth-test',
        hashed: true,
        bindings: orgApiKeyBindings(),
      }),
    })
    const createData = await createResponse.json<{ key: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Use the plain key value to authenticate (the system should hash it and find the key)
    const createdKeyHeaders = {
      'Content-Type': 'application/json',
      'Authorization': createData.key,
    }

    // Try to list API keys using the hashed key for auth.
    const listResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'GET',
      headers: createdKeyHeaders,
    })
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toEqual(expect.any(Array))

    // Cleanup - use original headers since new key might have restrictions
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })
})

describe('[POST] /apikey hashed key with expiration', () => {
  it('create hashed api key with expiration date', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days from now
    const response = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-with-expiration',
        hashed: true,
        expires_at: futureDate,
        bindings: orgApiKeyBindings(),
      }),
    })
    const data = await response.json<{ key: string, key_hash: string, id: number, expires_at: string }>()
    expect(response.status).toBe(200)
    expect(data).toHaveProperty('key')
    expect(data).toHaveProperty('key_hash')
    expect(data).toHaveProperty('expires_at')
    // Key should be UUID format
    expect(data.key).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i)
    // key_hash should be SHA-256 hex (64 chars)
    expect(data.key_hash).toMatch(/^[\da-f]{64}$/i)
    // expires_at should match what we sent
    expect(new Date(data.expires_at).getTime()).toBeCloseTo(new Date(futureDate).getTime(), -3)

    // Verify in DB: key should be null, key_hash and expires_at should be set
    const { data: verifyData, error: verifyError } = await getSupabaseClient()
      .from('apikeys')
      .select('key, key_hash, expires_at')
      .eq('id', data.id)
      .single()
    expect(verifyError).toBeNull()
    expect(verifyData?.key).toBeNull()
    expect(verifyData?.key_hash).toBe(data.key_hash)
    expect(verifyData?.expires_at).not.toBeNull()

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${data.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('hashed key with expiration can be used for authentication', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-expiration-auth-test',
        hashed: true,
        expires_at: futureDate,
        bindings: orgApiKeyBindings(),
      }),
    })
    const createData = await createResponse.json<{ key: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Use the plain key value to authenticate
    const createdKeyHeaders = {
      'Content-Type': 'application/json',
      'Authorization': createData.key,
    }

    const listResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'GET',
      headers: createdKeyHeaders,
    })
    expect(listResponse.status).toBe(200)
    await expect(listResponse.json()).resolves.toEqual(expect.any(Array))

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('expired hashed key should be rejected for authentication', async () => {
    // Create a hashed key with future expiration
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-to-expire',
        hashed: true,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        bindings: orgApiKeyBindings(),
      }),
    })
    const createData = await createResponse.json<{ key: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Manually set the key to expired via direct DB update
    const { error } = await getSupabaseClient().from('apikeys').update({ expires_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() }).eq('id', createData.id)
    expect(error).toBeNull()

    // Try to use the expired hashed key for authentication
    const expiredKeyHeaders = {
      'Content-Type': 'application/json',
      'Authorization': createData.key,
    }

    const listResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'GET',
      headers: expiredKeyHeaders,
    })
    // Should be rejected as unauthorized
    expect(listResponse.status).toBe(401)
  })
})

describe('[RLS] hashed API key with direct Supabase SDK', () => {
  it('hashed key works with RLS via Supabase SDK (simulating CLI usage)', async () => {
    // Create a hashed key via API
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'hashed-key-rls-test',
        hashed: true,
        bindings: orgApiKeyBindings(),
      }),
    })
    const createData = await createResponse.json<{ key: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Now use the hashed key directly with Supabase SDK (bypassing our API)
    // This simulates how the CLI uses the SDK with capgkey header
    const supabaseWithHashedKey = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            capgkey: createData.key, // The plain key that user received
          },
        },
      },
    )

    // Try to query apps table - this goes through RBAC-backed RLS.
    const { data: apps, error: appsError } = await supabaseWithHashedKey
      .from('apps')
      .select('app_id, name')
      .limit(5)

    expect(appsError).toBeNull()
    expect(Array.isArray(apps)).toBe(true)

    // Also test calling an RPC that uses request-scoped RBAC identity.
    const { data: orgs, error: orgsError } = await supabaseWithHashedKey
      .rpc('get_orgs_v7')

    expect(orgsError).toBeNull()
    expect(Array.isArray(orgs)).toBe(true)

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it('plain key still works with RLS via Supabase SDK', async () => {
    // Create a plain (non-hashed) key via API
    const createResponse = await fetch(`${BASE_URL}/apikey`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'plain-key-rls-test',
        hashed: false,
        bindings: orgApiKeyBindings(),
      }),
    })
    const createData = await createResponse.json<{ key: string, id: number }>()
    expect(createResponse.status).toBe(200)

    // Use plain key with Supabase SDK
    const supabaseWithPlainKey = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_ANON_KEY!,
      {
        global: {
          headers: {
            capgkey: createData.key,
          },
        },
      },
    )

    // Try to query apps table
    const { data: apps, error: appsError } = await supabaseWithPlainKey
      .from('apps')
      .select('app_id, name')
      .limit(5)

    expect(appsError).toBeNull()
    expect(Array.isArray(apps)).toBe(true)

    // Cleanup
    await fetch(`${BASE_URL}/apikey/${createData.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    })
  })

  it.concurrent('plain key cannot update apikeys table directly through RLS', async () => {
    let createdKeyId: number | undefined

    try {
      const createResponse = await fetch(`${BASE_URL}/apikey`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          name: 'plain-key-rls-apikey-update-blocked',
          hashed: false,
          bindings: orgApiKeyBindings(),
        }),
      })
      const createData = await createResponse.json<{ key: string, id: number }>()
      expect(createResponse.status).toBe(200)
      createdKeyId = createData.id

      const supabaseWithPlainKey = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_ANON_KEY!,
        {
          global: {
            headers: {
              capgkey: createData.key,
            },
          },
        },
      )

      const { data: updateData, error: updateError } = await supabaseWithPlainKey
        .from('apikeys')
        .update({ name: 'plain-key-rls-update-should-not-stick' })
        .eq('id', createData.id)
        .select('id, name')

      if (updateError) {
        expect(updateError.message).toMatch(/permission denied|row-level|not allowed|denied/i)
      }
      else {
        expect(updateData).toEqual([])
      }

      const verifyResponse = await fetch(`${BASE_URL}/apikey/${createData.id}`, { headers: authHeaders })
      expect(verifyResponse.status).toBe(200)
      const verifyData = await verifyResponse.json<{ name: string }>()
      expect(verifyData.name).toBe('plain-key-rls-apikey-update-blocked')
    }
    finally {
      if (createdKeyId !== undefined) {
        await fetch(`${BASE_URL}/apikey/${createdKeyId}`, {
          method: 'DELETE',
          headers: authHeaders,
        })
      }
    }
  })
})
