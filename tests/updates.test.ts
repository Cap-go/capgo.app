import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { z } from 'zod'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'

import { APP_NAME, createAppVersions, getBaseData, getEndpointUrl, getSupabaseClient, getVersionFromAction, headers, ORG_ID, postUpdate, resetAndSeedAppData, resetAppData, resetAppDataStats, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APP_NAME_UPDATE = `${APP_NAME}.${id}`
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

interface UpdateRes {
  error?: string
  kind?: 'up_to_date' | 'blocked' | 'failed'
  url?: string
  checksum?: string
  version?: string
  message?: string
  manifest?: { file_name: string | null, file_hash?: string | null, download_url?: string | null }[]
  old?: string
  major?: boolean
}

const updateNewScheme = z.object({
  url: z.string(),
  version: z.string(),
})

async function updateChannel(
  channel: string,
  patch: {
    version?: string
    public?: boolean
    disableAutoUpdateUnderNative?: boolean
    disableAutoUpdate?: 'major' | 'minor' | 'patch' | 'version_number' | 'none'
    ios?: boolean
    android?: boolean
    allow_device_self_set?: boolean
    allow_emulator?: boolean
    allow_device?: boolean
    allow_dev?: boolean
    allow_prod?: boolean
  },
) {
  let version = patch.version
  if (!version) {
    const { data, error } = await getSupabaseClient()
      .from('channels')
      .select('version:app_versions!channels_version_fkey(name)')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', channel)
      .single()

    if (error)
      throw error

    version = (data.version as { name: string } | null)?.name
    if (!version)
      throw new Error(`Missing current version for channel ${channel}`)
  }

  const response = await fetch(getEndpointUrl('/channel'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      app_id: APP_NAME_UPDATE,
      channel,
      version,
      ...patch,
    }),
  })

  const responseText = await response.text()
  if (response.status !== 200) {
    throw new Error(`Channel update failed (${response.status}): ${responseText}`)
  }
  expect(JSON.parse(responseText) as { status: string }).toEqual({ status: 'ok' })
}

async function postUpdateAfterChannelMutation(data: Partial<ReturnType<typeof getBaseData>>) {
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await postUpdate(data)
    if (response.status !== 429) {
      return response
    }

    const responseText = await response.text()
    if (!responseText.includes('"error":"on_premise_app"')) {
      throw new Error(`Unexpected update failure after channel mutation (${response.status}): ${responseText}`)
    }

    lastResponse = new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
    await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }

  if (!lastResponse) {
    throw new Error('Expected an update response after channel mutation')
  }

  return lastResponse
}

beforeAll(async () => {
  await resetAndSeedAppData(APP_NAME_UPDATE)
}, 60_000)
afterAll(async () => {
  await resetAppData(APP_NAME_UPDATE)
  await resetAppDataStats(APP_NAME_UPDATE)
}, 60_000)

describe.skipIf(!USE_CLOUDFLARE)('[POST] /updates Cloudflare write guard', () => {
  it('returns update data without creating a primary device row', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_build = getVersionFromAction('get')
    const version = await createAppVersions(baseData.version_build, APP_NAME_UPDATE)
    baseData.version_name = version.name
    baseData.device_id = uuid

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const jsonResponse = await response.json<UpdateRes>()
    expect(jsonResponse.checksum).toBe('3885ee49')

    const { count, error } = await getSupabaseClient()
      .from('devices')
      .select('*', { count: 'exact', head: true })
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_UPDATE)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })
})

