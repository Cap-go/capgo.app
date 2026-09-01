import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BASE_URL, createAppVersions, createDirectApiKeyWithBindings, executeSQL, fetchBundle, getPostgresClient, getSupabaseClient, headers, ORG_ID, resetAndSeedAppData, resetAppData, resetAppDataStats, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.app.b.${id}`
const RBAC_APPNAME = `com.app.b.rbac.${id}`
const RBAC_ORG_ID = randomUUID()

async function putBundleToChannel(body: { app_id: string, version_id: number, channel_id: number }): Promise<Response> {
  return fetch(`${BASE_URL}/bundle`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})
afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('[GET] /bundle operations', () => {
  it('valid app_id', async () => {
    const { response, data } = await fetchBundle(APPNAME)
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })

  it('invalid app_id', async () => {
    const { response } = await fetchBundle('invalid_app')
    expect(response.status).toBe(400)
  })
})

describe('[POST] /bundle/metadata operations', () => {
  let versionId: number

  beforeAll(async () => {
    // Create a test version to update
    const version = await createAppVersions('1.0.0-test-metadata', APPNAME)
    versionId = version.id
  })

  it('should update bundle metadata successfully', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: versionId,
        link: 'https://example.com/docs',
        comment: 'Test bundle comment',
      }),
    })

    const data = await response.json() as { status: string }
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')

    // Verify the data was updated in the database
    const supabase = getSupabaseClient()
    const { data: version, error } = await supabase
      .from('app_versions')
      .select('*')
      .eq('id', versionId)
      .eq('app_id', APPNAME)
      .single()

    expect(error).toBeNull()
    expect(version).toBeTruthy()
    // Type assertion to access the new fields
    expect((version as any).link).toBe('https://example.com/docs')
    expect((version as any).comment).toBe('Test bundle comment')
  })

  it('should handle missing required fields', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        // Missing app_id
        version_id: versionId,
        link: 'https://example.com',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_required_fields')
  })

  it('should handle invalid version_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: 999999, // Non-existent version ID
        link: 'https://example.com',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_version')
  })

  it('should handle invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle/metadata`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
        version_id: versionId,
        link: 'https://example.com',
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_app_id') // Changed: validation now catches invalid format first
  })
})

describe('[DELETE] /bundle operations', () => {
  it('invalid version', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: 'invalid_version',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it('invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it('delete specific bundle', async () => {
    const deleteBundle = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: '1.0.1',
      }),
    })
    const deleteBundleData = await deleteBundle.json() as { status: string }
    expect(deleteBundle.status).toBe(200)
    expect(deleteBundleData.status).toBe('ok')
  })

  it('does not delete a rollout target bundle linked to a channel', async () => {
    const supabase = getSupabaseClient()
    const stableVersion = await createAppVersions(`1.0.0-delete-rollout-stable-${id}`, APPNAME)
    const rolloutVersion = await createAppVersions(`1.0.0-delete-rollout-target-${id}`, APPNAME)
    const channelName = `delete-rollout-${id}`

    const { error: channelError } = await supabase
      .from('channels')
      .insert({
        app_id: APPNAME,
        name: channelName,
        version: stableVersion.id,
        rollout_version: rolloutVersion.id,
        rollout_enabled: true,
        rollout_percentage_bps: 1000,
        owner_org: ORG_ID,
        created_by: USER_ID,
      })

    expect(channelError).toBeNull()

    const deleteBundle = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version: rolloutVersion.name,
      }),
    })
    const deleteBundleData = await deleteBundle.json() as { error?: string }
    expect(deleteBundle.status).toBe(400)
    expect(deleteBundleData.error).toBe('cannot_delete_linked_version')

    const { data: versionAfterDelete, error: versionError } = await supabase
      .from('app_versions')
      .select('deleted')
      .eq('id', rolloutVersion.id)
      .single()

    expect(versionError).toBeNull()
    expect(versionAfterDelete?.deleted).toBe(false)
  })

  it('delete all bundles for an app', async () => {
    const deleteAllBundles = await fetch(`${BASE_URL}/bundle`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
      }),
    })

    const deleteAllBundlesData = await deleteAllBundles.json() as { status: string }
    expect(deleteAllBundles.status).toBe(200)
    expect(deleteAllBundlesData.status).toBe('ok')
  })
})

