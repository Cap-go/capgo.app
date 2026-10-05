import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_DEVICE_DATA_COLLECTION } from '../supabase/functions/_backend/utils/deviceDataCollection.ts'
import {
  APP_NAME,
  createAppVersions,
  fetchTestRequest,
  getBaseData,
  getSupabaseClient,
  PLUGIN_BASE_URL,
  postUpdate,
  resetAndSeedAppData,
  resetAppData,
  resetAppDataStats,
} from './test-utils.ts'

const suffix = randomUUID().slice(0, 8)
const APP_ID = `${APP_NAME}.ddc.${suffix}`

const collectionOff = Object.fromEntries(
  Object.keys(DEFAULT_DEVICE_DATA_COLLECTION).map(key => [key, false]),
) as typeof DEFAULT_DEVICE_DATA_COLLECTION

describe('device data collection on plugin paths', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
    await getSupabaseClient()
      .from('apps')
      .update({ device_data_collection: collectionOff })
      .eq('app_id', APP_ID)
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
    await resetAppDataStats(APP_ID)
  })

  it('still routes /updates using request platform when platform storage is disabled', async () => {
    const version = await createAppVersions('1.0.1', APP_ID)
    const deviceId = randomUUID().toLowerCase()
    const base = getBaseData(APP_ID)
    base.device_id = deviceId
    base.platform = 'android'
    base.version_name = '1.0.0'
    base.version_build = '1.0.0'

    const response = await postUpdate(base)
    expect(response.status).toBe(200)
    const body = await response.json() as { version?: string, error?: string }
    expect(body.error).toBeUndefined()
    expect(body.version).toBe(version.name)
  })

  it('omits disabled device fields from Postgres after /stats set', async () => {
    const deviceId = randomUUID().toLowerCase()
    const version = await createAppVersions('2.0.0', APP_ID)
    const base = getBaseData(APP_ID)
    base.device_id = deviceId
    base.action = 'set'
    base.platform = 'ios'
    base.version_name = version.name
    base.version_build = '2.0.0'
    base.version_os = '17.0'
    base.plugin_version = '7.0.0'
    base.install_source = 'testflight'

    const response = await fetchTestRequest(`${PLUGIN_BASE_URL}/stats`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(base),
    })
    expect(response.status).toBe(200)

    const { error, data } = await getSupabaseClient()
      .from('devices')
      .select('platform, os_version, plugin_version, version_build, country_code, install_source, is_emulator, is_prod')
      .eq('app_id', APP_ID)
      .eq('device_id', deviceId)
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({
      platform: null,
      os_version: null,
      plugin_version: '',
      version_build: '',
      country_code: null,
      install_source: null,
      is_emulator: null,
      is_prod: null,
    })
  })
})