describe('[POST] /updates', () => {
  it('no new version available', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    const response = await postUpdate(baseData)

    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.error).toEqual('no_new_version_available')
    expect(json.kind).toBe('up_to_date')
  })

  it('new version available', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_name = '1.1.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
    expect(json.version).toBe('1.0.0')
  })

  it('does not resolve deleted bundles that are still referenced by a channel', async () => {
    const supabase = getSupabaseClient()
    const versionName = `1.0.${Math.floor(Math.random() * 100000) + 1000}`
    const channelName = `deleted-bundle-${randomUUID().slice(0, 8)}`

    const version = await createAppVersions(versionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/${channelName}.zip`,
    })

    await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APP_NAME_UPDATE,
        version: version.id,
        owner_org: ORG_ID,
        created_by: USER_ID,
        public: false,
        disable_auto_update_under_native: false,
        disable_auto_update: 'none',
        allow_device_self_set: true,
        allow_emulator: false,
        allow_device: true,
        allow_dev: false,
        allow_prod: true,
        ios: true,
        android: false,
      })
      .throwOnError()

    await supabase
      .from('app_versions')
      .update({ deleted: true })
      .eq('id', version.id)
      .throwOnError()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.defaultChannel = channelName
    baseData.version_build = '0.0.0'
    baseData.version_name = '0.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('no_channel')
    expect(json.version).toBeUndefined()
  })

  it('ignores deleted device override bundles and falls back to the normal channel selection', async () => {
    const supabase = getSupabaseClient()
    const versionName = `1.0.${Math.floor(Math.random() * 100000) + 1000}`
    const channelName = `deleted-override-${randomUUID().slice(0, 8)}`
    const deviceId = randomUUID().toLowerCase()

    const version = await createAppVersions(versionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/${channelName}.zip`,
    })

    const { data: insertedChannel } = await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APP_NAME_UPDATE,
        version: version.id,
        owner_org: ORG_ID,
        created_by: USER_ID,
        public: false,
        disable_auto_update_under_native: false,
        disable_auto_update: 'none',
        allow_device_self_set: true,
        allow_emulator: false,
        allow_device: true,
        allow_dev: false,
        allow_prod: true,
        ios: true,
        android: false,
      })
      .select('id')
      .single()
      .throwOnError()

    await supabase
      .from('channel_devices')
      .insert({
        channel_id: insertedChannel.id,
        app_id: APP_NAME_UPDATE,
        device_id: deviceId,
        owner_org: ORG_ID,
      })
      .throwOnError()

    await supabase
      .from('app_versions')
      .update({ deleted: true })
      .eq('id', version.id)
      .throwOnError()

    const expectedFallbackData = getBaseData(APP_NAME_UPDATE)
    expectedFallbackData.version_build = '0.0.0'
    expectedFallbackData.version_name = '0.0.0'

    const expectedFallbackResponse = await postUpdate(expectedFallbackData)
    expect(expectedFallbackResponse.status).toBe(200)
    const expectedFallbackJson = await expectedFallbackResponse.json<UpdateRes>()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = deviceId
    baseData.version_build = '0.0.0'
    baseData.version_name = '0.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(json.version).not.toBe(versionName)
    expect(json.version).toBe(expectedFallbackJson.version)
    expect(json.error).toBe(expectedFallbackJson.error)
    expect(json.url).toBe(expectedFallbackJson.url)
    expect(json.checksum).toBe(expectedFallbackJson.checksum)
  })

  it('keeps zero-percent rollout targets on the fast path', async () => {
    const supabase = getSupabaseClient()
    const rolloutVersionName = `1.2.${Math.floor(Math.random() * 100000) + 1000}`
    const rolloutVersion = await createAppVersions(rolloutVersionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/disabled-rollout-${rolloutVersionName}.zip`,
    })

    const { data: productionChannel } = await supabase
      .from('channels')
      .select('id,rollout_version,rollout_enabled,rollout_percentage_bps,rollout_paused_at,rollout_pause_reason')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'production')
      .single()
      .throwOnError()

    await supabase
      .from('channels')
      .update({
        rollout_version: rolloutVersion.id,
        rollout_enabled: true,
        rollout_percentage_bps: 0,
        rollout_paused_at: null,
        rollout_pause_reason: null,
      })
      .eq('id', productionChannel.id)
      .eq('app_id', APP_NAME_UPDATE)
      .throwOnError()

    try {
      const { data: app } = await supabase
        .from('apps')
        .select('rollout_channel_count,rollout_paused_version_names')
        .eq('app_id', APP_NAME_UPDATE)
        .single()
        .throwOnError()

      expect(app.rollout_channel_count).toBe(0)
      expect(app.rollout_paused_version_names).not.toContain(rolloutVersionName)

      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = rolloutVersionName
      baseData.version_build = rolloutVersionName

      const response = await postUpdateAfterChannelMutation(baseData)
      expect(response.status).toBe(200)

      const json = await response.json<UpdateRes>()
      expect(json.version).not.toBe(rolloutVersionName)
    }
    finally {
      await supabase
        .from('channels')
        .update({
          rollout_version: productionChannel.rollout_version,
          rollout_enabled: productionChannel.rollout_enabled,
          rollout_percentage_bps: productionChannel.rollout_percentage_bps,
          rollout_paused_at: productionChannel.rollout_paused_at,
          rollout_pause_reason: productionChannel.rollout_pause_reason,
        })
        .eq('id', productionChannel.id)
        .eq('app_id', APP_NAME_UPDATE)
        .throwOnError()
    }
  })

  it('keeps paused rollout targets available only for devices already on that version', async () => {
    const supabase = getSupabaseClient()
    const rolloutVersionName = `1.3.${Math.floor(Math.random() * 100000) + 1000}`
    const rolloutVersion = await createAppVersions(rolloutVersionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/paused-rollout-${rolloutVersionName}.zip`,
    })

    const { data: productionChannel } = await supabase
      .from('channels')
      .select('id,rollout_version,rollout_enabled,rollout_percentage_bps,rollout_paused_at,rollout_pause_reason')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'production')
      .single()
      .throwOnError()

    await supabase
      .from('channels')
      .update({
        rollout_version: rolloutVersion.id,
        rollout_enabled: true,
        rollout_percentage_bps: 10000,
      })
      .eq('id', productionChannel.id)
      .eq('app_id', APP_NAME_UPDATE)
      .throwOnError()

    await supabase
      .from('channels')
      .update({
        rollout_paused_at: new Date().toISOString(),
        rollout_pause_reason: 'test pause',
      })
      .eq('id', productionChannel.id)
      .eq('app_id', APP_NAME_UPDATE)
      .throwOnError()

    try {
      const { data: app } = await supabase
        .from('apps')
        .select('rollout_channel_count,rollout_paused_version_names')
        .eq('app_id', APP_NAME_UPDATE)
        .single()
        .throwOnError()

      expect(app.rollout_channel_count).toBe(0)
      expect(app.rollout_paused_version_names).toContain(rolloutVersionName)

      const existingRolloutDevice = getBaseData(APP_NAME_UPDATE)
      existingRolloutDevice.version_name = rolloutVersionName
      existingRolloutDevice.version_build = rolloutVersionName

      const existingResponse = await postUpdateAfterChannelMutation(existingRolloutDevice)
      expect(existingResponse.status).toBe(200)
      const existingJson = await existingResponse.json<UpdateRes>()
      expect(existingJson.error).toBe('no_new_version_available')
      expect(existingJson.kind).toBe('up_to_date')

      const stableDevice = getBaseData(APP_NAME_UPDATE)
      stableDevice.version_name = '0.0.0'
      stableDevice.version_build = '0.0.0'

      const stableResponse = await postUpdateAfterChannelMutation(stableDevice)
      expect(stableResponse.status).toBe(200)
      const stableJson = await stableResponse.json<UpdateRes>()
      expect(stableJson.version).not.toBe(rolloutVersionName)
    }
    finally {
      await supabase
        .from('channels')
        .update({
          rollout_version: productionChannel.rollout_version,
          rollout_enabled: productionChannel.rollout_enabled,
          rollout_percentage_bps: productionChannel.rollout_percentage_bps,
          rollout_paused_at: productionChannel.rollout_paused_at,
          rollout_pause_reason: productionChannel.rollout_pause_reason,
        })
        .eq('id', productionChannel.id)
        .eq('app_id', APP_NAME_UPDATE)
        .throwOnError()
    }
  })

  it('keeps native channel targets addressable without app_versions placeholders', async () => {
    const supabase = getSupabaseClient()
    const { data: productionChannel } = await supabase
      .from('channels')
      .select('id,version')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'production')
      .single()
      .throwOnError()

    await supabase
      .from('channels')
      .update({ version: null })
      .eq('id', productionChannel.id)
      .eq('app_id', APP_NAME_UPDATE)
      .throwOnError()

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)

      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('already_on_builtin')
      expect(json.version).toBe('builtin')
    }
    finally {
      await supabase
        .from('channels')
        .update({ version: productionChannel.version })
        .eq('id', productionChannel.id)
        .eq('app_id', APP_NAME_UPDATE)
        .throwOnError()
    }
  })
})

