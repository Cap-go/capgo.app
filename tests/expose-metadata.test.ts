import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  APP_NAME,
  fetchTestRequest,
  getBaseData,
  getEndpointUrl,
  getSupabaseClient,
  headers,
  ORG_ID,
  postUpdate,
  resetAndSeedAppData,
  resetAppData,
  resetAppDataStats,
  STRIPE_INFO_CUSTOMER_ID,
} from './test-utils.ts'

const id = randomUUID()
const APP_NAME_METADATA = `${APP_NAME}.${id}`
const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
const describeBackend = describe.skipIf(USE_CLOUDFLARE)
const RELEASE_LINK = 'https://example.com/release-notes'
const RELEASE_COMMENT = 'This is a test release with new features'
const appUrl = `${getEndpointUrl('/app')}/${APP_NAME_METADATA}`

interface UpdateRes {
  error?: string
  url?: string
  checksum?: string
  version?: string
  message?: string
  link?: string
  comment?: string
}

const supabase = getSupabaseClient()

async function setExposeMetadata(expose_metadata: boolean) {
  const { error } = await supabase.from('apps').update({ expose_metadata }).eq('app_id', APP_NAME_METADATA)
  expect(error).toBeNull()
}

async function getStoredApp() {
  const { data, error } = await supabase
    .from('apps')
    .select('name, retention, expose_metadata')
    .eq('app_id', APP_NAME_METADATA)
    .single()
  expect(error).toBeNull()
  return data
}

async function putApp(body: Record<string, unknown>) {
  return fetchTestRequest(appUrl, { method: 'PUT', headers, body: JSON.stringify(body) })
}

async function requestUpdate(pluginVersion: string) {
  const baseData = getBaseData(APP_NAME_METADATA)
  baseData.version_name = '1.1.0' // Request an older version to trigger an update
  baseData.plugin_version = pluginVersion
  const response = await postUpdate(baseData)
  expect(response.status).toBe(200)
  return response.json<UpdateRes>()
}

beforeAll(async () => {
  await resetAndSeedAppData(APP_NAME_METADATA)
})

afterAll(async () => {
  await resetAppData(APP_NAME_METADATA)
  await resetAppDataStats(APP_NAME_METADATA)
})

// These are the same endpoints the CLI uses for `app set/get --expose-metadata`.
describe('expose_metadata via /app', () => {
  it.each([true, false])('sets expose_metadata=%s via PUT /app and persists it', async (value) => {
    await setExposeMetadata(!value)

    const response = await putApp({ expose_metadata: value })
    expect(response.status).toBe(200)
    expect((await response.json() as { expose_metadata: boolean }).expose_metadata).toBe(value)
    expect((await getStoredApp())?.expose_metadata).toBe(value)
  })

  it('updates expose_metadata along with other app settings', async () => {
    const response = await putApp({ name: 'Updated App Name', expose_metadata: true })

    expect(response.status).toBe(200)
    const data = await response.json() as { name: string, expose_metadata: boolean }
    expect(data).toMatchObject({ name: 'Updated App Name', expose_metadata: true })
    expect(await getStoredApp()).toMatchObject({ name: 'Updated App Name', expose_metadata: true })
  })

  it('preserves existing settings when only updating expose_metadata', async () => {
    await supabase
      .from('apps')
      .update({ name: 'Test App', retention: 604800, expose_metadata: false })
      .eq('app_id', APP_NAME_METADATA)

    const response = await putApp({ expose_metadata: true })

    expect(response.status).toBe(200)
    expect(await getStoredApp()).toMatchObject({ name: 'Test App', retention: 604800, expose_metadata: true })
  })

  it.each([true, false])('returns expose_metadata=%s from GET /app', async (value) => {
    await setExposeMetadata(value)

    const response = await fetchTestRequest(appUrl, { method: 'GET', headers })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ app_id: APP_NAME_METADATA, expose_metadata: value })
  })

  it('defaults expose_metadata to false for new apps', async () => {
    const newAppId = `${APP_NAME}.${randomUUID()}`
    try {
      const createResponse = await fetchTestRequest(getEndpointUrl('/app'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ app_id: newAppId, name: `Test App ${newAppId}`, owner_org: ORG_ID }),
      })
      expect(createResponse.status, await createResponse.clone().text()).toBe(200)

      const { data: appData, error } = await supabase
        .from('apps')
        .select('expose_metadata')
        .eq('app_id', newAppId)
        .single()
      expect(error).toBeNull()
      expect(appData?.expose_metadata).toBe(false)
    }
    finally {
      await supabase.from('apps').delete().eq('app_id', newAppId)
    }
  })

  it('rejects expose_metadata updates with an invalid API key', async () => {
    const response = await fetchTestRequest(appUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'invalid-api-key' },
      body: JSON.stringify({ expose_metadata: true }),
    })

    expect([401, 403]).toContain(response.status)
  })
})

