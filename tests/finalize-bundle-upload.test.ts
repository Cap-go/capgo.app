import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APIKEY_TEST_ALL,
  createDirectApiKeyWithBindings,
  fetchTestRequest,
  getEndpointUrl,
  getSupabaseClient,
  ORG_ID,
  ORG_ID_2,
  resetAndSeedAppData,
  resetAppData,
  USER_ID,
  USER_ID_2,
} from './test-utils.ts'

const fixtureId = randomUUID()
const APP_ID = `com.test.finalize-bundle-upload.${fixtureId}`
const ENDPOINT = '/private/finalize_bundle_upload'
let deniedApiKeyId: number | null = null
let deniedApiKey = ''
let crossOrgApiKeyId: number | null = null
let crossOrgApiKey = ''
let versionSequence = 0

async function createVersion(options: {
  storageProvider?: string
  deleted?: boolean
  deletedAt?: string | null
} = {}) {
  const name = `1.0.${versionSequence++}-${fixtureId.slice(0, 8)}`
  const storageProvider = options.storageProvider ?? 'r2-direct'
  const { data, error } = await getSupabaseClient()
    .from('app_versions')
    .insert({
      app_id: APP_ID,
      name,
      checksum: `checksum-${name}`,
      comment: `comment-${name}`,
      owner_org: ORG_ID,
      user_id: USER_ID,
      storage_provider: storageProvider,
      r2_path: `orgs/${ORG_ID}/apps/${APP_ID}/${name}.zip`,
      external_url: storageProvider === 'external' ? 'https://example.com/bundle.zip' : null,
      deleted: options.deleted ?? false,
      deleted_at: options.deletedAt ?? null,
    })
    .select('id')
    .single()

  if (error || !data)
    throw new Error(`Failed to create version: ${error?.message}`)
  return data.id
}

async function finalize(versionId: unknown, apiKey = APIKEY_TEST_ALL) {
  return await fetchTestRequest(getEndpointUrl(ENDPOINT), {
    method: 'POST',
    retryUnsafe: true,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
    },
    body: JSON.stringify({ version_id: versionId }),
  })
}

async function readVersion(versionId: number) {
  const { data, error } = await getSupabaseClient()
    .from('app_versions')
    .select('storage_provider, checksum, comment, r2_path, manifest_count, updated_at')
    .eq('id', versionId)
    .single()
  if (error)
    throw error
  return data
}

describe('[POST] /private/finalize_bundle_upload', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
    const denied = await createDirectApiKeyWithBindings({
      key: randomUUID(),
      name: `finalize-denied-${fixtureId}`,
      orgId: ORG_ID,
      roleName: 'org_member',
    })
    deniedApiKeyId = denied.id
    deniedApiKey = denied.key ?? ''
    const crossOrg = await createDirectApiKeyWithBindings({
      userId: USER_ID_2,
      key: randomUUID(),
      name: `finalize-cross-org-${fixtureId}`,
      orgId: ORG_ID_2,
      roleName: 'org_admin',
    })
    crossOrgApiKeyId = crossOrg.id
    crossOrgApiKey = crossOrg.key ?? ''
  })

  afterAll(async () => {
    if (deniedApiKeyId !== null)
      await getSupabaseClient().from('apikeys').delete().eq('id', deniedApiKeyId)
    if (crossOrgApiKeyId !== null)
      await getSupabaseClient().from('apikeys').delete().eq('id', crossOrgApiKeyId)
    await resetAppData(APP_ID)
  })

  it.concurrent('transitions r2-direct to r2 without changing unrelated fields', async () => {
    const versionId = await createVersion()
    const before = await readVersion(versionId)

    const response = await finalize(versionId)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ok' })
    const after = await readVersion(versionId)
    expect(after.storage_provider).toBe('r2')
    expect(after).toMatchObject({
      checksum: before.checksum,
      comment: before.comment,
      r2_path: before.r2_path,
      manifest_count: before.manifest_count,
    })
  })

  it.concurrent('accepts an already finalized version idempotently', async () => {
    const versionId = await createVersion({ storageProvider: 'r2' })
    const before = await readVersion(versionId)
    expect((await finalize(versionId)).status).toBe(200)
    expect(await readVersion(versionId)).toEqual(before)
  })

  it.concurrent('rejects a missing version_id', async () => {
    const response = await fetchTestRequest(getEndpointUrl(ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': APIKEY_TEST_ALL },
      body: '{}',
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('error_version_id_invalid')
  })

  it.concurrent('rejects a null request body', async () => {
    const response = await fetchTestRequest(getEndpointUrl(ENDPOINT), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': APIKEY_TEST_ALL },
      body: 'null',
    })
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('error_version_id_invalid')
  })

  it.concurrent.each(['123', 1.5, 0, -1])('rejects invalid version_id %s', async (versionId) => {
    const response = await finalize(versionId)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('error_version_id_invalid')
  })

  it.concurrent('rejects a nonexistent version', async () => {
    const response = await finalize(Number.MAX_SAFE_INTEGER)
    expect(response.status).toBe(404)
    expect((await response.json() as { error: string }).error).toBe('error_version_not_found')
  })

  it.concurrent.each([
    { deleted: true, deletedAt: null },
    { deleted: false, deletedAt: new Date().toISOString() },
  ])('rejects a deleted version %#', async (state) => {
    const versionId = await createVersion(state)
    const response = await finalize(versionId)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('error_version_deleted')
  })

  it.concurrent('rejects an API key without upload permission', async () => {
    const versionId = await createVersion()
    const response = await finalize(versionId, deniedApiKey)
    expect(response.status).toBe(401)
    expect((await response.json() as { error: string }).error).toBe('not_authorized')
    expect((await readVersion(versionId)).storage_provider).toBe('r2-direct')
  })

  it.concurrent('rejects a key from another organization', async () => {
    const versionId = await createVersion()
    const response = await finalize(versionId, crossOrgApiKey)
    expect(response.status).toBe(401)
    expect((await readVersion(versionId)).storage_provider).toBe('r2-direct')
  })

  it.concurrent('rejects unsupported storage providers without modification', async () => {
    const versionId = await createVersion({ storageProvider: 'external' })
    const response = await finalize(versionId)
    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toBe('error_version_not_finalizable')
    expect((await readVersion(versionId)).storage_provider).toBe('external')
  })

  it.concurrent('handles concurrent finalization requests idempotently', async () => {
    const versionId = await createVersion()
    const responses = await Promise.all([finalize(versionId), finalize(versionId)])
    expect(responses.map(response => response.status)).toEqual([200, 200])
    expect((await readVersion(versionId)).storage_provider).toBe('r2')
  })
})
