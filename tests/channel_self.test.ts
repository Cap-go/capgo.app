import type { SimpleErrorResponse } from '../supabase/functions/_backend/utils/hono.ts'
import type { DeviceLink, HttpMethod } from './test-utils.ts'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBaseData, getSupabaseClient, PLUGIN_BASE_URL, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils.ts'

interface ChannelInfo {
  id: number
  name: string
  public: boolean
  allow_self_set: boolean
}

type ChannelsListResponse = ChannelInfo[]

const id = randomUUID()
const APPNAME = `com.sa.${id}`
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

function getUniqueBaseData(appId: string) {
  const data = getBaseData(appId)
  data.device_id = randomUUID().toLowerCase()
  return data
}

async function fetchEndpoint(method: HttpMethod, bodyIn: object) {
  const url = new URL(`${PLUGIN_BASE_URL}/channel_self`)
  if (method === 'DELETE') {
    for (const [key, value] of Object.entries(bodyIn))
      url.searchParams.append(key, value.toString())
  }

  const body = method !== 'DELETE' ? JSON.stringify(bodyIn) : undefined
  const response = await fetch(url, {
    method,
    body,
  })

  return response
}

async function fetchGetChannels(queryParams: Record<string, string>) {
  const url = new URL(`${PLUGIN_BASE_URL}/channel_self`)
  for (const [key, value] of Object.entries(queryParams))
    url.searchParams.append(key, value)

  const response = await fetch(url, {
    method: 'GET',
  })

  return response
}

async function getResponseErrorCode(response: Response) {
  const json = await response.json<SimpleErrorResponse>()
  return json.error
}

type Awaitable<T> = T | PromiseLike<T>

async function withSupabaseCall<T extends { error?: { message?: string } | null }>(
  fn: () => Awaitable<T>,
): Promise<T> {
  return await Promise.resolve(fn())
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})
afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('invalids /channel_self tests', () => {
  it('[POST] invalid json', async () => {
    const response = await fetch(`${PLUGIN_BASE_URL}/channel_self`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: 'invalid json ;-)',
    })

    expect(response.ok).toBe(false)
    await response.arrayBuffer()
  })

  it('[POST] empty json', async () => {
    const response = await fetchEndpoint('POST', {})

    const error = await getResponseErrorCode(response)

    expect(error).toBe('invalid_json_body')
  })

  it('[POST] invalid semver', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.version_build = 'invalid semver'

    const response = await fetchEndpoint('POST', data)
    const error = await getResponseErrorCode(response)

    expect(error).toBe('semver_error')
  })

  it('[POST] without field (device_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.device_id

    const response = await fetchEndpoint('POST', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_device_id')
  })

  it('[POST] without field (app_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.app_id

    const response = await fetchEndpoint('POST', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_app_id')
  })

  it('[POST] without channel', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.channel

    const response = await fetchEndpoint('POST', data)
    expect(response.status).toBe(200)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_channel')
  })

  it('[POST] with a channel that does not exist', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.channel = 'unexisting_channel'

    const response = await fetchEndpoint('POST', data)
    expect(response.status).toBe(200)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('channel_not_found')
  })

  it('[POST] with a channel that does not allow self assign', async () => {
    const data = getUniqueBaseData(APPNAME)
    if (!data.channel)
      throw new Error('channel is undefined')

    const { error } = await getSupabaseClient().from('channels').update({ allow_device_self_set: false }).eq('name', data.channel).eq('app_id', APPNAME).select('id').single()

    expect(error).toBeNull()

    try {
      const response = await fetchEndpoint('POST', data)
      expect(response.status).toBe(200)

      const responseError = await getResponseErrorCode(response)
      expect(responseError).toBe('public_channel_self_set_not_allowed')
    }
    finally {
      const { error } = await getSupabaseClient().from('channels').update({ allow_device_self_set: true }).eq('name', data.channel).eq('app_id', APPNAME).select('id').single()

      expect(error).toBeNull()
    }
  })

  it('[PUT] invalid semver', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.version_build = 'invalid semver'

    const response = await fetchEndpoint('PUT', data)
    const error = await getResponseErrorCode(response)

    expect(error).toBe('semver_error')
  })

  it('[PUT] post without field (device_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.device_id

    const response = await fetchEndpoint('PUT', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_device_id')
  })

  it('[PUT] post without field (app_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.app_id

    const response = await fetchEndpoint('PUT', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_app_id')
  })

  it('[PUT] with a version that does not exist', async () => {
    // Version check was removed from channel_self - devices with unknown versions can still get channel info
    const data = getUniqueBaseData(APPNAME)
    data.version_name = `1.0.${Math.floor(Math.random() * 10000000)}`

    const response = await fetchEndpoint('PUT', data)
    expect(response.status).toBe(200)

    const responseJSON = await response.json<{ channel: string, status: string }>()
    expect(responseJSON.channel).toBeTruthy()
    expect(responseJSON.status).toBe('default')
  })

  it('[DELETE] invalid semver', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.version_build = 'invalid semver'

    const response = await fetchEndpoint('DELETE', data)
    const error = await getResponseErrorCode(response)

    expect(error).toBe('semver_error')
  })

  it('[DELETE] post without field (device_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.device_id

    const response = await fetchEndpoint('DELETE', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_device_id')
  })

  it('[DELETE] post without field (app_id)', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.app_id

    const response = await fetchEndpoint('DELETE', data)
    expect(response.status).toBe(400)

    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_app_id')
  })
})

