import type { ManifestEntry } from '../supabase/functions/_backend/utils/downloadUrl.ts'

import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createAppVersions, getBaseData, getSupabaseClient, PLUGIN_BASE_URL, postUpdate, resetAndSeedAppData, resetAppData, resetAppDataStats, warmEdgeEndpoint } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.demo.app.updates.${id}`

const manifestData = { file_name: 'test', s3_path: '/test_file.html', file_hash: '1234567890' }

let versionId: number | null = null
let createdVersionIds: number[] = []

interface UpdateRes {
  error?: string
  url?: string
  checksum?: string
  version?: string
  message?: string
  manifest?: ManifestEntry[]
}

// Helper to insert manifest entries directly into the manifest table
// This bypasses the trigger/queue system which doesn't run in test environment
async function insertManifestEntries(appVersionId: number) {
  const supabase = getSupabaseClient()
  // First, delete any existing manifest entries for this version
  await supabase.from('manifest').delete().eq('app_version_id', appVersionId)
  // Insert the manifest entry
  const { error } = await supabase.from('manifest').insert({
    app_version_id: appVersionId,
    file_name: manifestData.file_name,
    s3_path: manifestData.s3_path,
    file_hash: manifestData.file_hash,
    file_size: 100,
  })
  if (error)
    throw new Error(`Failed to insert manifest entry: ${error.message}`)

  // Update the manifest_count on the version
  await supabase.from('app_versions').update({ manifest_count: 1 }).eq('id', appVersionId)

  // Also update manifest_bundle_count on the app to enable manifest fetching
  const { data: version } = await supabase.from('app_versions').select('app_id').eq('id', appVersionId).single()
  if (version) {
    await supabase.from('apps').update({ manifest_bundle_count: 1 }).eq('app_id', version.app_id)
  }
}

// Helper to remove manifest entries
async function removeManifestEntries(appVersionId: number) {
  const supabase = getSupabaseClient()
  await supabase.from('manifest').delete().eq('app_version_id', appVersionId)
  await supabase.from('app_versions').update({ manifest_count: 0 }).eq('id', appVersionId)
}

async function createVersionWithoutR2Path(versionName: string) {
  const version = await createAppVersions(versionName, APPNAME, {
    checksum: `manifest-${versionName}`,
    r2_path: null,
  })
  createdVersionIds.push(version.id)
  return version
}

async function setProductionVersion(appVersionId: number) {
  await getSupabaseClient()
    .from('channels')
    .update({ version: appVersionId })
    .eq('app_id', APPNAME)
    .eq('name', 'production')
    .throwOnError()
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)

  // Store initial state for version 1.0.0 for cleanup
  const supabase = getSupabaseClient()
  const { data: versionData } = await supabase
    .from('app_versions')
    .select('id, r2_path')
    .eq('name', '1.0.0')
    .eq('app_id', APPNAME)
    .single()

  if (versionData) {
    versionId = versionData.id
  }

  // Warm the plugin worker before assertions. Cold first POST /updates can 503 under local workerd.
  const warmData = getBaseData(APPNAME)
  warmData.version_name = '1.0.0'
  await warmEdgeEndpoint(`${PLUGIN_BASE_URL}/updates`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(warmData),
  })
})

afterEach(async () => {
  // Reset the version to its initial state after each test
  // This ensures test isolation and prevents interdependencies
  const supabase = getSupabaseClient()

  const appVersionIds = [versionId, ...createdVersionIds].filter((id): id is number => id != null)

  if (appVersionIds.length) {
    // Remove any manifest entries added during the test
    await supabase.from('manifest').delete().in('app_version_id', appVersionIds)

    // Reset manifest counts after direct manifest fixture setup.
    await supabase
      .from('app_versions')
      .update({ manifest_count: 0 })
      .in('id', appVersionIds)
  }

  if (versionId) {
    await setProductionVersion(versionId)
  }

  // Reset app-level manifest_bundle_count
  await supabase.from('apps').update({ manifest_bundle_count: 0 }).eq('app_id', APPNAME)
  createdVersionIds = []
})

afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('update manifest scenarios', () => {
  it('manifest update', async () => {
    // test manifest update working with plugin version >= 6.25.0
    const baseData = getBaseData(APPNAME)
    // Get the version ID for 1.0.0
    const { data: versionData, error: versionError } = await getSupabaseClient()
      .from('app_versions')
      .select('id')
      .eq('name', '1.0.0')
      .eq('app_id', APPNAME)
      .single()

    if (versionError || !versionData) {
      console.log('Version data not found', versionError)
      throw new Error('Version data not found')
    }

    // Insert manifest entries directly into the manifest table
    await insertManifestEntries(versionData.id)

    baseData.version_name = '1.1.0'
    baseData.plugin_version = '6.25.0'
    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.manifest).toBeDefined()
    expect(json.manifest?.[0].file_name).toBe('test')
    expect(json.manifest?.[0].download_url).toContain('/test_file.html')
    expect(json.manifest?.[0].file_hash).toBe('1234567890')
  })

  // test for plugin version < 6.8.0
  it('manifest should not be available with plugin version < 6.8.0', async () => {
    const baseData = getBaseData(APPNAME)
    baseData.version_name = '1.1.0'
    baseData.plugin_version = '6.7.0'

    // Get the version ID and ensure manifest entries exist
    const { data: versionData } = await getSupabaseClient()
      .from('app_versions')
      .select('id')
      .eq('name', '1.0.0')
      .eq('app_id', APPNAME)
      .single()

    if (versionData) {
      await insertManifestEntries(versionData.id)
    }

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.manifest).toBeUndefined()
  })

  // test for an update with neither manifest nor r2_path
  it('update fail with nothing', async () => {
    const baseData = getBaseData(APPNAME)

    const version = await createVersionWithoutR2Path(`1.0.${Math.floor(Math.random() * 100000) + 1000}`)
    await setProductionVersion(version.id)
    await removeManifestEntries(version.id)

    // Also reset manifest_bundle_count on the app
    await getSupabaseClient().from('apps').update({ manifest_bundle_count: 0 }).eq('app_id', APPNAME)

    baseData.version_name = '1.1.0'
    baseData.plugin_version = '6.25.0'
    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.message).toBe('Cannot get bundle')
  })

  it('update with only manifest', async () => {
    const baseData = getBaseData(APPNAME)

    const version = await createVersionWithoutR2Path(`1.0.${Math.floor(Math.random() * 100000) + 1000}`)
    await setProductionVersion(version.id)
    await insertManifestEntries(version.id)

    baseData.version_name = '1.1.0'
    baseData.plugin_version = '6.25.0'
    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.manifest).toBeDefined()
  })
})
