import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APIKEY_TEST_ALL, fetchTestRequest, getEndpointUrl, getSupabaseClient, ORG_ID, resetAndSeedAppData, resetAppData, USER_ID } from './test-utils.ts'

const APP_ID = `com.demo.request-manifest-upload.${randomUUID()}`

describe('[POST] /private/request_manifest_upload', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
  })

  it.concurrent('authorizes a complete manifest without persisting it', async () => {
    const { data: version, error } = await getSupabaseClient()
      .from('app_versions')
      .insert({
        app_id: APP_ID,
        name: `1.0.0-${randomUUID()}`,
        checksum: randomUUID().replaceAll('-', ''),
        owner_org: ORG_ID,
        user_id: USER_ID,
        storage_provider: 'r2-direct',
        deleted: false,
      })
      .select('id')
      .single()

    if (error || !version)
      throw new Error(`Failed to create upload version: ${error?.message}`)

    const response = await fetchTestRequest(getEndpointUrl('/private/request_manifest_upload'), {
      method: 'POST',
      retryUnsafe: true,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': APIKEY_TEST_ALL,
      },
      body: JSON.stringify({
        protocol_version: 1,
        version_id: version.id,
        delta_encryption: { enabled: false },
        manifest_upload_auto_enabled: false,
        file_hash_format: 'sha256_hex',
        entries: [{
          id: 9,
          file_name: 'assets/percent% café.js',
          compression: 'none',
          file_hash: 'a'.repeat(64),
          uploaded_bytes_sha256: 'b'.repeat(64),
          uploaded_bytes_size: 42,
        }],
      }),
    })

    expect(response.status).toBe(200)
    const body = await response.json() as any
    expect(body).toMatchObject({
      protocol_version: 1,
      version_id: version.id,
      default_action: 'upload_if_doesnt_exist',
      default_s3_path_prefix: `orgs/${ORG_ID}/apps/${APP_ID}/delta/`,
      default_upload_target: 'capgo_tus_v1',
      entries: [{
        id: 9,
        s3_path_suffix: expect.stringMatching(/^[0-9a-f]{64}_assets\/percent%25%20caf%C3%A9\.js$/),
        upload_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }],
    })
    expect(body.upload_targets[0]).toMatchObject({
      id: 'capgo_tus_v1',
      protocol: 'tus',
      upload_url: getEndpointUrl('/files/upload/attachments/'),
      existence_check_url_prefix: getEndpointUrl('/files/read/attachments/'),
      authorization: {
        type: 'header',
        header_name: 'X-Capgo-Upload-Token',
        token_prefix: expect.stringMatching(new RegExp(`^v1\\.[A-Za-z0-9_-]+\\.[0-9]+\\.${version.id}\\.0\\.$`)),
      },
    })

    const { count: manifestCount, error: manifestError } = await getSupabaseClient()
      .from('manifest')
      .select('id', { count: 'exact', head: true })
      .eq('app_version_id', version.id)
    expect(manifestError).toBeNull()
    expect(manifestCount).toBe(0)

    const { data: unchangedVersion, error: versionError } = await getSupabaseClient()
      .from('app_versions')
      .select('storage_provider')
      .eq('id', version.id)
      .single()
    expect(versionError).toBeNull()
    expect(unchangedVersion?.storage_provider).toBe('r2-direct')
  })
})
