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