describe('channel device count gating', () => {
  const supabase = getSupabaseClient()
  let betaChannelId: number

  beforeAll(async () => {
    const { data, error } = await supabase
      .from('channels')
      .select('id')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'beta')
      .single()
    if (error || !data)
      throw error ?? new Error('Missing beta channel')
    betaChannelId = data.id
  })

  async function processChannelDeviceQueue(batchSize = 25) {
    const { error } = await supabase.rpc('process_channel_device_counts_queue' as any, { batch_size: batchSize })
    if (error)
      throw error
  }

  async function cleanupDevice(deviceId: string) {
    await supabase.from('channel_devices').delete().eq('app_id', APP_NAME_UPDATE).eq('device_id', deviceId)
    await processChannelDeviceQueue()
    await supabase.from('apps').update({ channel_device_count: 0 }).eq('app_id', APP_NAME_UPDATE)
  }

  it('uses device overrides when count is positive', async () => {
    const deviceId = randomUUID().toLowerCase()
    await supabase.from('channel_devices').insert({
      channel_id: betaChannelId,
      app_id: APP_NAME_UPDATE,
      device_id: deviceId,
      owner_org: ORG_ID,
    })
    await processChannelDeviceQueue()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = deviceId
    baseData.version_name = '0.0.0'
    baseData.version_build = '0.0.0'

    try {
      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.version).toBe('1.361.0')
    }
    finally {
      await cleanupDevice(deviceId)
    }
  })

  it('ignores overrides when count forced to zero', async () => {
    const deviceId = randomUUID().toLowerCase()
    await supabase.from('channel_devices').insert({
      channel_id: betaChannelId,
      app_id: APP_NAME_UPDATE,
      device_id: deviceId,
      owner_org: ORG_ID,
    })
    await processChannelDeviceQueue()
    await supabase.from('apps').update({ channel_device_count: 0 }).eq('app_id', APP_NAME_UPDATE)

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = deviceId
    baseData.version_name = '0.0.0'
    baseData.version_build = '0.0.0'

    try {
      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.version).toBe('1.0.0')
    }
    finally {
      await cleanupDevice(deviceId)
    }
  })
})