describe('[PUT] /bundle operations - Set bundle to channel', () => {
  let versionId: number
  let channelId: number
  let writeScopedKeyId: number | undefined
  let writeScopedHeaders: Record<string, string> | undefined

  beforeAll(async () => {
    // Create a test version
    const version = await createAppVersions('1.0.0-test-channel', APPNAME)
    versionId = version.id

    const supabase = getSupabaseClient()

    // Create a test channel using proper seeded values
    const { data: channel, error } = await supabase
      .from('channels')
      .insert({
        name: 'test-channel',
        app_id: APPNAME,
        version: null,
        created_by: '6aa76066-55ef-4238-ade6-0b32334a4097', // test@capgo.app user from seed
        owner_org: '046a36ac-e03c-4590-9257-bd6c9dba9ee8', // Demo org from seed
      })
      .select()
      .single()

    if (error) {
      throw new Error(`Failed to create test channel: ${error.message}`)
    }
    if (!channel) {
      throw new Error('Failed to create test channel: channel is null')
    }
    channelId = channel.id

    const createKeyData = await createDirectApiKeyWithBindings({
      key: randomUUID(),
      name: `bundle-write-key-${APPNAME}`,
      orgId: ORG_ID,
      roleName: 'org_member',
      appId: APPNAME,
      appRoleName: 'app_developer',
    })
    if (!createKeyData.key)
      throw new Error('Failed to create write-scoped bundle key')

    writeScopedKeyId = createKeyData.id
    writeScopedHeaders = {
      'Content-Type': 'application/json',
      'capgkey': createKeyData.key,
    }
  })

  afterAll(async () => {
    if (writeScopedKeyId != null) {
      await getSupabaseClient().from('apikeys').delete().eq('id', writeScopedKeyId)
    }
  })

  it('should set bundle to channel successfully', async () => {
    const response = await putBundleToChannel({
      app_id: APPNAME,
      version_id: versionId,
      channel_id: channelId,
    })

    const data = await response.json() as { status: string, message: string }
    expect(response.status).toBe(200)
    expect(data.status).toBe('success')
    expect(data.message).toContain('Bundle')
    expect(data.message).toContain('set to channel')

    // Verify the channel was updated in the database
    const supabase = getSupabaseClient()
    const { data: channel, error } = await supabase
      .from('channels')
      .select('*')
      .eq('id', channelId)
      .eq('app_id', APPNAME)
      .single()

    expect(error).toBeNull()
    expect(channel).toBeTruthy()
    if (channel) {
      expect(channel.version).toBe(versionId)
    }
  })

  it('should reset leftover rollout when a new stable bundle is set', async () => {
    const supabase = getSupabaseClient()
    const nextVersion = await createAppVersions('1.0.1-test-channel-rollout-reset', APPNAME)
    const rolloutVersion = await createAppVersions('1.0.0-test-channel-rollout-target', APPNAME)

    const { error: leftoverError } = await supabase
      .from('channels')
      .update({
        version: versionId,
        rollout_version: rolloutVersion.id,
        rollout_enabled: true,
        rollout_percentage_bps: 10000,
      })
      .eq('id', channelId)
      .eq('app_id', APPNAME)
    expect(leftoverError).toBeNull()

    const { data: before, error: beforeError } = await supabase
      .from('channels')
      .select('version, rollout_version, rollout_enabled, rollout_id')
      .eq('id', channelId)
      .single()
    expect(beforeError).toBeNull()
    expect(before?.version).toBe(versionId)
    expect(before?.rollout_version).toBe(rolloutVersion.id)
    expect(before?.rollout_enabled).toBe(true)

    const response = await putBundleToChannel({
      app_id: APPNAME,
      version_id: nextVersion.id,
      channel_id: channelId,
    })
    expect(response.status).toBe(200)

    const { data: after, error: afterError } = await supabase
      .from('channels')
      .select('version, rollout_version, rollout_enabled, rollout_percentage_bps, rollout_id')
      .eq('id', channelId)
      .single()
    expect(afterError).toBeNull()
    expect(after?.version).toBe(nextVersion.id)
    expect(after?.rollout_version).toBeNull()
    expect(after?.rollout_enabled).toBe(false)
    expect(after?.rollout_percentage_bps).toBe(0)
    expect(after?.rollout_id).not.toBe(before?.rollout_id)
  })

  it('should keep the supported write-scoped API key bundle promotion flow working', async () => {
    if (!writeScopedHeaders) {
      throw new Error('Write-scoped bundle test key was not created')
    }

    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers: writeScopedHeaders,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: versionId,
        channel_id: channelId,
      }),
    })

    const data = await response.json() as { status: string, message: string }
    expect(response.status).toBe(200)
    expect(data.status).toBe('success')
    expect(data.message).toContain('set to channel')

    const supabase = getSupabaseClient()
    const { data: channel, error } = await supabase
      .from('channels')
      .select('version')
      .eq('id', channelId)
      .eq('app_id', APPNAME)
      .single()

    expect(error).toBeNull()
    expect(channel?.version).toBe(versionId)
  })

  it('should handle missing required fields', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        // Missing channel_id
        app_id: APPNAME,
        version_id: versionId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('missing_required_fields')
  })

  it('should handle invalid version_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: 999999, // Non-existent version ID
        channel_id: channelId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_version')
  })

  it('should handle invalid channel_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: versionId,
        channel_id: 999999, // Non-existent channel ID
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('cannot_find_channel')
  })

  it('should handle invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
        version_id: versionId,
        channel_id: channelId,
      }),
    })

    expect(response.status).toBe(400)
    const data = await response.json() as { error: string }
    expect(data.error).toBe('invalid_app_id') // Changed: validation now catches invalid format first
  })
})