describe('[GET] /channel_self tests', () => {
  it('[GET] without query params should return error', async () => {
    const response = await fetch(`${PLUGIN_BASE_URL}/channel_self`, {
      method: 'GET',
    })

    expect(response.ok).toBe(false)
    const error = await getResponseErrorCode(response)
    expect(error).toBe('invalid_query_parameters')
  })

  it('[GET] with invalid app_id format', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.app_id = 'invalid-app-id'
    const response = await fetchGetChannels(data as any)

    expect(response.status).toBe(400)
    const error = await getResponseErrorCode(response)
    expect(error).toBe('invalid_query_parameters')
  })

  it('[GET] with missing app_id', async () => {
    const data = getUniqueBaseData(APPNAME)
    delete data.app_id
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(false)
    const error = await getResponseErrorCode(response)
    expect(error).toBe('missing_app_id')
  })

  it('[GET] with invalid platform', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.platform = 'windows'
    const response = await fetchGetChannels(data as any)

    expect(response.status).toBe(400)
    const error = await getResponseErrorCode(response)
    expect(error).toBe('invalid_query_parameters')
  })

  it('[GET] with non-existent app_id', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.app_id = 'com.nonexistent.app'
    const response = await fetchGetChannels(data as any)

    expect(response.status).toBe(429)
    const error = await getResponseErrorCode(response)
    expect(error).toBe('on_premise_app')
  })

  it('[GET] should return compatible channels for iOS', async () => {
    await resetAndSeedAppData(APPNAME)

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'ios'
    data.is_emulator = false
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json<ChannelsListResponse>()

    expect(json).toBeDefined()
    expect(Array.isArray(json)).toBe(true)

    const channelNames = json.map(ch => ch.name)
    expect(channelNames).toContain('beta')
    expect(channelNames).toContain('development')
    expect(channelNames).not.toContain('production')
    expect(channelNames).not.toContain('no_access')
    expect(json).toHaveLength(2)
  })

  it('[GET] should return compatible channels for Android', async () => {
    await resetAndSeedAppData(APPNAME)

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'android'
    data.is_emulator = false
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json() as ChannelsListResponse

    expect(json).toBeDefined()
    expect(Array.isArray(json)).toBe(true)

    const channelNames = json.map(ch => ch.name)
    expect(channelNames).toContain('production')
    expect(channelNames).toContain('beta')
    expect(channelNames).not.toContain('development')
    expect(channelNames).not.toContain('no_access')
    expect(json).toHaveLength(2)
  })

  it('[GET] should return public channels matching platform/device when self-set is disabled', async () => {
    await resetAndSeedAppData(APPNAME)

    // Ensure all channels have self set disabled (should be default)
    const { error: updateError } = await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: false })
      .eq('app_id', APPNAME)

    expect(updateError).toBeNull()

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'ios'
    data.is_emulator = false
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json() as ChannelsListResponse

    expect(json).toBeDefined()
    expect(Array.isArray(json)).toBe(true)
    const channelNames = json.map(ch => ch.name)
    expect(channelNames).toContain('development')
    expect(channelNames).not.toContain('production')
    expect(channelNames).not.toContain('beta')
    expect(channelNames).not.toContain('no_access')
    expect(json).toHaveLength(1)
  })

  it('[GET] should only return channels compatible with platform', async () => {
    await resetAndSeedAppData(APPNAME)

    // Ensure all channels have self set enabled (restore default state)
    const { error: updateError } = await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: true })
      .eq('app_id', APPNAME)

    expect(updateError).toBeNull()

    // Request iOS channels - real device (is_emulator=false)
    const data = getUniqueBaseData(APPNAME)
    data.platform = 'ios'
    data.is_emulator = false
    data.is_prod = true
    const iosResponse = await fetchGetChannels(data as any)

    expect(iosResponse.ok).toBe(true)
    const iosJson = await iosResponse.json() as ChannelsListResponse

    const iosChannelNames = iosJson.map(ch => ch.name)
    expect(iosChannelNames).toContain('beta')
    expect(iosChannelNames).toContain('development')
    expect(iosChannelNames).not.toContain('production')
    expect(iosChannelNames).not.toContain('no_access')
    expect(iosJson).toHaveLength(2)

    // Request Android channels - real device (is_emulator=false)
    data.platform = 'android'
    data.is_emulator = false
    data.is_prod = true
    const androidResponse = await fetchGetChannels(data as any)

    expect(androidResponse.ok).toBe(true)
    const androidJson = await androidResponse.json() as ChannelsListResponse

    const androidChannelNames = androidJson.map(ch => ch.name)
    expect(androidChannelNames).toContain('production')
    expect(androidChannelNames).toContain('beta')
    expect(androidChannelNames).not.toContain('development')
    expect(androidChannelNames).not.toContain('no_access')
    expect(androidJson).toHaveLength(2)

    // Request Electron channels - real device (is_emulator=false)
    data.platform = 'electron'
    data.is_emulator = false
    data.is_prod = true
    const electronResponse = await fetchGetChannels(data as any)

    expect(electronResponse.ok).toBe(true)
    const electronJson = await electronResponse.json() as ChannelsListResponse

    const electronChannelNames = electronJson.map(ch => ch.name)
    // electron_only channel has electron=true, ios=false, android=false
    // beta channel has electron=true, ios=true, android=true
    // production has electron=true, ios=false, android=true
    // development has electron=false
    // no_access has electron=false
    expect(electronChannelNames).toContain('electron_only')
    expect(electronChannelNames).toContain('beta')
    expect(electronChannelNames).toContain('production')
    expect(electronChannelNames).not.toContain('development')
    expect(electronChannelNames).not.toContain('no_access')
    expect(electronJson).toHaveLength(3)
  })

  it('[GET] should return compatible channels for Electron', async () => {
    await resetAndSeedAppData(APPNAME)

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'electron'
    data.is_emulator = false
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json<ChannelsListResponse>()

    expect(json).toBeDefined()
    expect(Array.isArray(json)).toBe(true)

    const channelNames = json.map(ch => ch.name)
    // electron_only is electron-only channel (electron=true, allow_device_self_set=true)
    // beta has electron=true and allow_device_self_set=true
    // production has electron=true but is_public=true
    expect(channelNames).toContain('electron_only')
    expect(channelNames).toContain('beta')
    expect(channelNames).toContain('production')
    expect(channelNames).not.toContain('development') // electron=false
    expect(channelNames).not.toContain('no_access') // electron=false
    expect(json).toHaveLength(3)
  })

  it('[GET] should filter channels based on emulator compatibility', async () => {
    await resetAndSeedAppData(APPNAME)

    // Set beta channel to NOT allow emulators
    const { error: updateError, data: channelData } = await getSupabaseClient()
      .from('channels')
      .update({ allow_emulator: false })
      .eq('name', 'beta')
      .eq('app_id', APPNAME)
      .select('allow_emulator')
      .single()

    expect(updateError).toBeNull()
    expect(channelData?.allow_emulator).toBe(false)

    try {
      const data = getUniqueBaseData(APPNAME)
      data.platform = 'ios'
      data.is_emulator = true
      data.is_prod = true
      // Test emulator device - should NOT get beta channel
      const emulatorResponse = await fetchGetChannels(data as any)

      expect(emulatorResponse.ok).toBe(true)
      const emulatorJson = await emulatorResponse.json() as ChannelsListResponse
      const emulatorChannelNames = emulatorJson.map(ch => ch.name)

      expect(emulatorChannelNames).toContain('development') // should be included for emulators
      expect(emulatorChannelNames).not.toContain('beta') // should be filtered out for emulators

      // Test real device - allow_emulator does not affect physical devices
      data.is_emulator = false
      data.is_prod = true
      const prodResponse = await fetchGetChannels(data as any)

      expect(prodResponse.ok).toBe(true)
      const prodJson = await prodResponse.json() as ChannelsListResponse
      const prodChannelNames = prodJson.map(ch => ch.name)

      expect(prodChannelNames).toContain('beta')
      expect(prodChannelNames).toContain('development')
      expect(prodChannelNames).not.toContain('production')
      expect(prodChannelNames).not.toContain('no_access')
      expect(prodJson).toHaveLength(2)
    }
    finally {
      // Reset beta channel to allow emulators
      const { error: updateError, data: channelData } = await getSupabaseClient()
        .from('channels')
        .update({ allow_emulator: true })
        .eq('name', 'beta')
        .eq('app_id', APPNAME)
        .select('allow_emulator')
        .single()

      expect(updateError).toBeNull()
      expect(channelData?.allow_emulator).toBe(true)
    }
  })

  it('[GET] should filter channels based on dev/prod compatibility', async () => {
    await resetAndSeedAppData(APPNAME)

    // Set development channel to NOT allow dev devices
    const { error: updateError } = await getSupabaseClient()
      .from('channels')
      .update({ allow_dev: false })
      .eq('name', 'development')
      .eq('app_id', APPNAME)

    expect(updateError).toBeNull()

    try {
      // Test dev device - should only get channels that allow dev builds
      const data = getUniqueBaseData(APPNAME)
      data.platform = 'ios'
      data.is_emulator = false
      data.is_prod = false
      const devResponse = await fetchGetChannels(data as any)

      expect(devResponse.ok).toBe(true)
      const devJson = await devResponse.json() as ChannelsListResponse

      const devChannelNames = devJson.map(ch => ch.name)
      expect(devChannelNames).toContain('beta')
      expect(devChannelNames).not.toContain('development')
      expect(devChannelNames).not.toContain('production')
      expect(devChannelNames).not.toContain('no_access')
      expect(devJson).toHaveLength(1)

      // Test production device - should get channels that allow prod builds
      data.is_prod = true
      const prodResponse = await fetchGetChannels(data as any)

      expect(prodResponse.ok).toBe(true)
      const prodJson = await prodResponse.json() as ChannelsListResponse

      const prodChannelNames = prodJson.map(ch => ch.name)
      expect(prodChannelNames).toContain('beta')
      expect(prodChannelNames).toContain('development')
      expect(prodChannelNames).not.toContain('production')
      expect(prodChannelNames).not.toContain('no_access')
      expect(prodJson).toHaveLength(2)
    }
    finally {
      // Reset development channel to allow dev devices
      await getSupabaseClient()
        .from('channels')
        .update({ allow_dev: true })
        .eq('name', 'development')
        .eq('app_id', APPNAME)
    }
  })

  it('[GET] should default prod to true when not specified', async () => {
    await resetAndSeedAppData(APPNAME)

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'ios'
    data.is_emulator = false
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json() as ChannelsListResponse

    const channelNames = json.map(ch => ch.name)
    expect(channelNames).toContain('beta')
    expect(channelNames).toContain('development')
    expect(channelNames).not.toContain('production')
    expect(channelNames).not.toContain('no_access')
    expect(Array.isArray(json)).toBe(true)
    expect(json).toHaveLength(2)
  })

  it('[GET] should return channels for emulator devices', async () => {
    await resetAndSeedAppData(APPNAME)

    const data = getUniqueBaseData(APPNAME)
    data.platform = 'ios'
    data.is_emulator = true
    data.is_prod = true
    const response = await fetchGetChannels(data as any)

    expect(response.ok).toBe(true)
    const json = await response.json() as ChannelsListResponse

    expect(json).toBeDefined()
    expect(Array.isArray(json)).toBe(true)

    // Emulator device should get iOS channels that allow emulators
    const channelNames = json.map(ch => ch.name)
    expect(channelNames).toContain('beta')
    expect(channelNames).toContain('development')

    // Should NOT include channels that have ios=false: production and no_access
    expect(channelNames).not.toContain('production')
    expect(channelNames).not.toContain('no_access')

    expect(json).toHaveLength(2)
  })
})