describe('manifest bundle count gating', () => {
  const supabase = getSupabaseClient()
  const insertedManifestIds: number[] = []
  let baseVersionId: number

  beforeAll(async () => {
    const { data, error } = await supabase
      .from('app_versions')
      .select('id')
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', '1.0.0')
      .single()
    if (error || !data)
      throw error ?? new Error('Missing base version for manifest tests')
    baseVersionId = data.id
  })

  afterEach(async () => {
    if (insertedManifestIds.length > 0) {
      await supabase.from('manifest').delete().in('id', insertedManifestIds)
      insertedManifestIds.length = 0
    }
    await supabase.from('apps').update({ manifest_bundle_count: 0 }).eq('app_id', APP_NAME_UPDATE)
  })

  async function seedManifestEntry() {
    const suffix = randomUUID().slice(0, 8)
    const fileName = `manifest-test-${suffix}.js`
    const { data, error } = await supabase
      .from('manifest')
      .insert({
        app_version_id: baseVersionId,
        file_name: fileName,
        s3_path: `tests/${fileName}`,
        file_hash: `hash-${suffix}`,
      })
      .select('id')
      .single()
    if (error || !data)
      throw error ?? new Error('Failed to seed manifest entry')
    insertedManifestIds.push(data.id)
    return fileName
  }

  function makeUpdatePayload() {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_name = '1.1.0'
    // Manifest support requires plugin_version >= 7.0.35 for v7
    baseData.plugin_version = '7.1.0'
    return baseData
  }

  it('returns manifest entries when manifest bundles exist', async () => {
    const fileName = await seedManifestEntry()
    const { error } = await supabase.from('apps').update({ manifest_bundle_count: 1 }).eq('app_id', APP_NAME_UPDATE)
    if (error)
      throw error

    const response = await postUpdate(makeUpdatePayload())
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.manifest).toBeDefined()
    expect(json.manifest?.some(entry => entry?.file_name === fileName)).toBe(true)
  })

  it('skips manifest query when manifest bundle count is zero', async () => {
    await seedManifestEntry()
    const response = await postUpdate(makeUpdatePayload())
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.manifest).toBeUndefined()
  })
})