describe('[PUT] /bundle RBAC channel overrides', () => {
  let versionId: number
  let originalVersionId: number
  let channelId: number | undefined
  let rbacApiKeyId: number | undefined
  let rbacHeaders: Record<string, string> | undefined

  beforeAll(async () => {
    const supabase = getSupabaseClient()

    const { error: orgError } = await supabase.from('orgs').insert({
      id: RBAC_ORG_ID,
      name: `Bundle RBAC Org ${id}`,
      management_email: `bundle-rbac-${id}@capgo.app`,
      created_by: USER_ID,
    })
    if (orgError)
      throw orgError

    const { data: app, error: appError } = await supabase
      .from('apps')
      .insert({
        app_id: RBAC_APPNAME,
        name: `Bundle RBAC App ${id}`,
        icon_url: 'bundle-rbac-test-icon',
        owner_org: RBAC_ORG_ID,
      })
      .select('id')
      .single()
    if (appError || !app)
      throw appError ?? new Error('Failed to create RBAC bundle app')
    const appId = app.id
    if (!appId)
      throw new Error('Created RBAC bundle app is missing id')

    const { error: memberError } = await supabase.from('org_users').insert({
      org_id: RBAC_ORG_ID,
      user_id: USER_ID,
      rbac_role_name: 'org_member',
    })
    if (memberError)
      throw memberError

    await supabase
      .from('role_bindings')
      .delete()
      .eq('principal_type', 'user')
      .eq('principal_id', USER_ID)
      .eq('scope_type', 'app')
      .eq('app_id', appId)

    const { data: role, error: roleError } = await supabase
      .from('roles')
      .select('id')
      .eq('name', 'app_developer')
      .single()
    if (roleError || !role)
      throw roleError ?? new Error('Failed to find app_developer role')

    const { error: bindingError } = await supabase.from('role_bindings').insert({
      principal_type: 'user',
      principal_id: USER_ID,
      role_id: role.id,
      scope_type: 'app',
      org_id: RBAC_ORG_ID,
      app_id: appId,
      granted_by: USER_ID,
      is_direct: true,
    })
    if (bindingError)
      throw bindingError

    originalVersionId = (await createAppVersions(`1.0.0-rbac-original-${id}`, RBAC_APPNAME, {
      owner_org: RBAC_ORG_ID,
      user_id: USER_ID,
    })).id
    versionId = (await createAppVersions(`1.0.0-rbac-target-${id}`, RBAC_APPNAME, {
      owner_org: RBAC_ORG_ID,
      user_id: USER_ID,
    })).id

    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .insert({
        name: `rbac-denied-channel-${id}`,
        app_id: RBAC_APPNAME,
        version: originalVersionId,
        created_by: USER_ID,
        owner_org: RBAC_ORG_ID,
      })
      .select('id')
      .single()
    if (channelError || !channel)
      throw channelError ?? new Error('Failed to create RBAC denied channel')
    channelId = channel.id

    const apiKey = await createDirectApiKeyWithBindings({
      userId: USER_ID,
      key: randomUUID(),
      name: `bundle-rbac-denied-${id}`,
      orgId: RBAC_ORG_ID,
      roleName: 'org_member',
      appId: RBAC_APPNAME,
      appRoleName: 'app_developer',
    })
    if (!apiKey.key)
      throw new Error('Failed to create RBAC API key')

    const { error: overrideError } = await supabase.from('channel_permission_overrides').insert({
      principal_type: 'apikey',
      principal_id: apiKey.rbac_id,
      channel_id: channelId,
      permission_key: 'channel.promote_bundle',
      is_allowed: false,
    })
    if (overrideError)
      throw overrideError

    rbacApiKeyId = apiKey.id
    rbacHeaders = {
      'Content-Type': 'application/json',
      'capgkey': apiKey.key,
    }
  })

  afterAll(async () => {
    const supabase = getSupabaseClient()
    if (rbacApiKeyId != null)
      await supabase.from('apikeys').delete().eq('id', rbacApiKeyId)
    if (channelId != null)
      await supabase.from('channel_permission_overrides').delete().eq('channel_id', channelId)
    await supabase.from('channels').delete().eq('app_id', RBAC_APPNAME)
    await supabase.from('app_versions').delete().eq('app_id', RBAC_APPNAME)
    await supabase.from('role_bindings').delete().eq('org_id', RBAC_ORG_ID)
    await supabase.from('org_users').delete().eq('org_id', RBAC_ORG_ID)
    await supabase.from('apps').delete().eq('app_id', RBAC_APPNAME)
    await supabase.from('orgs').delete().eq('id', RBAC_ORG_ID)
  })

  it('rejects API-key bundle promotion when the user has a target-channel deny override', async () => {
    if (channelId == null)
      throw new Error('RBAC denied channel was not created')
    if (!rbacHeaders)
      throw new Error('RBAC API key was not created')

    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers: rbacHeaders,
      body: JSON.stringify({
        app_id: RBAC_APPNAME,
        version_id: versionId,
        channel_id: channelId,
      }),
    })

    const data = await response.json() as { error: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('cannot_access_app')

    const { data: channel, error } = await getSupabaseClient()
      .from('channels')
      .select('version')
      .eq('id', channelId)
      .single()

    expect(error).toBeNull()
    expect(channel?.version).toBe(originalVersionId)
  })
})

