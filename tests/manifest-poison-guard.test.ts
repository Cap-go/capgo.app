import type { Database } from '../src/types/supabase.types'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  APIKEY_TEST_UPLOAD,
  fetchTestRequest,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  resetAndSeedAppData,
  resetAppData,
  USER_ID,
} from './test-utils.ts'

const id = randomUUID()
const APP_ID = `com.demo.manifest-poison.${id}`
const BUNDLE_NAME = `1.0.0-poison-${id.slice(0, 8)}`

function createApiKeyClient(apikey: string) {
  const supabaseUrl = process.env.SUPABASE_URL as string
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY as string

  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        capgkey: apikey,
      },
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

function poisonManifestEntries(ownerOrg: string) {
  const prefix = `orgs/${ownerOrg}/apps/${APP_ID}/delta`
  return [
    {
      file_name: 'poison.html',
      s3_path: `${prefix}/poisonhash_poison.html`,
      file_hash: 'poisonhash',
    },
  ]
}

describe('manifest poison guard', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
  })

  it.concurrent('blocks upload API key from poisoning manifest via app_versions.manifest on r2-direct', async () => {
    const adminClient = getSupabaseClient()
    const uploaderClient = createApiKeyClient(APIKEY_TEST_UPLOAD)
    const versionName = `${BUNDLE_NAME}-upload`

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

    try {
      const { error: poisonError } = await uploaderClient
        .from('app_versions')
        .update({
          manifest: poisonManifestEntries(version!.owner_org),
        })
        .eq('id', version!.id)

      expect(poisonError).not.toBeNull()
      expect(poisonError?.message).toContain('bundle_already_ready')

      const { data: manifestRows, error: manifestError } = await adminClient
        .from('manifest')
        .select('id')
        .eq('app_version_id', version!.id)

      expect(manifestError).toBeNull()
      expect(manifestRows).toHaveLength(0)
    }
    finally {
      await adminClient.from('app_versions').delete().eq('id', version!.id)
    }
  })

  it.concurrent('blocks write API key from poisoning manifest via app_versions.manifest on r2-direct', async () => {
    const adminClient = getSupabaseClient()
    const writeClient = createApiKeyClient(APIKEY_TEST_ALL)
    const versionName = `${BUNDLE_NAME}-write`

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

    try {
      const { error: poisonError } = await writeClient
        .from('app_versions')
        .update({
          manifest: poisonManifestEntries(version!.owner_org),
        })
        .eq('id', version!.id)

      expect(poisonError).not.toBeNull()
      expect(poisonError?.message).toContain('bundle_already_ready')

      const { data: manifestRows, error: manifestError } = await adminClient
        .from('manifest')
        .select('id')
        .eq('app_version_id', version!.id)

      expect(manifestError).toBeNull()
      expect(manifestRows).toHaveLength(0)
    }
    finally {
      await adminClient.from('app_versions').delete().eq('id', version!.id)
    }
  })

  it('still allows legitimate manifest upload via set_manifest on r2-direct', async () => {
    const adminClient = getSupabaseClient()
    const versionName = `${BUNDLE_NAME}-legit`

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

    const prefix = `orgs/${version!.owner_org}/apps/${APP_ID}/delta`
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

    const response = await fetchTestRequest(getEndpointUrl('/private/set_manifest'), {
      method: 'POST',
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
      .eq('app_version_id', version!.id)

    expect(manifestError).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.file_name).toBe('index.html')

    await adminClient.from('manifest').delete().eq('app_version_id', version!.id)
    await adminClient.from('app_versions').delete().eq('id', version!.id)
  })
})
