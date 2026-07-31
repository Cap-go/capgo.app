import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APIKEY_TEST_ORG_SUPER_ADMIN, createIsolatedSeedAppOptions, getSupabaseClient, resetAndSeedAppData, resetAppData, resetAppDataStats, USER_ID } from './test-utils'

interface UploadResponse {
  url: string
}

describe('upload_link', async () => {
  const API_URL = process.env.API_URL ?? process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
  const id = randomUUID()
  const fileId = '1.0.42'
  const APPNAME = `com.cli_s3_${id}`
  const seedOptions = createIsolatedSeedAppOptions()
  beforeAll(async () => {
    await resetAndSeedAppData(APPNAME, seedOptions)
  })
  afterAll(async () => {
    await resetAppData(APPNAME)
    await resetAppDataStats(APPNAME)
  })

  it('should get upload url from supabase', async () => {
    const testParams = {
      bucket: 'capgo',
      key: `orgs/${seedOptions.orgId}/apps/${APPNAME}/${fileId}.zip`,
    }

    const supabase = getSupabaseClient()
    const { data, error: error2 } = await supabase.storage
      .from(testParams.bucket)
      .createSignedUploadUrl(testParams.key)

    if (error2)
      throw error2
    expect(data.signedUrl).toBeDefined()

    // Test the upload URL
    const testContent = 'Hello World'
    const uploadRes = await fetch(data.signedUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: testContent,
    })
    expect(uploadRes.status).toBe(200)
    const { error: error3 } = await supabase.storage
      .from('capgo')
      .remove([testParams.key])
    if (error3)
      throw error3
  })

  it('should return a valid upload url', async () => {
    const filePath = `orgs/${seedOptions.orgId}/apps/${APPNAME}/${fileId}.zip`
    //  be sure to remove the file from the bucket before running the test
    const supabase = getSupabaseClient()

    // Clean up any existing version with this name before inserting (handles test retries)
    await supabase.from('app_versions').delete().eq('app_id', APPNAME).eq('name', fileId)

    // create in supabase app_version with version 4
    const { data: data2, error } = await supabase.from('app_versions').insert({
      app_id: APPNAME,
      name: fileId,
      native_packages: [],
      user_id: USER_ID,
      storage_provider: 'r2-direct',
      owner_org: seedOptions.orgId,
    }).select('id').single()
    if (error)
      throw error
    const body = {
      app_id: APPNAME,
      name: fileId,
      version: data2?.id,
    }
    const res = await fetch(`${API_URL}/functions/v1/private/upload_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': APIKEY_TEST_ORG_SUPER_ADMIN,
      },
      body: JSON.stringify(body),
    })
    const data = await res.json() as UploadResponse
    expect(res.status).toBe(200)
    expect(data.url).toBeDefined()
    expect(data.url).toContain(filePath)

    // Test the upload URL
    const testContent = 'Hello World'
    const uploadRes = await fetch(data.url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain',
      },
      body: testContent,
    })
    expect(uploadRes.status).toBe(200)
  })

  it('should fail without auth', async () => {
    const fileId = `test/${randomUUID()}.txt`
    const res = await fetch(`${API_URL}/functions/v1/private/upload_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fileId }),
    })
    expect(res.status).toBe(401)
  })

  it('should fail with invalid fileId', async () => {
    const res = await fetch(`${API_URL}/functions/v1/private/upload_link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'capgkey': APIKEY_TEST_ORG_SUPER_ADMIN,
      },
      body: JSON.stringify({ fileId: '' }),
    })
    expect(res.status).toBe(400)
  })
})
