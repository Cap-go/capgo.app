import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getSupabaseClient, ORG_ID, PLUGIN_BASE_URL, resetAndSeedAppData, resetAppData, USER_ID } from '../test-utils.ts'

const testAppId = `com.test.channel.deletion.${Date.now()}`

beforeAll(async () => {
  await resetAndSeedAppData(testAppId)
})

afterAll(async () => {
  await resetAppData(testAppId)
})

async function createChannelWithDeviceOverride() {
  const supabase = getSupabaseClient()
  const deviceId = randomUUID()

  // Get an existing version for this app (created by seed)
  const { data: existingVersion, error: versionQueryError } = await supabase
    .from('app_versions')
    .select('id')
    .eq('app_id', testAppId)
    .limit(1)
    .single()
  expect(versionQueryError).toBeNull()
  expect(existingVersion).not.toBeNull()

  const { data: channelData, error: channelError } = await supabase
    .from('channels')
    .insert({
      app_id: testAppId,
      name: `test-channel-${randomUUID()}`,
      version: existingVersion!.id,
      created_by: USER_ID,
      owner_org: ORG_ID,
      allow_device_self_set: true,
    })
    .select()
    .single()
  expect(channelError).toBeNull()
  expect(channelData).not.toBeNull()

  const { error: channelDeviceError } = await supabase
    .from('channel_devices')
    .insert({
      app_id: testAppId,
      device_id: deviceId,
      channel_id: channelData!.id,
      owner_org: ORG_ID,
    })
  expect(channelDeviceError).toBeNull()

  return { channelId: channelData!.id, deviceId }
}

async function expectChannelStillExists(channelId: number) {
  const supabase = getSupabaseClient()
  const { data, error } = await supabase
    .from('channels')
    .select()
    .eq('id', channelId)
  expect(error).toBeNull()
  expect(data).toHaveLength(1)
  await supabase.from('channels').delete().eq('id', channelId)
}

// Removing a device override (directly or through channel_self) must never delete the channel itself.
describe('channel survives channel_devices removal', () => {
  it('should not delete channel when channel_devices entry is deleted', async () => {
    const { channelId, deviceId } = await createChannelWithDeviceOverride()

    const { error: deleteError } = await getSupabaseClient()
      .from('channel_devices')
      .delete()
      .eq('app_id', testAppId)
      .eq('device_id', deviceId)
    expect(deleteError).toBeNull()

    await expectChannelStillExists(channelId)
  })

  it('should not delete channel when channel_self deleteOverride is called', async () => {
    const { channelId, deviceId } = await createChannelWithDeviceOverride()

    // channel_self DELETE takes query params (not body), including all required device fields
    const url = new URL(`${PLUGIN_BASE_URL}/channel_self`)
    for (const [key, value] of Object.entries({
      app_id: testAppId,
      device_id: deviceId,
      version_build: '1.0.0',
      version_name: '1.0.0',
      is_emulator: 'false',
      is_prod: 'true',
      platform: 'android',
    })) {
      url.searchParams.append(key, value)
    }

    const response = await fetch(url, { method: 'DELETE' })
    expect(response.status).toBe(200)

    await expectChannelStillExists(channelId)
  })
})