describe('[POST] /bundle/prepare and [GET] /bundle/lookup operations', () => {
  const prepareVersion = `9.9.9-prepare-${id.slice(0, 8)}`

  it('creates an uploadable version row and latest lookup returns it', async () => {
    const response = await fetch(`${BASE_URL}/bundle/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: prepareVersion,
        storage_provider: 'r2-direct',
        cli_version: '99.0.0-test',
      }),
    })

    const data = await response.json() as { status?: string, version?: { id?: number, name?: string } }
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
    expect(data.version?.name).toBe(prepareVersion)

    const lookup = await fetch(`${BASE_URL}/bundle/lookup?app_id=${encodeURIComponent(APPNAME)}&name=${encodeURIComponent(prepareVersion)}`, {
      method: 'GET',
      headers,
    })
    const lookupData = await lookup.json() as { exists?: boolean, id?: number }
    expect(lookup.status).toBe(200)
    expect(lookupData.exists).toBe(true)
    expect(lookupData.id).toBe(data.version?.id)

    const latest = await fetch(`${BASE_URL}/bundle/lookup?app_id=${encodeURIComponent(APPNAME)}&latest=true`, {
      method: 'GET',
      headers,
    })
    const latestData = await latest.json() as { name?: string | null }
    expect(latest.status).toBe(200)
    expect(latestData.name).toBe(prepareVersion)
  })

  it('rejects invalid storage_provider on create', async () => {
    const response = await fetch(`${BASE_URL}/bundle/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: `9.9.8-bad-storage-${id.slice(0, 8)}`,
        storage_provider: 'r2',
      }),
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_storage_provider')
  })

  it('rejects non-HTTPS external_url on prepare', async () => {
    const response = await fetch(`${BASE_URL}/bundle/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: `9.9.8-bad-url-${id.slice(0, 8)}`,
        storage_provider: 'external',
        external_url: 'http://example.com/bundle.zip',
      }),
    })

    const data = await response.json() as { error?: string }
    expect(response.status).toBe(400)
    expect(data.error).toBe('invalid_protocol')
  })

  it('resets completed r2 versions back to r2-direct for re-upload', async () => {
    const versionName = `9.9.7-reprepare-${id.slice(0, 8)}`
    const supabase = getSupabaseClient()

    const prepareResponse = await fetch(`${BASE_URL}/bundle/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: versionName,
        storage_provider: 'r2-direct',
      }),
    })
    expect(prepareResponse.status).toBe(200)

    const { error: markCompleteError } = await supabase
      .from('app_versions')
      .update({ storage_provider: 'r2', r2_path: `orgs/${ORG_ID}/apps/${APPNAME}/${versionName}.zip` })
      .eq('app_id', APPNAME)
      .eq('name', versionName)
    expect(markCompleteError).toBeNull()

    const rePrepareResponse = await fetch(`${BASE_URL}/bundle/prepare`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        name: versionName,
        storage_provider: 'r2-direct',
      }),
    })
    const rePrepareData = await rePrepareResponse.json() as { status?: string, version?: { storage_provider?: string } }
    expect(rePrepareResponse.status).toBe(200)
    expect(rePrepareData.status).toBe('ok')
    expect(rePrepareData.version?.storage_provider).toBe('r2-direct')

    const { data: version, error } = await supabase
      .from('app_versions')
      .select('storage_provider, r2_path')
      .eq('app_id', APPNAME)
      .eq('name', versionName)
      .single()
    expect(error).toBeNull()
    expect(version?.storage_provider).toBe('r2-direct')
    expect(version?.r2_path).toBeNull()
  })

  it('ignores prepare_reupload_reset GUC for authenticated sessions', async () => {
    const versionName = `9.9.6-guc-auth-${id.slice(0, 8)}`
    const [inserted] = await executeSQL<{ id: number }>(
      `INSERT INTO public.app_versions (app_id, name, owner_org, user_id, storage_provider, r2_path, deleted)
       VALUES ($1, $2, $3::uuid, $4::uuid, 'r2', $5, false)
       RETURNING id`,
      [APPNAME, versionName, ORG_ID, USER_ID, `orgs/${ORG_ID}/apps/${APPNAME}/${versionName}.zip`],
    )
    expect(inserted?.id).toBeTruthy()

    const pool = await getPostgresClient()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT set_config($1, $2, true)', ['request.jwt.claim.role', 'authenticated'])
      await client.query('SELECT set_config($1, $2, true)', [
        'request.jwt.claims',
        JSON.stringify({ role: 'authenticated', sub: USER_ID }),
      ])
      await client.query('SELECT set_config($1, $2, true)', ['capgo.prepare_reupload_reset', 'on'])
      await expect(client.query(
        `UPDATE public.app_versions
         SET storage_provider = 'r2-direct', r2_path = NULL
         WHERE id = $1`,
        [inserted.id],
      )).rejects.toThrow(/bundle_already_ready/)
    }
    finally {
      try {
        await client.query('ROLLBACK')
      }
      catch {
        // Ignore rollback failures after the expected trigger exception.
      }
      client.release()
    }
  })
})