it('[POST] with a version that does not exist', async () => {
  const data = getUniqueBaseData(APPNAME)
  data.version_name = `1.0.350`

  const response = await fetchEndpoint('POST', data)
  expect(response.status).toBe(200)

  const responseError = await getResponseErrorCode(response)
  expect(responseError).toBeUndefined()
})

it.skipIf(USE_CLOUDFLARE)('[POST] /channel_self creates new channel_device with owner_org', async () => {
  // This test ensures that when a NEW device sets a channel for the first time,
  // the channel_devices record is created with all required fields including owner_org
  // This specifically tests the INSERT path of the upsert operation
  await resetAndSeedAppData(APPNAME)

  // First, enable allow_device_self_set for beta channel (non-default channel)
  const { error: channelUpdateError, data: betaChannel } = await getSupabaseClient()
    .from('channels')
    .update({ allow_device_self_set: true })
    .eq('name', 'beta')
    .eq('app_id', APPNAME)
    .select('id, owner_org')
    .single()

  expect(channelUpdateError).toBeNull()
  expect(betaChannel).toBeTruthy()

  try {
    // Use a brand new device_id that has never been in channel_devices
    const data = getUniqueBaseData(APPNAME)
    data.device_id = randomUUID().toLowerCase()
    data.channel = 'beta' // Use non-default channel to trigger INSERT

    // Verify no existing channel_devices record for this device
    const { data: existingRecord } = await getSupabaseClient()
      .from('channel_devices')
      .select('*')
      .eq('device_id', data.device_id)
      .eq('app_id', APPNAME)

    expect(existingRecord).toHaveLength(0)

    // Call POST endpoint to set channel (this triggers INSERT in upsert)
    const response = await fetchEndpoint('POST', data)
    expect(response.ok).toBeTruthy()
    expect(await response.json()).toEqual({ status: 'ok' })

    // Verify channel_devices record was created with owner_org
    const { data: channelDevice, error: channelDeviceError } = await getSupabaseClient()
      .from('channel_devices')
      .select('device_id, app_id, channel_id, owner_org')
      .eq('device_id', data.device_id)
      .eq('app_id', APPNAME)
      .single()

    expect(channelDeviceError).toBeNull()
    expect(channelDevice).toBeTruthy()
    expect(channelDevice!.device_id).toBe(data.device_id)
    expect(channelDevice!.app_id).toBe(APPNAME)
    expect(channelDevice!.owner_org).toBeTruthy() // Most important: owner_org must be set
    expect(typeof channelDevice!.owner_org).toBe('string')
    expect(channelDevice!.channel_id).toBe(betaChannel!.id)

    // Verify owner_org matches the channel's owner_org
    expect(channelDevice!.owner_org).toBe(betaChannel!.owner_org)
  }
  finally {
    // Reset beta channel to not allow self set
    const { error: resetError } = await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: false })
      .eq('name', 'beta')
      .eq('app_id', APPNAME)

    expect(resetError).toBeNull()
  }
})