describe('[POST] /updates parallel tests', () => {
  it.skipIf(USE_CLOUDFLARE)('with new device', async () => {
    const uuid = randomUUID().toLowerCase()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_build = getVersionFromAction('get')
    const version = await createAppVersions(baseData.version_build, APP_NAME_UPDATE)
    baseData.version_name = version.name
    baseData.device_id = uuid

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const jsonResponse = await response.json<UpdateRes>()
    expect(jsonResponse.checksum).toBe('3885ee49')

    const { error, data } = await getSupabaseClient().from('devices').select().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE).single()
    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data?.app_id).toBe(baseData.app_id)

    const response2 = await postUpdate(getBaseData(APP_NAME_UPDATE))
    expect(response2.status).toBe(200)
    const json = await response2.json<UpdateRes>()
    expect(json.error).toEqual('no_new_version_available')
    expect(json.kind).toBe('up_to_date')

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE)
  })

  it('disable auto update to major', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_build = '0.0.0'
    baseData.version_name = '0.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('disable_auto_update_to_major')
    expect(json.kind).toBe('blocked')
  })

  it('app that does not exist', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.app_id = 'does.not.exist'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(429)
    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('on_premise_app')
    expect(json.kind).toBeUndefined()
  })

  it('direct channel overwrite', async () => {
    const uuid = randomUUID().toLowerCase()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = uuid
    baseData.defaultChannel = 'beta'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
    expect(json.version).toBe('1.361.0')
  })

  it('hides private defaultChannel before major upgrade checks', async () => {
    const supabase = getSupabaseClient()
    const versionName = `9.9.${Math.floor(Math.random() * 100000) + 1000}`
    const channelName = `private-noself-${randomUUID().slice(0, 8)}`

    const version = await createAppVersions(versionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/${channelName}.zip`,
    })

    await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APP_NAME_UPDATE,
        version: version.id,
        owner_org: ORG_ID,
        created_by: USER_ID,
        public: false,
        disable_auto_update_under_native: false,
        disable_auto_update: 'major',
        allow_device_self_set: false,
        allow_emulator: true,
        allow_device: true,
        allow_dev: true,
        allow_prod: true,
        ios: true,
        android: true,
        electron: true,
      })
      .throwOnError()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.platform = 'android'
    baseData.defaultChannel = channelName
    baseData.version_build = '0.0.1'
    baseData.version_name = '0.0.1'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('no_channel')
    expect(json.version).toBeUndefined()
    expect(json.old).toBeUndefined()
    expect(json.major).toBeUndefined()
  })

  it('allows private self-settable platform-compatible defaultChannel', async () => {
    const supabase = getSupabaseClient()
    const versionName = `9.7.${Math.floor(Math.random() * 100000) + 1000}`
    const channelName = `private-selfset-${randomUUID().slice(0, 8)}`

    const version = await createAppVersions(versionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/${channelName}.zip`,
    })

    await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APP_NAME_UPDATE,
        version: version.id,
        owner_org: ORG_ID,
        created_by: USER_ID,
        public: false,
        disable_auto_update_under_native: false,
        disable_auto_update: 'none',
        allow_device_self_set: true,
        allow_emulator: true,
        allow_device: true,
        allow_dev: true,
        allow_prod: true,
        ios: false,
        android: true,
        electron: false,
      })
      .throwOnError()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.platform = 'android'
    baseData.defaultChannel = channelName
    baseData.version_build = '0.0.1'
    baseData.version_name = '0.0.1'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
    expect(json.version).toBe(versionName)
    expect(json.error).toBeUndefined()
  })

  it('hides platform-incompatible private defaultChannel before platform checks', async () => {
    const supabase = getSupabaseClient()
    const versionName = `9.8.${Math.floor(Math.random() * 100000) + 1000}`
    const channelName = `private-iosonly-${randomUUID().slice(0, 8)}`

    const version = await createAppVersions(versionName, APP_NAME_UPDATE, {
      external_url: `https://example.com/${channelName}.zip`,
    })

    await supabase
      .from('channels')
      .insert({
        name: channelName,
        app_id: APP_NAME_UPDATE,
        version: version.id,
        owner_org: ORG_ID,
        created_by: USER_ID,
        public: false,
        disable_auto_update_under_native: false,
        disable_auto_update: 'none',
        allow_device_self_set: true,
        allow_emulator: true,
        allow_device: true,
        allow_dev: true,
        allow_prod: true,
        ios: true,
        android: false,
        electron: false,
      })
      .throwOnError()

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.platform = 'android'
    baseData.defaultChannel = channelName
    baseData.version_build = '0.0.1'
    baseData.version_name = '0.0.1'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('no_channel')
    expect(json.version).toBeUndefined()
    expect(json.old).toBeUndefined()
    expect(json.major).toBeUndefined()
  })
})

