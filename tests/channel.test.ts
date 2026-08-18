import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { getCanonicalAppVersionR2Path } from '../supabase/functions/_backend/utils/app_version_r2_path.ts'
import { BASE_URL, createAppVersions, getSupabaseClient, headers, ORG_ID, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.app.c.${id}`
let productionVersionId: number | null = null

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
  const { data } = await getSupabaseClient()
    .from('app_versions')
    .select('id')
    .eq('app_id', APPNAME)
    .eq('name', '1.0.0')
    .single()
    .throwOnError()
  productionVersionId = data.id
})
afterEach(async () => {
  const client = getSupabaseClient()
  await client
    .from('channels')
    .update({ update_package: 'all', ...(productionVersionId ? { version: productionVersionId } : {}) })
    .eq('app_id', APPNAME)
    .eq('name', 'production')
    .throwOnError()
})
afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('[GET] /channel operations', () => {
  it('get channels', async () => {
    const params = new URLSearchParams({ app_id: APPNAME })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json()
    expect(response.status).toBe(200)
    expect(Array.isArray(data)).toBe(true)
  })

  it('get specific channel', async () => {
    const params = new URLSearchParams({ app_id: APPNAME, channel: 'production' })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })

    const data = await response.json<{ name: string }>()
    expect(response.status).toBe(200)
    expect(data.name).toBe('production')
  })

  it('invalid app_id', async () => {
    const params = new URLSearchParams({ app_id: 'invalid_app' })
    const response = await fetch(`${BASE_URL}/channel?${params.toString()}`, {
      method: 'GET',
      headers,
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })
})

describe('[POST] /channel operations', () => {
  it('create channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: `test_channel_${id.slice(0, 8)}`,
        public: false,
      }),
    })
    const data = await response.json<{ status: string, error?: string, message?: string }>()
    expect(response.status, JSON.stringify(data)).toBe(200)
    expect(data.status).toBe('ok')
  })

  it('update channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        disableAutoUpdateUnderNative: false,
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })

  it('update channel package mode', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        updatePackage: 'zip',
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')

    const getResponse = await fetch(`${BASE_URL}/channel?${new URLSearchParams({ app_id: APPNAME, channel: 'production' }).toString()}`, {
      method: 'GET',
      headers,
    })
    const channel = await getResponse.json<{ updatePackage: string }>()
    expect(getResponse.status).toBe(200)
    expect(channel.updatePackage).toBe('zip')
  })

  it('invalid app_id', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: 'invalid_app',
        channel: 'test_channel',
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })
})

describe('channel update package vs bundle compatibility', () => {
  async function insertDelta(versionId: number) {
    await getSupabaseClient()
      .from('manifest')
      .insert({
        app_version_id: versionId,
        file_name: `pkg-${versionId}.js`,
        s3_path: `/pkg-${versionId}.js`,
        file_hash: `hash-${versionId}`,
        file_size: 16,
      })
      .throwOnError()
  }

  async function productionChannel() {
    const { data } = await getSupabaseClient()
      .from('channels')
      .select('id, version')
      .eq('app_id', APPNAME)
      .eq('name', 'production')
      .single()
      .throwOnError()
    return data
  }

  it('refuses delta-only when the current bundle has no delta files', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        updatePackage: 'delta',
      }),
    })
    const data = await response.json<{ error?: string, message?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('channel_delta_required')
    expect(data.message).toContain('no delta files')
    expect(data.message).toContain('1.0.0')
  })

  it('refuses zip-only when assigning a delta-only bundle', async () => {
    const deltaOnly = await createAppVersions(`1.0.delta-${randomUUID().slice(0, 8)}`, APPNAME, {
      checksum: 'delta-only',
      storage_provider: 'r2-direct',
      r2_path: null,
    })
    await insertDelta(deltaOnly.id)

    await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        updatePackage: 'zip',
      }),
    })

    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        version: deltaOnly.name,
      }),
    })
    const data = await response.json<{ error?: string, message?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('channel_zip_required')
    expect(data.message).toContain('no zip')
    expect(data.message).toContain(deltaOnly.name)
  })

  it('refuses assigning a zip-only bundle to a delta-only channel', async () => {
    const withDeltaName = `1.0.both-${randomUUID().slice(0, 8)}`
    const withDelta = await createAppVersions(withDeltaName, APPNAME, {
      checksum: 'zip-and-delta',
      storage_provider: 'r2',
      r2_path: getCanonicalAppVersionR2Path(ORG_ID, APPNAME, withDeltaName),
    })
    await insertDelta(withDelta.id)
    await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        version: withDelta.name,
        updatePackage: 'delta',
      }),
    })

    const zipOnlyName = `1.0.zip-${randomUUID().slice(0, 8)}`
    const zipOnly = await createAppVersions(zipOnlyName, APPNAME, {
      checksum: 'zip-only',
      storage_provider: 'r2',
      r2_path: getCanonicalAppVersionR2Path(ORG_ID, APPNAME, zipOnlyName),
    })

    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        version: zipOnly.name,
      }),
    })
    const data = await response.json<{ error?: string, message?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('channel_delta_required')
    expect(data.message).toContain('no delta files')
    expect(data.message).toContain(zipOnly.name)
  })

  it('refuses zip-only assignment through PUT /bundle', async () => {
    const channel = await productionChannel()
    const deltaOnly = await createAppVersions(`1.0.put-delta-${randomUUID().slice(0, 8)}`, APPNAME, {
      checksum: 'put-delta-only',
      storage_provider: 'r2-direct',
      r2_path: null,
    })
    await insertDelta(deltaOnly.id)
    await fetch(`${BASE_URL}/channel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        channel: 'production',
        updatePackage: 'zip',
      }),
    })

    const response = await fetch(`${BASE_URL}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        app_id: APPNAME,
        version_id: deltaOnly.id,
        channel_id: channel.id,
      }),
    })
    const data = await response.json<{ error?: string, message?: string }>()
    expect(response.status).toBe(400)
    expect(data.error).toBe('channel_zip_required')
    expect(data.message).toContain('no zip')
  })

  it('refuses an incompatible setting change through a console-style channel update', async () => {
    const zipOnlyName = `1.0.ui-zip-${randomUUID().slice(0, 8)}`
    const zipOnly = await createAppVersions(zipOnlyName, APPNAME, {
      checksum: 'ui-zip-only',
      storage_provider: 'r2',
      r2_path: getCanonicalAppVersionR2Path(ORG_ID, APPNAME, zipOnlyName),
    })
    await getSupabaseClient()
      .from('channels')
      .update({ version: zipOnly.id, update_package: 'all' })
      .eq('app_id', APPNAME)
      .eq('name', 'production')
      .throwOnError()

    const { error } = await getSupabaseClient()
      .from('channels')
      .update({ update_package: 'delta' })
      .eq('app_id', APPNAME)
      .eq('name', 'production')
    expect(error).toBeTruthy()
    expect(error?.message).toContain('CHANNEL_DELTA_REQUIRED')
    expect(error?.message).toContain('no delta files')
  })
})

describe('[DELETE] /channel operations', () => {
  it('invalid channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        channel: 'invalid_channel',
        app_id: APPNAME,
      }),
    })
    await response.arrayBuffer()
    expect(response.status).toBe(400)
  })

  it('delete channel', async () => {
    const response = await fetch(`${BASE_URL}/channel`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        channel: 'production',
        app_id: APPNAME,
      }),
    })

    const data = await response.json<{ status: string }>()
    expect(response.status).toBe(200)
    expect(data.status).toBe('ok')
  })
})