it.skipIf(USE_CLOUDFLARE)('[POST] /channel_self with default channel', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME)
  const deviceId = randomUUID().toLowerCase()
  data.device_id = deviceId

  const { error: channelUpdateError, data: noAccessData } = await getSupabaseClient()
    .from('channels')
    .update({ allow_device_self_set: true })
    .eq('name', 'no_access')
    .eq('app_id', APPNAME)
    .select('id, owner_org, public')
    .single()

  expect(channelUpdateError).toBeNull()
  expect(noAccessData).toBeTruthy()
  expect(noAccessData!.public).toBeFalsy()

  try {
    const { error: overwriteUpsertError } = await getSupabaseClient()
      .from('channel_devices')
      .upsert({
        app_id: APPNAME,
        channel_id: noAccessData!.id,
        device_id: data.device_id,
        owner_org: noAccessData!.owner_org,
      }, { onConflict: 'device_id, app_id' })

    expect(overwriteUpsertError).toBeNull()

    data.channel = 'production'
    const response = await fetchEndpoint('POST', data)
    expect(response.ok).toBeTruthy()
    expect(await response.json()).toEqual({ status: 'ok' })

    const { data: channelDevice, error: channelDeviceError } = await getSupabaseClient()
      .from('channel_devices')
      .select('*')
      .eq('device_id', data.device_id)
      .eq('app_id', APPNAME)

    expect(channelDeviceError).toBeNull()
    expect(channelDevice).toBeTruthy()
    expect(channelDevice).toHaveLength(0)
  }
  finally {
    const { error: channelUpdateError } = await getSupabaseClient().from('channels').update({ allow_device_self_set: false }).eq('name', 'no_access').eq('app_id', APPNAME)

    expect(channelUpdateError).toBeNull()
  }
})

