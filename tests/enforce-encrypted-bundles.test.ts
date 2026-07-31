import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APIKEY_ENCRYPTED, APP_NAME_ENCRYPTED, createDirectApiKeyWithBindings, getAuthHeadersForCredentials, getEndpointUrl, getSupabaseClient, ORG_ID_ENCRYPTED, SUPABASE_ANON_KEY, SUPABASE_BASE_URL, USER_ID, USER_ID_2, USER_ID_ENCRYPTED, USER_PASSWORD } from './test-utils.ts'

// This test file uses ISOLATED test data seeded in seed.sql:
// - USER_ID_ENCRYPTED: f6a7b8c9-d0e1-4f2a-9b3c-4d5e6f708193
// - ORG_ID_ENCRYPTED: a7b8c9d0-e1f2-4a3b-9c4d-5e6f7a8b9ca4
// - APIKEY_ENCRYPTED: b8c9d0e1-f2a3-4b4c-9d5e-6f7a8b9c0d14
// - APP_NAME_ENCRYPTED: com.encrypted.app
// This ensures test isolation and prevents interference with parallel tests.

const APIKEY_ENCRYPTED_SCOPED_NAME = `encrypted scoped test key ${randomUUID()}`
const headersEncrypted = {
  'Content-Type': 'application/json',
  'Authorization': APIKEY_ENCRYPTED,
}
const USER_EMAIL_ENCRYPTED = 'encrypted@capgo.app'
const USER_EMAIL_2 = 'test2@capgo.app'
let authHeadersEncrypted: Record<string, string>
let authHeadersUser2: Record<string, string>
let apiKeyEncryptedScoped: string

async function resetEncryptedBundleSettings() {
  await getSupabaseClient()
    .from('orgs')
    .update({ enforce_encrypted_bundles: false, required_encryption_key: null })
    .eq('id', ORG_ID_ENCRYPTED)
    .throwOnError()
}

async function enableEncryptedBundleEnforcement() {
  await getSupabaseClient()
    .from('orgs')
    .update({ enforce_encrypted_bundles: true })
    .eq('id', ORG_ID_ENCRYPTED)
    .throwOnError()
}

async function withEncryptedBundleEnforcement<T>(callback: () => Promise<T>) {
  await enableEncryptedBundleEnforcement()
  try {
    return await callback()
  }
  finally {
    await resetEncryptedBundleSettings()
  }
}

async function createStaleLegacySuperAdminFixture() {
  const id = randomUUID()
  const orgId = randomUUID()
  const appUuid = randomUUID()
  const appId = `com.encrypted.rbac-stale.${id}`
  const bundleName = `stale-rbac-${id}`
  const supabase = getSupabaseClient()

  const { error: orgError } = await supabase.from('orgs').insert({
    id: orgId,
    created_by: USER_ID,
    name: `Encrypted RBAC Stale Org ${id}`,
    management_email: `encrypted-rbac-stale-${id}@capgo.app`,
  })
  if (orgError)
    throw orgError

  const { error: appError } = await supabase.from('apps').insert({
    id: appUuid,
    app_id: appId,
    owner_org: orgId,
    icon_url: 'encrypted-rbac-stale-icon',
    name: `Encrypted RBAC Stale App ${id}`,
  })
  if (appError)
    throw appError

  const { data: memberRole, error: roleError } = await supabase
    .from('roles')
    .select('id')
    .eq('name', 'org_member')
    .single()
  if (roleError)
    throw roleError

  const { error: memberError } = await supabase.from('org_users').insert({
    org_id: orgId,
    user_id: USER_ID_2,
    rbac_role_name: 'org_member',
  })
  if (memberError)
    throw memberError

  await supabase
    .from('role_bindings')
    .delete()
    .eq('principal_type', 'user')
    .eq('principal_id', USER_ID_2)
    .eq('org_id', orgId)

  const { error: bindingError } = await supabase.from('role_bindings').insert({
    principal_type: 'user',
    principal_id: USER_ID_2,
    role_id: memberRole!.id,
    scope_type: 'org',
    org_id: orgId,
    granted_by: USER_ID,
    reason: 'stale org_users metadata regression',
    is_direct: true,
  })
  if (bindingError)
    throw bindingError

  const { error: staleLegacyError } = await supabase
    .from('org_users')
    .update({ rbac_role_name: 'org_super_admin' })
    .eq('org_id', orgId)
    .eq('user_id', USER_ID_2)
    .is('app_id', null)
    .is('channel_id', null)
  if (staleLegacyError)
    throw staleLegacyError

  const { data: version, error: versionError } = await supabase
    .from('app_versions')
    .insert({
      app_id: appId,
      name: bundleName,
      checksum: `stale-rbac-${id}`,
      owner_org: orgId,
      user_id: USER_ID,
      storage_provider: 'r2',
      r2_path: `orgs/${orgId}/apps/${appId}/${bundleName}.zip`,
      deleted: false,
    })
    .select('id')
    .single()
  if (versionError)
    throw versionError

  return {
    orgId,
    appId,
    appUuid,
    versionId: version!.id,
    cleanup: async () => {
      await supabase.from('app_versions').delete().eq('owner_org', orgId)
      await supabase.from('role_bindings').delete().eq('org_id', orgId)
      await supabase.from('org_users').delete().eq('org_id', orgId)
      await supabase.from('apps').delete().eq('id', appUuid)
      await supabase.from('orgs').delete().eq('id', orgId)
    },
  }
}