describe('[POST] /updates invalid data', () => {
  it('unsupported platform', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.platform = 'unsupported_platform'
    baseData.version_name = '1.1.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(400)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('invalid_json_body')
  })

  it('invalid device_id', async () => {
    const invalidUUID = 'invalid-uuid'

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = invalidUUID
    baseData.version_name = '1.1.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(400)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('invalid_json_body')
  })

  it('invalid plugin_version', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.plugin_version = 'invalid_version'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(400)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('invalid_json_body')
  })

  it('missing fields', async () => {
    const baseData = {} as any

    const response = await postUpdate(baseData)
    expect(response.status).toBe(400)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('invalid_json_body')
  })

  it('only platform field', async () => {
    const baseData = { platform: 'android' } as any

    const response = await postUpdate(baseData)
    expect(response.status).toBe(400)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('missing_device_id')
  })

  it('electron platform is valid', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.platform = 'electron'
    baseData.version_name = '1.1.0'

    const response = await postUpdate(baseData)
    // Should not return 400 invalid_json_body for electron platform
    expect(response.status).not.toBe(400)
  })

  it('device_id and app_id combination not found', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = '00000000-0000-0000-1234-000000000000'
    baseData.app_id = 'non.existent.app'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(429)

    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('on_premise_app')
    expect(json.kind).toBeUndefined()
  })
})