it('[PUT] /channel_self (no overwrite)', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME)
  const deviceId = randomUUID().toLowerCase()
  data.device_id = deviceId

  const response = await fetchEndpoint('PUT', data)
  expect(response.ok).toBe(true)

  const responseJSON = await response.json<{ channel: string, status: string }>()
  const channel = responseJSON.channel
  const status = responseJSON.status

  expect(channel).toBeTruthy()
  expect(status).toBeTruthy()

  expect(status).toBe('default')
  expect(channel).toBe(data.channel)
})

it('[PUT] /channel_self with minimum required fields', async () => {
  await resetAndSeedAppData(APPNAME)

  // Test with only the minimum required fields according to jsonRequestSchema
  const minimalData = {
    app_id: APPNAME,
    device_id: randomUUID().toLowerCase(),
    version_name: '1.0.0',
    version_build: '1.0.0',
    is_emulator: false,
    is_prod: true,
    platform: 'android',
  }

  const response = await fetchEndpoint('PUT', minimalData)
  expect(response.ok).toBe(true)

  const responseJSON = await response.json<{ channel: string, status: string }>()
  expect(responseJSON.channel).toBeTruthy()
  expect(responseJSON.status).toBe('default')
})

it('[PUT] /channel_self with all optional fields included', async () => {
  await resetAndSeedAppData(APPNAME)

  // Test with all fields including optional ones
  const fullData = {
    app_id: APPNAME,
    device_id: randomUUID().toLowerCase(),
    version_name: '1.0.0',
    version_build: '1.0.0',
    is_emulator: true,
    is_prod: false,
    platform: 'ios',
    channel: 'production',
    custom_id: 'test-custom-id',
    version_code: '100',
    version_os: '17.0',
    plugin_version: '6.0.0',
    defaultChannel: 'production',
  }

  const response = await fetchEndpoint('PUT', fullData)
  expect(response.ok).toBe(true)

  const responseJSON = await response.json<{ channel: string, status: string }>()
  expect(responseJSON.channel).toBeTruthy()
  expect(responseJSON.status).toBe('default')
  // When defaultChannel is provided, it should return that channel
  expect(responseJSON.channel).toBe('production')
})

it.skipIf(USE_CLOUDFLARE)('[PUT] /channel_self (with overwrite)', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME)
  const deviceId = randomUUID().toLowerCase()
  data.device_id = deviceId

  const { data: noAccessChannel, error: noAccessChannelError } = await withSupabaseCall(() =>
    getSupabaseClient()
      .from('channels')
      .select('id, owner_org')
      .eq('name', 'no_access')
      .eq('app_id', APPNAME)
      .single(),
  )

  expect(noAccessChannelError).toBeNull()
  expect(noAccessChannel).toBeTruthy()

  if (!noAccessChannel?.owner_org) {
    throw new Error('no_access channel not found or missing owner_org')
  }

  const noAccessId = noAccessChannel.id
  const ownerOrg = noAccessChannel.owner_org

  const { error } = await withSupabaseCall(() =>
    getSupabaseClient()
      .from('channel_devices')
      .upsert({
        app_id: APPNAME,
        channel_id: noAccessId,
        device_id: deviceId,
        owner_org: ownerOrg,
      }, { onConflict: 'device_id, app_id' }),
  )

  expect(error).toBeNull()

  try {
    const response = await fetchEndpoint('PUT', data)
    expect(response.ok).toBe(true)

    const responseJSON = await response.json<{ channel: string, status: string }>()
    const channel = responseJSON.channel
    const status = responseJSON.status

    expect(channel).toBeTruthy()
    expect(status).toBeTruthy()

    expect(status).toBe('override')
    expect(channel).toBe('no_access')
  }
  finally {
    const { error } = await withSupabaseCall(() =>
      getSupabaseClient()
        .from('channel_devices')
        .delete()
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
        .eq('owner_org', ownerOrg)
        .eq('channel_id', noAccessId)
        .single(),
    )

    expect(error).toBeNull()
  }
})

