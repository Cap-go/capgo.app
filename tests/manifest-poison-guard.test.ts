import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  APIKEY_TEST_UPLOAD,
  fetchTestRequest,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  USER_ID,
} from './test-utils.ts'

const APP_ID = 'com.demo.app'

const R2_DIRECT_MANIFEST_ERR = 'r2_direct_manifest_jsonb'
const SET_MANIFEST_PATH = '/private/set_manifest'

function poisonManifestEntries(ownerOrg: string, versionName: string) {
  const prefix = `orgs/${ownerOrg}/apps/${APP_ID}/delta`
  return [
    {
      file_name: 'poison.html',
      s3_path: `${prefix}/${versionName}_poisonhash_poison.html`,
      file_hash: 'poisonhash',
    },
  ]
}

async function patchVersionManifestAsApiKey(
  apikey: string,
  versionId: number,
  manifest: Database['public']['CompositeTypes']['manifest_entry'][],
) {
  const supabaseUrl = process.env.SUPABASE_URL as string
  const anonKey = process.env.SUPABASE_ANON_KEY as string

  return fetch(`${supabaseUrl}/rest/v1/app_versions?id=eq.${versionId}`, {
    method: 'PATCH',
    headers: {
      'apikey': anonKey,
      'Authorization': `Bearer ${anonKey}`,
      'capgkey': apikey,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ manifest }),
  })
}

describe('manifest poison guard', () => {
  it.concurrent.each([
    ['upload', APIKEY_TEST_UPLOAD],
    ['write', APIKEY_TEST_ALL],
  ])('blocks %s API key from poisoning manifest via app_versions.manifest on r2-direct', async (_label, apikey) => {
    const adminClient = getSupabaseClient()
    const versionName = `1.0.0-poison-${randomUUID().slice(0, 8)}`

    const { data: version, error: insertError } = await adminClient
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: versionName,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2-direct',
        deleted: false,
      })
      .select('id, owner_org')
      .single()

    expect(insertError).toBeNull()
    expect(version).not.toBeNull()
    if (!version)
      return

    try {
      const response = await patchVersionManifestAsApiKey(
        apikey,
        version.id,
        poisonManifestEntries(version.owner_org, versionName),
      )

      expect(response.status).toBeGreaterThanOrEqual(400)
      const body = await response.text()
      expect(body).toContain(R2_DIRECT_MANIFEST_ERR)
      expect(body).toContain(SET_MANIFEST_PATH)

      const { data: versionRow, error: versionError } = await adminClient
        .from('app_versions')
        .select('manifest')
        .eq('id', version.id)
        .single()

      expect(versionError).toBeNull()
      expect(versionRow?.manifest).toBeNull()

      const { data: manifestRows, error: manifestError } = await adminClient
        .from('manifest')
        .select('id')
        .eq('app_version_id', version.id)

      expect(manifestError).toBeNull()
      expect(manifestRows).toHaveLength(0)
    }
    finally {
      await adminClient.from('app_versions').delete().eq('id', version.id)
    }
  })

  it.concurrent('still allows legitimate manifest upload via set_manifest on r2-direct', async () => {
    const adminClient = getSupabaseClient()
    const versionName = `1.0.0-poison-legit-${randomUUID().slice(0, 8)}`

    const { data: version, error: insertError } = await adminClient
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: versionName,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2-direct',
        deleted: false,
      })
      .select('id, owner_org')
      .single()

    expect(insertError).toBeNull()
    expect(version).not.toBeNull()
    if (!version)
      return

    const prefix = `orgs/${version.owner_org}/apps/${APP_ID}/delta`
    const body = {
      app_id: APP_ID,
      name: versionName,
      manifest: [
        {
          file_name: 'index.html',
          s3_path: `${prefix}/hash1_index.html`,
          file_hash: 'hash1',
        },
      ],
    }

    try {
      const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
        method: 'POST',
        retryUnsafe: true,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': APIKEY_TEST_UPLOAD,
        },
        body: JSON.stringify(body),
      })

      expect(response.status).toBe(200)
      const json = await response.json() as { status: string, inserted: number }
      expect(json.status).toBe('ok')
      expect(json.inserted).toBe(1)

      const { data: rows, error: manifestError } = await adminClient
        .from('manifest')
        .select('file_name, file_hash, s3_path')
        .eq('app_version_id', version.id)

      expect(manifestError).toBeNull()
      expect(rows).toHaveLength(1)
      expect(rows?.[0]?.file_name).toBe('index.html')
    }
    finally {
      if (version) {
        await adminClient.from('manifest').delete().eq('app_version_id', version.id)
        await adminClient.from('app_versions').delete().eq('id', version.id)
      }
    }
  })
})