describe('update scenarios', () => {
  it('disable auto update under native', async () => {
    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_build = '2.0.0'
    baseData.version_name = '2.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)
    const json = await response.json<UpdateRes>()
    expect(json.error).toBe('disable_auto_update_under_native')
  })

  it('disable auto update to minor', async () => {
    await updateChannel('production', { disableAutoUpdate: 'minor', version: '1.361.0' })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('disable_auto_update_to_minor')
    }
    finally {
      await updateChannel('production', { disableAutoUpdate: 'major', version: '1.0.0' })
    }
  })

  it('disable auto update to minor blocks cross-major updates', async () => {
    // Minor strategy: blocks if major OR minor changed
    // This test ensures that updates across major versions are blocked even if minor is the same
    await updateChannel('production', { disableAutoUpdate: 'minor', version: '1.361.0' })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      // Device is on 0.361.0, channel has 1.361.0 - same minor, different major
      baseData.version_name = '0.361.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      // Should block because major version changed (0 -> 1)
      expect(json.error).toBe('disable_auto_update_to_minor')
    }
    finally {
      await updateChannel('production', { disableAutoUpdate: 'major', version: '1.0.0' })
    }
  })

  it('disable auto update to patch blocks cross-minor updates', async () => {
    // Patch strategy: blocks if major OR minor OR patch changed
    // This test ensures that updates across minor versions are blocked
    await updateChannel('production', { disableAutoUpdate: 'patch', version: '1.361.0' })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      // Device is on 1.360.0, channel has 1.361.0 - different minor
      baseData.version_name = '1.360.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      // Should block because minor version changed (360 -> 361)
      expect(json.error).toBe('disable_auto_update_to_patch')
    }
    finally {
      await updateChannel('production', { disableAutoUpdate: 'major', version: '1.0.0' })
    }
  })

  it('disable auto update to patch blocks cross-major updates', async () => {
    // Patch strategy: blocks if major OR minor OR patch changed
    // This test ensures that updates across major versions are blocked
    await updateChannel('production', { disableAutoUpdate: 'patch', version: '1.361.0' })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      // Device is on 0.361.0, channel has 1.361.0 - different major
      baseData.version_name = '0.361.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      // Should block because major version changed (0 -> 1)
      expect(json.error).toBe('disable_auto_update_to_patch')
    }
    finally {
      await updateChannel('production', { disableAutoUpdate: 'major', version: '1.0.0' })
    }
  })

  it('disallow emulator', async () => {
    await getSupabaseClient()
      .from('channels')
      .update({ allow_emulator: false, disable_auto_update: 'major' })
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'production')
      .throwOnError()

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'
      baseData.is_emulator = true

      const response = await postUpdateAfterChannelMutation(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('disable_emulator')
    }
    finally {
      await getSupabaseClient()
        .from('channels')
        .update({ allow_emulator: true })
        .eq('app_id', APP_NAME_UPDATE)
        .eq('name', 'production')
        .throwOnError()
    }
  })

  it('disallow device', async () => {
    await getSupabaseClient()
      .from('channels')
      .update({ allow_device: false })
      .eq('app_id', APP_NAME_UPDATE)
      .eq('name', 'production')
      .throwOnError()

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'
      baseData.is_emulator = false

      const response = await postUpdateAfterChannelMutation(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('disable_device')
    }
    finally {
      await getSupabaseClient()
        .from('channels')
        .update({ allow_device: true })
        .eq('app_id', APP_NAME_UPDATE)
        .eq('name', 'production')
        .throwOnError()
    }
  })

  it('development build', async () => {
    await updateChannel('production', { allow_dev: false })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'
      baseData.is_prod = false

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('disable_dev_build')
    }
    finally {
      await updateChannel('production', { allow_dev: true })
    }
  })

  it('production build', async () => {
    await updateChannel('production', { allow_prod: false })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'
      baseData.is_prod = true

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('disable_prod_build')
    }
    finally {
      await updateChannel('production', { allow_prod: true })
    }
  })

  it('channel overwrite', async () => {
    const uuid = randomUUID().toLowerCase()

    // get the channel id
    const { data, error } = await getSupabaseClient().from('channels').select('id').eq('name', 'no_access').eq('app_id', APP_NAME_UPDATE).single()
    expect(error).toBeNull()
    expect(data).toBeTruthy()
    const channelId = data?.id

    const { data: data2 } = await getSupabaseClient().from('channel_devices').insert({
      device_id: uuid,
      channel_id: channelId as number,
      app_id: APP_NAME_UPDATE,
      owner_org: ORG_ID,
    }).select()

    expect(data2?.length).toBe(1)

    // Process the channel device count queue to update the app's channel_device_count
    await getSupabaseClient().rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })

    await updateChannel('no_access', {
      disableAutoUpdate: 'none',
      allow_dev: true,
      allow_prod: true,
      allow_emulator: true,
      allow_device: true,
      android: true,
    })

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = uuid
    baseData.version_name = '0.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<UpdateRes>()
    expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
    expect(json.version).toBe('1.361.0')

    // Clean up
    await getSupabaseClient().from('channel_devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE)
    await getSupabaseClient().rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })
  })

  it('disallowed public channel update', async () => {
    await updateChannel('production', { public: false })

    try {
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.version_name = '1.1.0'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('no_channel')
    }
    finally {
      await updateChannel('production', { public: true })
    }
  })

  it('hides private channel that does not allow self-assignment', async () => {
    // First reset the channel to ensure it's working properly
    await updateChannel('production', {
      public: true,
      allow_device_self_set: true,
    })

    // Now set both conditions that make the channel private.
    await updateChannel('production', {
      public: false,
      allow_device_self_set: false,
    })

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.version_name = '1.1.0'
    // A caller-supplied defaultChannel must not reveal that this private channel exists.
    baseData.defaultChannel = 'production'

    try {
      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)
      const json = await response.json<UpdateRes>()
      expect(json.error).toBe('no_channel')
      expect(json.version).toBeUndefined()
      expect(json.old).toBeUndefined()
      expect(json.major).toBeUndefined()
    }
    finally {
      await updateChannel('production', {
        public: true,
        allow_device_self_set: true,
      })
    }
  })

  it('private channel with device override should succeed', async () => {
    const uuid = randomUUID().toLowerCase()
    const supabase = getSupabaseClient()

    // Set up the channel as private and not allowing device self-set
    await updateChannel('production', {
      public: false,
      allow_device_self_set: false,
      version: '1.0.0',
    })

    try {
      // Get the channel id
      const { data: channelData, error: channelError } = await supabase
        .from('channels')
        .select('id')
        .eq('name', 'production')
        .eq('app_id', APP_NAME_UPDATE)
        .single()

      expect(channelError).toBeNull()
      expect(channelData).toBeTruthy()

      // Create a device override
      const { error: overrideError } = await supabase
        .from('channel_devices')
        .insert({
          device_id: uuid,
          channel_id: channelData!.id,
          app_id: APP_NAME_UPDATE,
          owner_org: ORG_ID,
        })

      expect(overrideError).toBeNull()
      await supabase.rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })

      // Test that update succeeds with device override
      const baseData = getBaseData(APP_NAME_UPDATE)
      baseData.device_id = uuid
      baseData.version_name = '1.1.0'
      baseData.defaultChannel = 'production'

      const response = await postUpdate(baseData)
      expect(response.status).toBe(200)

      const json = await response.json<UpdateRes>()
      // Should succeed with the new version, not error
      expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
      expect(json.version).toBe('1.0.0')
      expect(json.error).toBeUndefined()
    }
    finally {
      await supabase.from('channel_devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE)
      await supabase.rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })
      await updateChannel('production', {
        public: true,
        allow_device_self_set: true,
        version: '1.0.0',
      })
    }
  })

  it.skipIf(USE_CLOUDFLARE)('saves default_channel when provided', async () => {
    const uuid = randomUUID().toLowerCase()
    const testDefaultChannel = 'staging'

    const baseData = getBaseData(APP_NAME_UPDATE)
    baseData.device_id = uuid
    baseData.defaultChannel = testDefaultChannel

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    // Wait for data to be written
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Verify default_channel was saved in the database
    const { error, data } = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_UPDATE)
      .single()

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data?.default_channel).toBe(testDefaultChannel)

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE)
  })

  it.skipIf(USE_CLOUDFLARE)('overwrites default_channel with null when not provided', async () => {
    const uuid = randomUUID().toLowerCase()
    const testDefaultChannel = 'production'

    // First request with default_channel
    const baseData1 = getBaseData(APP_NAME_UPDATE)
    baseData1.device_id = uuid
    baseData1.defaultChannel = testDefaultChannel

    const response1 = await postUpdate(baseData1)
    expect(response1.status).toBe(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    // Second request WITHOUT default_channel (should overwrite with null)
    const baseData2 = getBaseData(APP_NAME_UPDATE)
    baseData2.device_id = uuid
    // No defaultChannel field

    const response2 = await postUpdate(baseData2)
    expect(response2.status).toBe(200)

    await new Promise(resolve => setTimeout(resolve, 1000))

    // Verify default_channel was overwritten with null
    const { error, data } = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_UPDATE)
      .single()

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data?.default_channel).toBeNull()

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_UPDATE)
  })
})