it('[PUT] /channel_self with defaultChannel parameter', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME) as DeviceLink
  data.device_id = randomUUID().toLowerCase()
  data.defaultChannel = 'no_access'

  const response = await fetchEndpoint('PUT', data)
  expect(response.ok).toBe(true)

  const responseJSON = await response.json<{ channel: string, status: string }>()
  expect(responseJSON.channel).toBe('no_access')
  expect(responseJSON.status).toBe('default')
})

it('[PUT] /channel_self with non-existent defaultChannel', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME) as DeviceLink
  data.device_id = randomUUID().toLowerCase()
  data.defaultChannel = 'non_existent_channel'

  const response = await fetchEndpoint('PUT', data)
  expect(response.ok).toBe(true)

  const error = await getResponseErrorCode(response)
  expect(error).toBe('channel_not_found')
})

it('[DELETE] /channel_self (no overwrite)', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME)
  data.device_id = randomUUID().toLowerCase()

  const response = await fetchEndpoint('DELETE', data)
  expect(response.status).toBe(200)

  const error = await getResponseErrorCode(response)
  expect(error).toBe('cannot_override')
})

it.skipIf(USE_CLOUDFLARE)('[DELETE] /channel_self (with overwrite)', async () => {
  await resetAndSeedAppData(APPNAME)

  const data = getUniqueBaseData(APPNAME)
  data.device_id = randomUUID().toLowerCase()

  const { data: productionChannel, error: productionChannelError } = await getSupabaseClient().from('channels').select('id, owner_org').eq('name', 'production').eq('app_id', APPNAME).single()

  expect(productionChannelError).toBeNull()
  expect(productionChannel).toBeTruthy()

  const productionId = productionChannel!.id
  const ownerOrg = productionChannel!.owner_org

  const { error } = await getSupabaseClient().from('channel_devices').upsert({
    app_id: APPNAME,
    channel_id: productionId,
    device_id: data.device_id,
    owner_org: ownerOrg,
  }, { onConflict: 'device_id, app_id' })

  expect(error).toBeNull()

  try {
    const response = await fetchEndpoint('DELETE', data)
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ status: 'ok' })

    const { data: channelDevice, error: channelDeviceError } = await getSupabaseClient().from('channel_devices').select('*').eq('device_id', data.device_id).eq('app_id', APPNAME)

    expect(channelDeviceError).toBeNull()
    expect(channelDevice).toBeTruthy()
    expect(channelDevice).toHaveLength(0)
  }
  catch (e) {
    const { error } = await getSupabaseClient().from('channel_devices').delete().eq('device_id', data.device_id).eq('app_id', APPNAME).eq('owner_org', ownerOrg).eq('channel_id', productionId).single()

    expect(error).toBeNull()
    throw e
  }
})

describe.skipIf(!USE_CLOUDFLARE)('[POST/PUT/DELETE] /channel_self Cloudflare KV behavior', () => {
  async function expectNoChannelDeviceRow(deviceId: string) {
    const { count, error } = await getSupabaseClient()
      .from('channel_devices')
      .select('*', { count: 'exact', head: true })
      .eq('device_id', deviceId)
      .eq('app_id', APPNAME)

    expect(error).toBeNull()
    expect(count).toBe(0)
  }

  it('stores old plugin overrides outside channel_devices', async () => {
    await resetAndSeedAppData(APPNAME)

    const { error: channelUpdateError } = await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: true })
      .eq('name', 'beta')
      .eq('app_id', APPNAME)

    expect(channelUpdateError).toBeNull()

    const data = getUniqueBaseData(APPNAME)
    if (!data.device_id)
      throw new Error('device_id is required')
    data.plugin_version = '7.0.0'
    data.channel = 'beta'

    try {
      const postResponse = await fetchEndpoint('POST', data)
      expect(postResponse.ok).toBeTruthy()
      expect(await postResponse.json()).toEqual({ status: 'ok' })
      await expectNoChannelDeviceRow(data.device_id)

      const putResponse = await fetchEndpoint('PUT', data)
      expect(putResponse.ok).toBeTruthy()
      expect(await putResponse.json()).toMatchObject({ channel: 'beta', status: 'override' })
      await expectNoChannelDeviceRow(data.device_id)

      const deleteResponse = await fetchEndpoint('DELETE', data)
      expect(deleteResponse.ok).toBeTruthy()
      expect(await deleteResponse.json()).toEqual({ status: 'ok' })
      await expectNoChannelDeviceRow(data.device_id)

      const afterDeleteResponse = await fetchEndpoint('PUT', data)
      expect(afterDeleteResponse.ok).toBeTruthy()
      expect(await afterDeleteResponse.json()).toMatchObject({ status: 'default' })
    }
    finally {
      const { error: resetError } = await getSupabaseClient()
        .from('channels')
        .update({ allow_device_self_set: false })
        .eq('name', 'beta')
        .eq('app_id', APPNAME)

      expect(resetError).toBeNull()
    }
  })
})

