import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  executeSQL,
  fetchTestRequest,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  resetAndSeedAppData,
  resetAppData,
  USER_ID,
} from './test-utils.ts'

const id = randomUUID()
const APP_ID = `com.demo.set-manifest.${id}`
const BUNDLE_NAME = `1.0.0-set-manifest-${id.slice(0, 8)}`

async function createUploadVersion(storageProvider: 'r2-direct' | 'r2' = 'r2-direct') {
  const { data, error } = await getSupabaseClient()
    .from('app_versions')
    .insert({
      app_id: APP_ID,
      name: BUNDLE_NAME,
      checksum: randomUUID().replaceAll('-', ''),
      owner_org: ORG_ID,
      user_id: USER_ID,
      storage_provider: storageProvider,
      deleted: false,
    })
    .select('id, owner_org')
    .single()

  if (error || !data)
    throw new Error(`Failed to create version: ${error?.message}`)

  return data
}

function manifestEntries(ownerOrg: string) {
  const prefix = `orgs/${ownerOrg}/apps/${APP_ID}/delta`
  return [
    {
      file_name: 'index.html',
      s3_path: `${prefix}/hash1_index.html`,
      file_hash: 'hash1',
      file_size: 999999, // must be ignored by backend
    },
    {
      file_name: 'main.js',
      s3_path: `${prefix}/hash2_main.js`,
      file_hash: 'hash2',
    },
  ]
}

describe('[POST] /private/set_manifest', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
  })

  it('writes manifest rows with file_size 0 and keeps legacy jsonb path unused', async () => {
    const version = await createUploadVersion('r2-direct')
    const body = {
      app_id: APP_ID,
      name: BUNDLE_NAME,
      manifest: manifestEntries(version.owner_org),
    }

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify(body),
    })

    expect(response.status).toBe(200)
    const json = await response.json() as { status: string, inserted: number, alreadyPresent: boolean }
    expect(json.status).toBe('ok')
    expect(json.inserted).toBe(2)
    expect(json.alreadyPresent).toBe(false)

    const { data: rows, error } = await getSupabaseClient()
      .from('manifest')
      .select('file_name, file_hash, s3_path, file_size')
      .eq('app_version_id', version.id)
      .order('file_name')

    expect(error).toBeNull()
    expect(rows).toHaveLength(2)
    expect(rows?.every(row => row.file_size === 0)).toBe(true)
    expect(rows?.map(row => row.file_name)).toEqual(['index.html', 'main.js'])

    const { data: appVersion } = await getSupabaseClient()
      .from('app_versions')
      .select('manifest, manifest_count')
      .eq('id', version.id)
      .single()

    expect(appVersion?.manifest).toBeNull()
    expect(appVersion?.manifest_count).toBe(2)

    // Idempotent retry
    const retry = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify(body),
    })
    expect(retry.status).toBe(200)
    const retryJson = await retry.json() as { inserted: number, alreadyPresent: boolean }
    expect(retryJson.alreadyPresent).toBe(true)
    expect(retryJson.inserted).toBe(0)
  })

  it('rejects paths outside the app prefix and blocks r2-direct manifest jsonb writes', async () => {
    const otherBundle = `${BUNDLE_NAME}-legacy`
    const { data: version, error } = await getSupabaseClient()
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: otherBundle,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2-direct',
        deleted: false,
      })
      .select('id, owner_org')
      .single()
    expect(error).toBeNull()

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: otherBundle,
        manifest: [{
          file_name: 'evil.js',
          s3_path: 'orgs/other-org/apps/com.evil/delta/x_evil.js',
          file_hash: 'evil',
        }],
      }),
    })
    expect(response.status).toBe(400)

    await expect(executeSQL(
      `UPDATE public.app_versions
       SET storage_provider = 'r2',
           manifest = ARRAY[
             ROW('legacy.html', $2, 'legacyhash')::public.manifest_entry
           ],
           updated_at = now()
       WHERE id = $1`,
      [version!.id, `orgs/${version!.owner_org}/apps/${APP_ID}/delta/legacy_legacy.html`],
    )).rejects.toThrow(/bundle_already_ready/)

    const legit = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: otherBundle,
        manifest: [{
          file_name: 'legacy.html',
          s3_path: `orgs/${version!.owner_org}/apps/${APP_ID}/delta/legacy_legacy.html`,
          file_hash: 'legacyhash',
        }],
      }),
    })
    expect(legit.status).toBe(200)
  })

  it('rejects finalized versions that have no manifest rows yet', async () => {
    const finalizedName = `${BUNDLE_NAME}-final`
    const { data: finalized } = await getSupabaseClient()
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: finalizedName,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2',
        deleted: false,
      })
      .select('owner_org')
      .single()

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: finalizedName,
        manifest: manifestEntries(finalized!.owner_org),
      }),
    })

    expect(response.status).toBe(400)
    const json = await response.json() as { error: string }
    expect(json.error).toBe('error_version_already_finalized')
  })

  it('rejects manifests larger than 10,000 entries', async () => {
    const oversizedName = `${BUNDLE_NAME}-too-large`
    const { data: version, error } = await getSupabaseClient()
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: oversizedName,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2-direct',
        deleted: false,
      })
      .select('owner_org')
      .single()
    expect(error).toBeNull()

    const prefix = `orgs/${version!.owner_org}/apps/${APP_ID}/delta`
    const oversized = Array.from({ length: 10_001 }, (_, i) => ({
      file_name: `f${i}.js`,
      s3_path: `${prefix}/h${i}_f${i}.js`,
      file_hash: `h${i}`,
    }))

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: oversizedName,
        manifest: oversized,
      }),
    })

    expect(response.status).toBe(400)
    const json = await response.json() as { error: string, max?: number, count?: number }
    expect(json.error).toBe('error_manifest_too_large')
  })

  it('rejects missing versions and non-uploadable storage providers', async () => {
    const missing = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: `${BUNDLE_NAME}-does-not-exist`,
        manifest: manifestEntries(ORG_ID),
      }),
    })
    expect(missing.status).toBe(404)
    const missingJson = await missing.json() as { error: string }
    expect(missingJson.error).toBe('error_version_not_found')

    const externalName = `${BUNDLE_NAME}-external`
    const { data: external } = await getSupabaseClient()
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: externalName,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'external',
        external_url: 'https://example.com/bundle.zip',
        deleted: false,
      })
      .select('owner_org')
      .single()

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        app_id: APP_ID,
        name: externalName,
        manifest: manifestEntries(external!.owner_org),
      }),
    })
    expect(response.status).toBe(400)
    const json = await response.json() as { error: string }
    expect(json.error).toBe('error_version_not_uploadable')
  })
})