async function callBundleCleanupRpc(functionName: 'count_non_compliant_bundles' | 'delete_non_compliant_bundles', orgId: string) {
  return fetch(`${SUPABASE_BASE_URL}/rest/v1/rpc/${functionName}`, {
    method: 'POST',
    headers: {
      ...authHeadersUser2,
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ org_id: orgId }),
  })
}

beforeAll(async () => {
  authHeadersEncrypted = await getAuthHeadersForCredentials(USER_EMAIL_ENCRYPTED, USER_PASSWORD)
  authHeadersUser2 = await getAuthHeadersForCredentials(USER_EMAIL_2, USER_PASSWORD)

  // Ensure enforcement is disabled at the start of tests
  await resetEncryptedBundleSettings()

  const scopedApiKey = await createDirectApiKeyWithBindings({
    userId: USER_ID_ENCRYPTED,
    key: APIKEY_ENCRYPTED_SCOPED_NAME,
    name: APIKEY_ENCRYPTED_SCOPED_NAME,
    orgId: ORG_ID_ENCRYPTED,
    roleName: 'org_member',
    appId: APP_NAME_ENCRYPTED,
    appRoleName: 'app_admin',
  })

  if (!scopedApiKey.key)
    throw new Error('Failed to seed scoped encrypted API key')

  apiKeyEncryptedScoped = scopedApiKey.key

  // Clean up any test versions from previous test runs
  await getSupabaseClient()
    .from('app_versions')
    .delete()
    .eq('app_id', APP_NAME_ENCRYPTED)
    .neq('name', 'builtin')
    .neq('name', 'unknown')
}, 60_000)

afterAll(async () => {
  // Clean up test versions
  await getSupabaseClient()
    .from('app_versions')
    .delete()
    .eq('app_id', APP_NAME_ENCRYPTED)
    .neq('name', 'builtin')
    .neq('name', 'unknown')

  // Reset enforcement to false
  await resetEncryptedBundleSettings()

  await getSupabaseClient()
    .from('apikeys')
    .delete()
    .eq('name', APIKEY_ENCRYPTED_SCOPED_NAME)
    .throwOnError()
}, 60_000)