it('verify channel stays after deleting channel_device', async () => {
  await resetAndSeedAppData(APPNAME)

  // 1. Get a channel to use for the test
  const { data: channel, error: channelError } = await getSupabaseClient()
    .from('channels')
    .select('id, name, owner_org')
    .eq('name', 'production')
    .eq('app_id', APPNAME)
    .single()

  expect(channelError).toBeNull()
  expect(channel).toBeTruthy()
  const channelId = channel!.id
  const channelName = channel!.name
  const ownerOrg = channel!.owner_org

  // 2. Create a device linked to this channel
  const deviceId = randomUUID().toLowerCase()
  const { error: insertError } = await getSupabaseClient()
    .from('channel_devices')
    .insert({
      channel_id: channelId,
      device_id: deviceId,
      app_id: APPNAME,
      owner_org: ownerOrg,
    })

  expect(insertError).toBeNull()

  // 3. Verify the device exists
  const { data: deviceBefore, error: deviceBeforeError } = await getSupabaseClient()
    .from('channel_devices')
    .select('*')
    .eq('device_id', deviceId)
    .eq('app_id', APPNAME)
    .single()

  expect(deviceBeforeError).toBeNull()
  expect(deviceBefore).toBeTruthy()
  expect(deviceBefore!.channel_id).toBe(channelId)

  // 4. Delete the device
  const { error: deleteError } = await getSupabaseClient()
    .from('channel_devices')
    .delete()
    .eq('device_id', deviceId)
    .eq('app_id', APPNAME)

  expect(deleteError).toBeNull()

  // 5. Verify the channel still exists
  const { data: channelAfter, error: channelAfterError } = await getSupabaseClient()
    .from('channels')
    .select('id, name')
    .eq('id', channelId)
    .eq('app_id', APPNAME)
    .single()

  expect(channelAfterError).toBeNull()
  expect(channelAfter).toBeTruthy()
  expect(channelAfter!.id).toBe(channelId)
  expect(channelAfter!.name).toBe(channelName)
})

it.skipIf(USE_CLOUDFLARE)('saves default_channel when provided', async () => {
  const uuid = randomUUID().toLowerCase()
  const testDefaultChannel = 'beta'

  // Enable allow_device_self_set for beta channel
  const { error: updateError } = await getSupabaseClient()
    .from('channels')
    .update({ allow_device_self_set: true })
    .eq('name', 'beta')
    .eq('app_id', APPNAME)

  expect(updateError).toBeNull()

  const baseData = getUniqueBaseData(APPNAME)
  baseData.device_id = uuid
  baseData.defaultChannel = testDefaultChannel
  baseData.channel = 'beta' // Required for POST /channel_self

  const response = await fetchEndpoint('POST', baseData)
  expect(response.status).toBe(200)

  // Wait for data to be written
  await new Promise(resolve => setTimeout(resolve, 1000))

  // Verify default_channel was saved
  const { error, data } = await getSupabaseClient()
    .from('devices')
    .select('default_channel')
    .eq('device_id', uuid)
    .eq('app_id', APPNAME)
    .single()

  expect(error).toBeNull()
  expect(data).toBeTruthy()
  expect(data?.default_channel).toBe(testDefaultChannel)

  // Clean up
  await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APPNAME)
})

