import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getBaseData, getSupabaseClient, PLUGIN_BASE_URL, resetAndSeedAppData, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APPNAME = `com.spoof.${id}`

function getUniqueBaseData(appId: string) {
  const data = getBaseData(appId)
  data.device_id = randomUUID().toLowerCase()
  return data
}

async function postChannelSelf(body: Record<string, unknown>) {
  return await fetch(`${PLUGIN_BASE_URL}/channel_self`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

async function postUpdate(body: Record<string, unknown>) {
  return await fetch(`${PLUGIN_BASE_URL}/updates`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  await resetAndSeedAppData(APPNAME)
})

afterAll(async () => {
  await resetAppData(APPNAME)
  await resetAppDataStats(APPNAME)
})

describe('/channel_self spoofed override persistence', () => {
  it('rejects spoofed old plugin_version planting overrides that change /updates', async () => {
    const supabase = getSupabaseClient()
    const victimDeviceId = randomUUID().toLowerCase()
    const attackerDeviceId = randomUUID().toLowerCase()

    const { data: betaChannel, error: betaError } = await supabase
      .from('channels')
      .select('id, owner_org')
      .eq('name', 'beta')
      .eq('app_id', APPNAME)
      .single()

    expect(betaError).toBeNull()
    expect(betaChannel).toBeTruthy()

    await supabase
      .from('channels')
      .update({ allow_device_self_set: true })
      .eq('id', betaChannel!.id)

    const { data: orgRow } = await supabase
      .from('apps')
      .select('owner_org')
      .eq('app_id', APPNAME)
      .single()

    expect(orgRow?.owner_org).toBeTruthy()

    await supabase.from('devices').upsert({
      app_id: APPNAME,
      device_id: victimDeviceId,
      plugin_version: '7.34.0',
      platform: 'android',
      version: '1.0.0',
      version_build: '1.0.0',
      owner_org: orgRow!.owner_org,
    }, { onConflict: 'app_id,device_id' })

    const spoofData = getUniqueBaseData(APPNAME)
    spoofData.device_id = victimDeviceId
    spoofData.plugin_version = '7.33.0'
    spoofData.channel = 'beta'

    const spoofResponse = await postChannelSelf(spoofData)
    expect(spoofResponse.status).toBe(200)

    const { data: plantedOverride } = await supabase
      .from('channel_devices')
      .select('*')
      .eq('device_id', victimDeviceId)
      .eq('app_id', APPNAME)
      .maybeSingle()

    expect(plantedOverride).toBeNull()

    await supabase.from('channel_devices').insert({
      app_id: APPNAME,
      channel_id: betaChannel!.id,
      device_id: victimDeviceId,
      owner_org: betaChannel!.owner_org,
    })
    await supabase.rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })

    const victimUpdateBody = getUniqueBaseData(APPNAME)
    victimUpdateBody.device_id = victimDeviceId
    victimUpdateBody.plugin_version = '7.34.0'
    victimUpdateBody.version_name = '0.0.0'
    victimUpdateBody.version_build = '0.0.0'

    const victimResponse = await postUpdate(victimUpdateBody)
    expect(victimResponse.status).toBe(200)
    const victimJson = await victimResponse.json<{ version?: string }>()
    expect(victimJson.version).toBe('1.0.0')

    const forcedOverrideBody = getUniqueBaseData(APPNAME)
    forcedOverrideBody.device_id = attackerDeviceId
    forcedOverrideBody.plugin_version = '7.34.0'
    forcedOverrideBody.version_name = '0.0.0'
    forcedOverrideBody.version_build = '0.0.0'

    const { data: productionChannel } = await supabase
      .from('channels')
      .select('id')
      .eq('name', 'production')
      .eq('app_id', APPNAME)
      .single()

    expect(productionChannel).toBeTruthy()

    await supabase
      .from('channels')
      .update({ public: false, allow_device_self_set: false })
      .eq('id', productionChannel!.id)

    await supabase.from('channel_devices').insert({
      app_id: APPNAME,
      channel_id: productionChannel!.id,
      device_id: attackerDeviceId,
      owner_org: betaChannel!.owner_org,
    })
    await supabase.rpc('process_channel_device_counts_queue' as any, { batch_size: 10 })

    const forcedResponse = await postUpdate(forcedOverrideBody)
    expect(forcedResponse.status).toBe(200)
    const forcedJson = await forcedResponse.json<{ version?: string }>()
    expect(forcedJson.version).toBe('1.0.0')

    await supabase.from('channel_devices').delete().eq('app_id', APPNAME).in('device_id', [victimDeviceId, attackerDeviceId])
    await supabase.from('devices').delete().eq('app_id', APPNAME).in('device_id', [victimDeviceId, attackerDeviceId])
    await supabase
      .from('channels')
      .update({ public: true, allow_device_self_set: true })
      .eq('id', productionChannel!.id)
    await supabase
      .from('channels')
      .update({ allow_device_self_set: false })
      .eq('id', betaChannel!.id)
  })
})
