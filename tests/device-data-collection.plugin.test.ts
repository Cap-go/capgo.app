import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import type { DeviceDataCollection } from '../supabase/functions/_backend/utils/deviceDataCollection.ts'
import {
  APP_NAME,
  createAppVersions,
  drainUpdatesEdgeCachePurge,
  executeSQL,
  fetchTestRequest,
  getBaseData,
  getSupabaseClient,
  getVersionFromAction,
  headers,
  PLUGIN_BASE_URL,
  postUpdate,
  resetAndSeedAppData,
  resetAndSeedAppDataStats,
  resetAppData,
  resetAppDataStats,
  warmEdgeEndpoint,
} from './test-utils.ts'

const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'
const APP_ID = `com.test.ddc.${randomUUID().split('-')[0]}`

const ALL_COLLECTION_DISABLED: DeviceDataCollection = {
  country: false,
  platform: false,
  os_version: false,
  plugin_version: false,
  version_build: false,
  is_emulator: false,
  is_prod: false,
  install_source: false,
}

const updateNewScheme = z.object({
  url: z.string(),
  version: z.string(),
})

interface StatsRes {
  status?: string
}

async function postStats(data: object) {
  return fetchTestRequest(`${PLUGIN_BASE_URL}/stats`, {
    method: 'POST',
    retryUnsafe: true,
    headers,
    body: JSON.stringify(data),
  })
}

async function setDeviceDataCollection(appId: string, collection: DeviceDataCollection) {
  const { error } = await getSupabaseClient()
    .from('apps')
    .update({ device_data_collection: collection })
    .eq('app_id', appId)
  expect(error).toBeNull()

  const rows = await executeSQL<{ device_data_collection: DeviceDataCollection }>(
    'SELECT device_data_collection FROM public.apps WHERE app_id = $1',
    [appId],
  )
  expect(rows[0]?.device_data_collection).toEqual(collection)

  await drainUpdatesEdgeCachePurge()
}

describe('device_data_collection plugin integration', () => {
  beforeAll(async () => {
    await resetAndSeedAppData(APP_ID)
    await resetAndSeedAppDataStats(APP_ID)
    await setDeviceDataCollection(APP_ID, ALL_COLLECTION_DISABLED)

    await warmEdgeEndpoint(`${PLUGIN_BASE_URL}/stats`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...getBaseData(APP_ID),
        action: 'get',
        device_id: randomUUID().toLowerCase(),
      }),
    })
  })

  afterAll(async () => {
    await resetAppData(APP_ID)
    await resetAppDataStats(APP_ID)
  })

  it('POST /updates still routes on live request values when collection flags are off', async () => {
    const baseData = getBaseData(APP_ID)
    baseData.device_id = randomUUID().toLowerCase()
    baseData.version_name = '1.1.0'
    baseData.platform = 'ios'
    baseData.version_os = '18.0'
    baseData.plugin_version = '7.0.0'

    const response = await postUpdate(baseData)
    expect(response.status).toBe(200)

    const json = await response.json<{ error?: string, version?: string }>()
    expect(json.error).toBeUndefined()
    expect(() => parseSchema(updateNewScheme, json)).not.toThrow()
    expect(json.version).toBe('1.0.0')
  })

  describe.skipIf(USE_CLOUDFLARE)('primary database device writes', () => {
    it('POST /stats set omits disabled fields in devices row', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = {
        ...getBaseData(APP_ID),
        device_id: uuid,
        action: 'set' as const,
        platform: 'ios',
        version_os: '18.0',
        plugin_version: '8.1.0',
        is_emulator: true,
        is_prod: false,
        install_source: 'app_store',
        version_build: getVersionFromAction('set'),
      }

      const version = await createAppVersions(baseData.version_build, APP_ID)
      baseData.version_name = version.name

      const response = await postStats(baseData)
      expect(response.status).toBe(200)
      expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

      const { data: deviceData, error: deviceError } = await getSupabaseClient()
        .from('devices')
        .select('platform, country_code, os_version, plugin_version, version_build, is_emulator, is_prod, install_source')
        .eq('device_id', uuid)
        .eq('app_id', APP_ID)
        .single()

      expect(deviceError).toBeNull()
      expect(deviceData).toMatchObject({
        platform: null,
        country_code: null,
        os_version: null,
        plugin_version: '',
        version_build: '',
        is_emulator: null,
        is_prod: null,
        install_source: null,
      })

      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_ID)
    })
  })
})