describe('[POST] /channel_self - new plugin version (>= 7.34.0) behavior', () => {
  it('should validate and return success without storing in channel_devices for new plugin versions', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.plugin_version = '7.34.0' // New version
    data.channel = 'production'

    const response = await fetchEndpoint('POST', data)
    expect(response.status).toBe(200)

    const result = await response.json<{ status: string, allowSet: boolean }>()
    expect(result.status).toBe('ok')
    expect(result.allowSet).toBe(true)

    // Verify it was NOT stored in channel_devices table
    if (!data.device_id)
      throw new Error('device_id is required')

    const { data: channelDeviceData } = await getSupabaseClient()
      .from('channel_devices')
      .select('*')
      .eq('device_id', data.device_id)
      .eq('app_id', APPNAME)
      .maybeSingle()

    expect(channelDeviceData).toBeNull()
  })

  it('should return error when channel does not allow self-assignment for new plugin versions', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.plugin_version = '7.34.0'
    data.channel = 'production'

    // Disable allow_device_self_set for production channel
    await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: false })
      .eq('name', 'production')
      .eq('app_id', APPNAME)

    try {
      const response = await fetchEndpoint('POST', data)
      expect(response.status).toBe(200)

      const result = await response.json<{ error: string }>()
      expect(result.error).toBe('public_channel_self_set_not_allowed')
    }
    finally {
      // Re-enable allow_device_self_set
      await getSupabaseClient()
        .from('channels')
        .update({ allow_device_self_set: true })
        .eq('name', 'production')
        .eq('app_id', APPNAME)
    }
  })

  it.skipIf(USE_CLOUDFLARE)('should leave old channel_devices entry untouched when migrating from old to new version', async () => {
    const deviceId = randomUUID()
    const data = getUniqueBaseData(APPNAME)
    data.device_id = deviceId

    // Enable allow_device_self_set for beta channel (non-default channel)
    await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: true })
      .eq('name', 'beta')
      .eq('app_id', APPNAME)

    // Also enable it for a second channel so the migration request can avoid
    // the "same set max once per 60 seconds" limiter (keyed by channel).
    await getSupabaseClient()
      .from('channels')
      .update({ allow_device_self_set: true })
      .eq('name', 'development')
      .eq('app_id', APPNAME)

    try {
      // First, set channel with old version (stores in channel_devices)
      data.plugin_version = '7.33.0'
      data.channel = 'beta' // Use non-default channel

      const oldResponse = await fetchEndpoint('POST', data)
      expect(oldResponse.status).toBe(200)

      // Verify it was stored in channel_devices
      const { data: oldChannelDevice } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
        .maybeSingle()

      expect(oldChannelDevice).toBeTruthy()

      // Then, set channel with new version (should not read or write old server-side storage)
      data.plugin_version = '7.34.0'
      data.channel = 'development'

      const newResponse = await fetchEndpoint('POST', data)
      expect(newResponse.status).toBe(200)

      const result = await newResponse.json<{ status: string, allowSet: boolean }>()
      expect(result.status).toBe('ok')
      expect(result.allowSet).toBe(true)

      // Verify old entry was left untouched
      const { data: newChannelDevice } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
        .maybeSingle()

      expect(newChannelDevice).toBeTruthy()
      expect(newChannelDevice?.channel_id).toBe(oldChannelDevice?.channel_id)
    }
    finally {
      await getSupabaseClient()
        .from('channel_devices')
        .delete()
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)

      // Reset beta channel
      await getSupabaseClient()
        .from('channels')
        .update({ allow_device_self_set: false })
        .eq('name', 'beta')
        .eq('app_id', APPNAME)

      await getSupabaseClient()
        .from('channels')
        .update({ allow_device_self_set: false })
        .eq('name', 'development')
        .eq('app_id', APPNAME)
    }
  })
})

describe('[PUT] /channel_self - new plugin version (>= 7.34.0) behavior', () => {
  it('should return channel from request body for new plugin versions', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.plugin_version = '7.34.0'
    data.channel = 'production' // Plugin sends its local channelOverride
    data.defaultChannel = 'production'

    const response = await fetchEndpoint('PUT', data)
    expect(response.status).toBe(200)

    const result = await response.json<{ channel: string, status: string }>()
    expect(result.channel).toBe('production')
    expect(result.status).toBe('override')
  })

  it('should return defaultChannel when no channel override is set', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.plugin_version = '7.34.0'
    data.defaultChannel = 'production'
    // No channel field - no override
    delete data.channel // Remove the channel field to simulate no override

    const response = await fetchEndpoint('PUT', data)
    expect(response.status).toBe(200)

    const result = await response.json<{ channel: string, status: string }>()
    expect(result.channel).toBe('production')
    expect(result.status).toBe('default')
  })
})

describe('[DELETE] /channel_self - new plugin version (>= 7.34.0) behavior', () => {
  it('should return success and leave old channel_devices entries untouched for new plugin versions', async () => {
    const deviceId = randomUUID()
    const data = getUniqueBaseData(APPNAME)
    data.device_id = deviceId
    data.plugin_version = '7.34.0'

    // First create an old channel_devices entry (simulating migration from old version)
    const { data: productionChannel } = await getSupabaseClient()
      .from('channels')
      .select('id, owner_org')
      .eq('name', 'production')
      .eq('app_id', APPNAME)
      .single()

    expect(productionChannel).toBeTruthy()

    await getSupabaseClient()
      .from('channel_devices')
      .insert({
        app_id: APPNAME,
        channel_id: productionChannel!.id,
        device_id: deviceId,
        owner_org: productionChannel!.owner_org,
      })

    try {
      // Verify the old entry exists
      const { data: beforeDelete } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
        .maybeSingle()

      expect(beforeDelete).toBeTruthy()

      // Call DELETE with new plugin version
      const response = await fetchEndpoint('DELETE', data)
      expect(response.status).toBe(200)

      const result = await response.json<{ status: string }>()
      expect(result.status).toBe('ok')

      // Verify the old entry was left untouched
      const { data: afterDelete } = await getSupabaseClient()
        .from('channel_devices')
        .select('*')
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
        .maybeSingle()

      expect(afterDelete).toBeTruthy()
      expect(afterDelete?.channel_id).toBe(productionChannel!.id)
    }
    finally {
      await getSupabaseClient()
        .from('channel_devices')
        .delete()
        .eq('device_id', deviceId)
        .eq('app_id', APPNAME)
    }
  })

  it('should return success even when no old channel_devices entry exists', async () => {
    const data = getUniqueBaseData(APPNAME)
    data.plugin_version = '7.34.0'
    data.device_id = randomUUID()

    const response = await fetchEndpoint('DELETE', data)
    expect(response.status).toBe(200)

    const result = await response.json<{ status: string }>()
    expect(result.status).toBe('ok')
  })
})
