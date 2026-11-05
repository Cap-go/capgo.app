import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP_NAME, fetchTestRequest, getEndpointUrl, getSupabaseClient, headers, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID()
const APP_ID = `${APP_NAME}.df.${id}`
const oldAndroid = randomUUID().toLowerCase()
const newAndroid = randomUUID().toLowerCase()
const iosDevice = randomUUID().toLowerCase()

beforeAll(async () => {
  await resetAndSeedAppData(APP_ID)
  await resetAndSeedAppDataStats(APP_ID)
  const supabase = getSupabaseClient()
  const { error } = await supabase.from('devices').upsert([
    {
      app_id: APP_ID,
      device_id: oldAndroid,
      platform: 'android',
      plugin_version: '6.0.0',
      os_version: '13',
      version_build: '1.0.0',
      version_name: '1.0.0',
      custom_id: '',
      is_prod: true,
      is_emulator: false,
      updated_at: new Date().toISOString(),
    },
    {
      app_id: APP_ID,
      device_id: newAndroid,
      platform: 'android',
      plugin_version: '6.0.0',
      os_version: '14.0.1',
      version_build: '1.0.0',
      version_name: '1.1.0',
      custom_id: '',
      is_prod: true,
      is_emulator: false,
      updated_at: new Date().toISOString(),
    },
    {
      app_id: APP_ID,
      device_id: iosDevice,
      platform: 'ios',
      plugin_version: '6.0.0',
      os_version: '17.4',
      version_build: '1.0.0',
      version_name: '1.1.0',
      custom_id: '',
      default_channel: 'beta',
      is_prod: true,
      is_emulator: false,
      updated_at: new Date().toISOString(),
    },
  ])
  expect(error).toBeNull()
}, 60_000)

afterAll(async () => {
  await resetAppData(APP_ID)
  await resetAppDataStats(APP_ID)
})

describe('[POST] /private/devices version compare', () => {
  it('counts android devices on OS 14 or newer and older bundles', async () => {
    const countResponse = await fetchTestRequest(getEndpointUrl('/private/devices'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        count: true,
        platform: 'android',
        osVersion: '14',
        osVersionOp: 'gte',
        versionNames: ['1.2.0'],
        versionNameOp: 'lt',
      }),
    })
    expect(countResponse.status).toBe(200)
    const countData = await countResponse.json() as { count: number }

    const listResponse = await fetchTestRequest(getEndpointUrl('/private/devices'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        platform: 'android',
        osVersion: '14',
        osVersionOp: 'gte',
        versionNames: ['1.2.0'],
        versionNameOp: 'lt',
        limit: 50,
      }),
    })
    expect(listResponse.status).toBe(200)
    const listData = await listResponse.json() as { data: { device_id: string }[] }
    const ids = listData.data.map(row => row.device_id)
    expect(ids).toContain(newAndroid)
    expect(ids).not.toContain(oldAndroid)
    expect(ids).not.toContain(iosDevice)
    expect(countData.count).toBe(ids.length)
  })

  it('filters devices by default channel', async () => {
    const countResponse = await fetchTestRequest(getEndpointUrl('/private/devices'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        count: true,
        defaultChannel: 'beta',
      }),
    })
    expect(countResponse.status).toBe(200)
    const countData = await countResponse.json() as { count: number }

    const listResponse = await fetchTestRequest(getEndpointUrl('/private/devices'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        defaultChannel: 'beta',
        limit: 50,
      }),
    })
    expect(listResponse.status).toBe(200)
    const listData = await listResponse.json() as { data: { device_id: string }[] }
    const ids = listData.data.map(row => row.device_id)
    expect(ids).toEqual([iosDevice])
    expect(countData.count).toBe(1)
  })

  it('exports matching devices as csv and json', async () => {
    const csvResponse = await fetchTestRequest(getEndpointUrl('/private/devices/export'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        format: 'csv',
        platform: 'android',
        osVersion: '14',
        osVersionOp: 'gte',
        limit: 10,
      }),
    })
    expect(csvResponse.status).toBe(200)
    const csvData = await csvResponse.json() as { format: string, csv: string, rowCount: number }
    expect(csvData.format).toBe('csv')
    expect(csvData.csv.startsWith('device_id,custom_id,platform,os_version,version_name')).toBe(true)
    expect(csvData.csv.endsWith('\n')).toBe(true)
    expect(csvData.csv).toContain(newAndroid)
    expect(csvData.csv).not.toContain(oldAndroid)
    expect(csvData.csv).not.toContain(iosDevice)

    const jsonResponse = await fetchTestRequest(getEndpointUrl('/private/devices/export'), {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: APP_ID,
        format: 'json',
        platform: 'android',
        osVersion: '14',
        osVersionOp: 'gte',
        limit: 10,
      }),
    })
    expect(jsonResponse.status).toBe(200)
    const jsonData = await jsonResponse.json() as { format: string, data: { device_id: string }[], rowCount: number }
    expect(jsonData.format).toBe('json')
    const exportedIds = jsonData.data.map(row => row.device_id)
    expect(exportedIds).toContain(newAndroid)
    expect(exportedIds).not.toContain(oldAndroid)
    expect(exportedIds).not.toContain(iosDevice)
  })
})

describe('[POST] /private/devices override filters', () => {
  let forcedChannelId = 0
  let emptyChannelId = 0

  beforeAll(async () => {
    const supabase = getSupabaseClient()
    const { data: channels, error } = await supabase
      .from('channels')
      .select('id, owner_org')
      .eq('app_id', APP_ID)
      .order('id')
      .limit(2)
    expect(error).toBeNull()
    expect(channels?.length).toBe(2)
    forcedChannelId = channels![0].id
    emptyChannelId = channels![1].id
    const { error: insertError } = await supabase.from('channel_devices').insert({
      app_id: APP_ID,
      channel_id: forcedChannelId,
      device_id: oldAndroid,
      owner_org: channels![0].owner_org,
    })
    expect(insertError).toBeNull()
  })

  async function post(path: string, body: Record<string, unknown>) {
    return fetchTestRequest(getEndpointUrl(path), { method: 'POST', headers, body: JSON.stringify({ appId: APP_ID, ...body }) })
  }

  it('resolves forced devices on the server for the app-wide override filter', async () => {
    const count = await post('/private/devices', { count: true, overrides: true })
    expect(count.status).toBe(200)
    expect((await count.json() as { count: number }).count).toBe(1)

    const list = await post('/private/devices', { overrides: true, limit: 10 })
    expect(list.status).toBe(200)
    const { data } = await list.json() as { data: { device_id: string }[] }
    expect(data.map(device => device.device_id)).toEqual([oldAndroid])
  })

  it('scopes overrides to one channel and never falls back to every device', async () => {
    const forced = await post('/private/devices', { count: true, overrideChannelId: forcedChannelId })
    expect((await forced.json() as { count: number }).count).toBe(1)

    const emptyCount = await post('/private/devices', { count: true, overrideChannelId: emptyChannelId })
    expect(emptyCount.status).toBe(200)
    expect((await emptyCount.json() as { count: number }).count).toBe(0)

    const emptyList = await post('/private/devices', { overrideChannelId: emptyChannelId, limit: 10 })
    expect((await emptyList.json() as { data: unknown[] }).data).toEqual([])

    const emptyExport = await post('/private/devices/export', { overrideChannelId: emptyChannelId, format: 'json' })
    expect(emptyExport.status).toBe(200)
    expect((await emptyExport.json() as { data: unknown[] }).data).toEqual([])
  })
})