describeBackend('[POST] /updates - metadata exposure with plugin version', () => {
  beforeAll(async () => {
    // Ensure the org has a valid plan (reset exceeded flags that might be set by other tests)
    await supabase
      .from('stripe_info')
      .update({
        is_good_plan: true,
        mau_exceeded: false,
        bandwidth_exceeded: false,
        storage_exceeded: false,
        build_time_exceeded: false,
      })
      .eq('customer_id', STRIPE_INFO_CUSTOMER_ID)

    // Add link and comment to the default version (1.0.0)
    const { data, error } = await supabase
      .from('app_versions')
      .update({ link: RELEASE_LINK, comment: RELEASE_COMMENT })
      .eq('app_id', APP_NAME_METADATA)
      .eq('name', '1.0.0')
      .select('id')
      .single()

    if (error || !data)
      throw error ?? new Error('Failed to update version with metadata')
  })

  it.each([
    // Minimum supported version for each major exposes metadata.
    { exposeMetadata: true, pluginVersion: '5.35.0', exposed: true },
    { exposeMetadata: true, pluginVersion: '6.35.0', exposed: true },
    { exposeMetadata: true, pluginVersion: '7.35.0', exposed: true },
    { exposeMetadata: true, pluginVersion: '8.35.0', exposed: true },
    // Just below each major threshold, or a very old plugin, does not.
    { exposeMetadata: true, pluginVersion: '5.34.9', exposed: false },
    { exposeMetadata: true, pluginVersion: '6.34.9', exposed: false },
    { exposeMetadata: true, pluginVersion: '7.34.9', exposed: false },
    { exposeMetadata: true, pluginVersion: '8.34.9', exposed: false },
    { exposeMetadata: true, pluginVersion: '5.10.0', exposed: false },
    // The app setting wins over a supporting plugin version.
    { exposeMetadata: false, pluginVersion: '5.35.0', exposed: false },
    { exposeMetadata: false, pluginVersion: '5.34.0', exposed: false },
  ])('expose_metadata=$exposeMetadata with plugin $pluginVersion exposes metadata: $exposed', async ({ exposeMetadata, pluginVersion, exposed }) => {
    await setExposeMetadata(exposeMetadata)

    const json = await requestUpdate(pluginVersion)

    expect(json.version).toBe('1.0.0')
    expect(json.link).toBe(exposed ? RELEASE_LINK : undefined)
    expect(json.comment).toBe(exposed ? RELEASE_COMMENT : undefined)
  })

  it('handles missing metadata fields gracefully when expose_metadata=true', async () => {
    // Create a version without link/comment but with checksum/external_url
    const { data: newVersion, error: insertError } = await supabase
      .from('app_versions')
      .insert({
        app_id: APP_NAME_METADATA,
        name: '0.9.0',
        owner_org: ORG_ID,
        storage_provider: 'r2',
        checksum: 'test-checksum-0.9.0',
        external_url: 'https://example.com/bundle-0.9.0.zip',
      })
      .select('id')
      .single()

    expect(insertError).toBeNull()
    expect(newVersion).not.toBeNull()

    const { data: originalVersion } = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', APP_NAME_METADATA)
      .eq('name', '1.0.0')
      .single()

    try {
      await supabase
        .from('channels')
        .update({ version: newVersion!.id })
        .eq('app_id', APP_NAME_METADATA)
        .eq('name', 'production')
      await setExposeMetadata(true)

      const json = await requestUpdate('5.35.0')
      expect(json.version).toBe('0.9.0')
      expect(json.link).toBeUndefined()
      expect(json.comment).toBeUndefined()
    }
    finally {
      await supabase
        .from('channels')
        .update({ version: originalVersion!.id })
        .eq('app_id', APP_NAME_METADATA)
        .eq('name', 'production')
      await supabase.from('app_versions').delete().eq('id', newVersion!.id)
    }
  })

  it.each([
    { link: 'https://example.com/link-only', comment: null },
    { link: null, comment: 'Comment without a link' },
  ])('exposes only the populated metadata field (link: $link, comment: $comment)', async ({ link, comment }) => {
    try {
      await supabase
        .from('app_versions')
        .update({ link, comment })
        .eq('app_id', APP_NAME_METADATA)
        .eq('name', '1.0.0')
      await setExposeMetadata(true)

      const json = await requestUpdate('5.35.0')
      expect(json.version).toBe('1.0.0')
      expect(json.link).toBe(link ?? undefined)
      expect(json.comment).toBe(comment ?? undefined)
    }
    finally {
      await supabase
        .from('app_versions')
        .update({ link: RELEASE_LINK, comment: RELEASE_COMMENT })
        .eq('app_id', APP_NAME_METADATA)
        .eq('name', '1.0.0')
    }
  })
})