describe('[Encrypted Bundles Enforcement]', () => {
  describe('org Setting Management', () => {
    it('should have enforce_encrypted_bundles = false by default', async () => {
      const { data, error } = await getSupabaseClient()
        .from('orgs')
        .select('enforce_encrypted_bundles')
        .eq('id', ORG_ID_ENCRYPTED)
        .single()

      expect(error).toBeNull()
      expect(data?.enforce_encrypted_bundles).toBe(false)
    })

    it('should allow updating enforce_encrypted_bundles setting', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const { data, error } = await getSupabaseClient()
          .from('orgs')
          .select('enforce_encrypted_bundles')
          .eq('id', ORG_ID_ENCRYPTED)
          .single()

        expect(error).toBeNull()
        expect(data?.enforce_encrypted_bundles).toBe(true)
      })
    })

    it('should update encrypted bundle settings through the organization endpoint', async () => {
      const requiredKey = 'a'.repeat(21)

      try {
        const response = await fetch(getEndpointUrl('/organization'), {
          headers: authHeadersEncrypted,
          method: 'PUT',
          body: JSON.stringify({
            orgId: ORG_ID_ENCRYPTED,
            enforce_encrypted_bundles: true,
            required_encryption_key: requiredKey,
          }),
        })
        expect(response.status).toBe(200)

        const { data, error } = await getSupabaseClient()
          .from('orgs')
          .select('enforce_encrypted_bundles, required_encryption_key')
          .eq('id', ORG_ID_ENCRYPTED)
          .single()

        expect(error).toBeNull()
        expect(data?.enforce_encrypted_bundles).toBe(true)
        expect(data?.required_encryption_key).toBe(requiredKey)
      }
      finally {
        await resetEncryptedBundleSettings()
      }
    })

    it('should reject invalid required encryption key through the organization endpoint', async () => {
      const response = await fetch(getEndpointUrl('/organization'), {
        headers: authHeadersEncrypted,
        method: 'PUT',
        body: JSON.stringify({
          orgId: ORG_ID_ENCRYPTED,
          required_encryption_key: 'short',
        }),
      })
      expect(response.status).toBe(400)

      const responseData = await response.json() as { error: string }
      expect(responseData.error).toBe('invalid_required_encryption_key')
    })
  })

  describe('aPI Bundle Creation Enforcement', () => {
    it('should reject unencrypted bundle via API when enforcement is enabled', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const response = await fetch(getEndpointUrl('/bundle'), {
          method: 'POST',
          headers: headersEncrypted,
          body: JSON.stringify({
            app_id: APP_NAME_ENCRYPTED,
            version: '1.0.0-unencrypted-api-test',
            checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
            external_url: 'https://example.com/bundle-unencrypted.zip',
          }),
        })

        expect(response.ok).toBe(false)
        const data = await response.json() as { error: string }
        expect(data.error).toContain('encryption')
      })
    })

    it('should allow encrypted bundle via API when enforcement is enabled', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const response = await fetch(getEndpointUrl('/bundle'), {
          method: 'POST',
          headers: headersEncrypted,
          body: JSON.stringify({
            app_id: APP_NAME_ENCRYPTED,
            version: '1.0.0-encrypted-api-test',
            checksum: 'b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcde',
            external_url: 'https://example.com/bundle-encrypted.zip',
            session_key: 'encrypted-session-key-for-api-test',
          }),
        })

        expect(response.ok).toBe(true)
      })
    })

    it('should allow unencrypted bundle via API when enforcement is disabled', async () => {
      // Ensure enforcement is disabled
      await getSupabaseClient()
        .from('orgs')
        .update({ enforce_encrypted_bundles: false })
        .eq('id', ORG_ID_ENCRYPTED)

      const response = await fetch(getEndpointUrl('/bundle'), {
        method: 'POST',
        headers: headersEncrypted,
        body: JSON.stringify({
          app_id: APP_NAME_ENCRYPTED,
          version: '1.0.0-no-enforcement-api-test',
          checksum: 'c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcdef1',
          external_url: 'https://example.com/bundle-no-enforcement.zip',
        }),
      })

      // The API should accept this request
      expect(response.ok).toBe(true)
    })
  })

  describe('database Trigger Enforcement', () => {
    it('should reject direct insert of unencrypted bundle via trigger', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const { error } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: '1.0.0-direct-insert-rejected',
            checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2',
          })

        expect(error).not.toBeNull()
        expect(error?.message).toContain('encryption_required')
      })
    })

    it('should allow direct insert of encrypted bundle via trigger', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const { data, error } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: '1.0.0-direct-insert-allowed',
            checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2',
            session_key: 'encrypted-session-key-for-direct-insert',
          })
          .select()
          .single()

        expect(error).toBeNull()
        expect(data?.name).toBe('1.0.0-direct-insert-allowed')
        expect(data?.session_key).toBe('encrypted-session-key-for-direct-insert')
      })
    })

    it('should allow direct insert when enforcement is disabled', async () => {
      // Ensure enforcement is disabled
      await getSupabaseClient()
        .from('orgs')
        .update({ enforce_encrypted_bundles: false })
        .eq('id', ORG_ID_ENCRYPTED)

      // Try to insert directly via Supabase SDK without session_key
      const { data, error } = await getSupabaseClient()
        .from('app_versions')
        .insert({
          app_id: APP_NAME_ENCRYPTED,
          name: '1.0.0-direct-no-enforcement',
          checksum: 'a1b2c3d4e5f6789abcdef123456789abcdef123456789abcdef123456789abcd',
          owner_org: ORG_ID_ENCRYPTED,
          storage_provider: 'r2',
        })
        .select()
        .single()

      expect(error).toBeNull()
      expect(data?.name).toBe('1.0.0-direct-no-enforcement')
    })

    it('should reject direct update that changes session_key after the bundle is ready', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const bundleName = `1.0.0-direct-update-rejected-${Date.now()}`
        const { data: inserted, error: insertError } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: bundleName,
            checksum: 'd4e5f6789abcdef123456789abcdef123456789abcdef123456789abcdef12',
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2',
            session_key: 'encrypted-session-key-for-direct-update',
          })
          .select('id, session_key')
          .single()

        expect(insertError).toBeNull()
        expect(inserted?.session_key).toBe('encrypted-session-key-for-direct-update')

        const { error: updateError } = await getSupabaseClient()
          .from('app_versions')
          .update({
            session_key: '',
            key_id: null,
          })
          .eq('id', inserted!.id)

        expect(updateError).not.toBeNull()
        expect(updateError?.message).toContain('bundle_already_ready')

        const { data: afterUpdate, error: fetchError } = await getSupabaseClient()
          .from('app_versions')
          .select('session_key')
          .eq('id', inserted!.id)
          .single()

        expect(fetchError).toBeNull()
        expect(afterUpdate?.session_key).toBe('encrypted-session-key-for-direct-update')
      })
    })

    it('should allow CLI completion update that marks encrypted bundle ready', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const sessionKey = 'encrypted-session-key-for-cli-ready-update'
        const r2Path = `orgs/${ORG_ID_ENCRYPTED}/apps/${APP_NAME_ENCRYPTED}/cli-ready-update-${Date.now()}.zip`
        const bundleName = `1.0.0-cli-ready-update-${Date.now()}`
        const { data: inserted, error: insertError } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: bundleName,
            checksum: 'f6789abcdef123456789abcdef123456789abcdef123456789abcdef1234',
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2-direct',
            session_key: sessionKey,
          })
          .select('id, session_key, storage_provider')
          .single()

        expect(insertError).toBeNull()
        expect(inserted?.storage_provider).toBe('r2-direct')

        const { error: completionError } = await getSupabaseClient()
          .from('app_versions')
          .update({
            storage_provider: 'r2',
            session_key: sessionKey,
            r2_path: r2Path,
          })
          .eq('id', inserted!.id)

        expect(completionError).toBeNull()

        const { data: afterUpdate, error: fetchError } = await getSupabaseClient()
          .from('app_versions')
          .select('session_key, storage_provider, r2_path')
          .eq('id', inserted!.id)
          .single()

        expect(fetchError).toBeNull()
        expect(afterUpdate?.session_key).toBe(sessionKey)
        expect(afterUpdate?.storage_provider).toBe('r2')
        expect(afterUpdate?.r2_path).toBe(r2Path)
      })
    })

    it('should reject ready bundle content updates', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const originalChecksum = 'f789abcdef123456789abcdef123456789abcdef123456789abcdef12345'
        const originalNativePackages = [{ name: '@capacitor/core', version: '6.0.0' }]
        const bundleName = `1.0.0-ready-immutable-${Date.now()}`
        const originalR2Path = `orgs/${ORG_ID_ENCRYPTED}/apps/${APP_NAME_ENCRYPTED}/${bundleName}.zip`
        const { data: inserted, error: insertError } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: bundleName,
            checksum: originalChecksum,
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2',
            r2_path: originalR2Path,
            session_key: 'encrypted-session-key-for-ready-immutable',
            native_packages: originalNativePackages,
          })
          .select('id, checksum, storage_provider, r2_path, external_url, native_packages')
          .single()

        expect(insertError).toBeNull()
        expect(inserted?.storage_provider).toBe('r2')

        const { error: updateError } = await getSupabaseClient()
          .from('app_versions')
          .update({
            name: `${bundleName}-rewritten`,
            checksum: '089abcdef123456789abcdef123456789abcdef123456789abcdef123456',
            storage_provider: 'external',
            r2_path: `orgs/${ORG_ID_ENCRYPTED}/apps/${APP_NAME_ENCRYPTED}/rewritten.zip`,
            external_url: 'https://example.com/rewritten.zip',
            native_packages: [{ name: '@capacitor/core', version: '7.0.0' }],
          })
          .eq('id', inserted!.id)

        expect(updateError).not.toBeNull()
        expect(updateError?.message).toContain('bundle_already_ready')

        const { data: afterUpdate, error: fetchError } = await getSupabaseClient()
          .from('app_versions')
          .select('name, checksum, storage_provider, r2_path, external_url, native_packages')
          .eq('id', inserted!.id)
          .single()

        expect(fetchError).toBeNull()
        expect(afterUpdate?.name).toBe(bundleName)
        expect(afterUpdate?.checksum).toBe(originalChecksum)
        expect(afterUpdate?.storage_provider).toBe('r2')
        expect(afterUpdate?.r2_path).toBe(originalR2Path)
        expect(afterUpdate?.external_url).toBeNull()
        expect(afterUpdate?.native_packages).toEqual(originalNativePackages)
      })
    })

    it('should reject app-scoped API key direct update that invalidates session_key', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const bundleName = `1.0.0-app-scoped-update-rejected-${Date.now()}`
        const { data: inserted, error: insertError } = await getSupabaseClient()
          .from('app_versions')
          .insert({
            app_id: APP_NAME_ENCRYPTED,
            name: bundleName,
            checksum: 'e5f6789abcdef123456789abcdef123456789abcdef123456789abcdef123',
            owner_org: ORG_ID_ENCRYPTED,
            storage_provider: 'r2',
            session_key: 'encrypted-session-key-for-app-scoped-update',
          })
          .select('id, session_key')
          .single()

        expect(insertError).toBeNull()
        expect(inserted?.session_key).toBe('encrypted-session-key-for-app-scoped-update')

        const response = await fetch(`${SUPABASE_BASE_URL}/rest/v1/app_versions?id=eq.${inserted!.id}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'capgkey': apiKeyEncryptedScoped,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            session_key: '   ',
            key_id: null,
          }),
        })

        const responseData = await response.json() as { message?: string, error?: string }
        expect(response.ok).toBe(false)
        expect(responseData.message ?? responseData.error).toContain('bundle_already_ready')

        const { data: afterUpdate, error: fetchError } = await getSupabaseClient()
          .from('app_versions')
          .select('session_key')
          .eq('id', inserted!.id)
          .single()

        expect(fetchError).toBeNull()
        expect(afterUpdate?.session_key).toBe('encrypted-session-key-for-app-scoped-update')
      })
    })
  })

  describe('helper Functions', () => {
    it('is_bundle_encrypted should return false for null session_key', async () => {
      const { data, error } = await getSupabaseClient()
        .rpc('is_bundle_encrypted', { session_key: null as unknown as string })

      expect(error).toBeNull()
      expect(data).toBe(false)
    })

    it('is_bundle_encrypted should return false for empty session_key', async () => {
      const { data, error } = await getSupabaseClient()
        .rpc('is_bundle_encrypted', { session_key: '' })

      expect(error).toBeNull()
      expect(data).toBe(false)
    })

    it('is_bundle_encrypted should return true for non-empty session_key', async () => {
      const { data, error } = await getSupabaseClient()
        .rpc('is_bundle_encrypted', { session_key: 'some-encrypted-data' })

      expect(error).toBeNull()
      expect(data).toBe(true)
    })

    it('check_org_encrypted_bundle_enforcement should allow when enforcement is disabled', async () => {
      // Ensure enforcement is disabled
      await getSupabaseClient()
        .from('orgs')
        .update({ enforce_encrypted_bundles: false })
        .eq('id', ORG_ID_ENCRYPTED)

      const { data, error } = await getSupabaseClient()
        .rpc('check_org_encrypted_bundle_enforcement', {
          org_id: ORG_ID_ENCRYPTED,
          session_key: null as unknown as string,
        })

      expect(error).toBeNull()
      expect(data).toBe(true) // Should allow
    })

    it('check_org_encrypted_bundle_enforcement should reject unencrypted when enforcement is enabled', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const { data, error } = await getSupabaseClient()
          .rpc('check_org_encrypted_bundle_enforcement', {
            org_id: ORG_ID_ENCRYPTED,
            session_key: null as unknown as string,
          })

        expect(error).toBeNull()
        expect(data).toBe(false) // Should reject
      })
    })

    it('check_org_encrypted_bundle_enforcement should allow encrypted when enforcement is enabled', async () => {
      await withEncryptedBundleEnforcement(async () => {
        const { data, error } = await getSupabaseClient()
          .rpc('check_org_encrypted_bundle_enforcement', {
            org_id: ORG_ID_ENCRYPTED,
            session_key: 'some-encrypted-data',
          })

        expect(error).toBeNull()
        expect(data).toBe(true) // Should allow
      })
    })
  })

  describe('cleanup RPC authorization', () => {
    it('rejects stale org_users super_admin metadata when RBAC only grants org_member', async () => {
      const fixture = await createStaleLegacySuperAdminFixture()
      const supabase = getSupabaseClient()

      try {
        const countResponse = await callBundleCleanupRpc('count_non_compliant_bundles', fixture.orgId)
        const countData = await countResponse.json() as { message?: string, error?: string }
        expect(countResponse.status).not.toBe(200)
        expect(countData.message ?? countData.error).toContain('Unauthorized')

        const deleteResponse = await callBundleCleanupRpc('delete_non_compliant_bundles', fixture.orgId)
        const deleteData = await deleteResponse.json() as { message?: string, error?: string }
        expect(deleteResponse.status).not.toBe(200)
        expect(deleteData.message ?? deleteData.error).toContain('Unauthorized')

        const { data: version, error: versionError } = await supabase
          .from('app_versions')
          .select('deleted')
          .eq('id', fixture.versionId)
          .single()

        expect(versionError).toBeNull()
        expect(version?.deleted).toBe(false)
      }
      finally {
        await fixture.cleanup()
      }
    })
  })

  describe('get_orgs_v7 includes enforce_encrypted_bundles', () => {
    it('should include enforce_encrypted_bundles field in get_orgs_v7 response', async () => {
      // Use get_orgs_v7 with the encrypted user
      const { data, error } = await getSupabaseClient()
        .rpc('get_orgs_v7', { userid: USER_ID_ENCRYPTED })

      expect(error).toBeNull()
      expect(data).toBeDefined()
      expect(Array.isArray(data)).toBe(true)
      expect(data!.length).toBeGreaterThan(0)

      // Check that ALL orgs in the response have the enforce_encrypted_bundles field
      for (const org of data!) {
        expect(org.enforce_encrypted_bundles).toBeDefined()
        expect(typeof org.enforce_encrypted_bundles).toBe('boolean')
      }
    })
  })
})
