import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APP_NAME,
  createAppVersions,
  fetchTestRequest,
  getBaseData,
  getEndpointUrl,
  getSupabaseClient,
  getVersionFromAction,
  headers,
  PLUGIN_BASE_URL,
  resetAndSeedAppData,
  resetAndSeedAppDataStats,
  resetAppData,
  resetAppDataStats,
} from './test-utils.ts'

const id = randomUUID()
const APP_NAME_STATS_MODE = `${APP_NAME}.statsmode.${id}`
const USE_CLOUDFLARE = process.env.USE_CLOUDFLARE_WORKERS === 'true'
const describeBackend = describe.skipIf(USE_CLOUDFLARE)

interface StatsRes {
  status?: string
  error?: string
}

interface StatsPayload extends ReturnType<typeof getBaseData> {
  action: string
}

async function postStats(data: object) {
  return fetchTestRequest(`${PLUGIN_BASE_URL}/stats`, {
    method: 'POST',
    retryUnsafe: true,
    headers,
    body: JSON.stringify(data),
  })
}

beforeAll(async () => {
  if (USE_CLOUDFLARE)
    return
  await resetAndSeedAppData(APP_NAME_STATS_MODE)
  await resetAndSeedAppDataStats(APP_NAME_STATS_MODE)
})

afterAll(async () => {
  if (USE_CLOUDFLARE)
    return
  await resetAppData(APP_NAME_STATS_MODE)
  await resetAppDataStats(APP_NAME_STATS_MODE)
})

describeBackend('stats_mode app setting', () => {
  const supabase = getSupabaseClient()

  it('defaults new and existing apps to all', async () => {
    const { data, error } = await supabase
      .from('apps')
      .select('stats_mode')
      .eq('app_id', APP_NAME_STATS_MODE)
      .single()

    expect(error).toBeNull()
    expect(data?.stats_mode).toBe('all')
  })

  it('updates stats_mode via PUT /app', async () => {
    const response = await fetchTestRequest(`${getEndpointUrl('/app')}/${APP_NAME_STATS_MODE}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ stats_mode: 'billingOnly' }),
    })

    expect(response.status).toBe(200)
    const data = await response.json() as { stats_mode: string }
    expect(data.stats_mode).toBe('billingOnly')

    const { data: appData, error } = await supabase
      .from('apps')
      .select('stats_mode')
      .eq('app_id', APP_NAME_STATS_MODE)
      .single()

    expect(error).toBeNull()
    expect(appData?.stats_mode).toBe('billingOnly')

    await supabase.from('apps').update({ stats_mode: 'all' }).eq('app_id', APP_NAME_STATS_MODE)
  })

  it('rejects invalid stats_mode via PUT /app', async () => {
    const response = await fetchTestRequest(`${getEndpointUrl('/app')}/${APP_NAME_STATS_MODE}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ stats_mode: 'hipaa' }),
    })

    expect(response.status).toBe(400)
  })

  it('drops disallowed actions in billingOnly without persisting stats', async () => {
    await supabase.from('apps').update({ stats_mode: 'billingOnly' }).eq('app_id', APP_NAME_STATS_MODE)

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS_MODE) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'app_crash'
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS_MODE)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    const { count, error } = await supabase
      .from('stats')
      .select('*', { count: 'exact', head: true })
      .eq('app_id', APP_NAME_STATS_MODE)
      .eq('device_id', uuid)

    expect(error).toBeNull()
    expect(count).toBe(0)

    await supabase.from('apps').update({ stats_mode: 'all' }).eq('app_id', APP_NAME_STATS_MODE)
  })

  it('strips custom_id for billingOnly set events', async () => {
    await supabase.from('apps').update({ stats_mode: 'billingOnly' }).eq('app_id', APP_NAME_STATS_MODE)

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS_MODE) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.version_build = getVersionFromAction('set')
    baseData.custom_id = 'SHOULD-STRIP'
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS_MODE)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(200)

    const { data: deviceData, error: deviceError } = await supabase
      .from('devices')
      .select('custom_id')
      .eq('app_id', APP_NAME_STATS_MODE)
      .eq('device_id', uuid)
      .single()

    expect(deviceError).toBeNull()
    expect(deviceData?.custom_id).toBe('')

    await supabase.from('devices').delete().eq('app_id', APP_NAME_STATS_MODE).eq('device_id', uuid)
    await supabase.from('stats').delete().eq('app_id', APP_NAME_STATS_MODE).eq('device_id', uuid)
    await supabase.from('apps').update({ stats_mode: 'all' }).eq('app_id', APP_NAME_STATS_MODE)
  })

  it('drops non-update actions in updatesOnly mode', async () => {
    await supabase.from('apps').update({ stats_mode: 'updatesOnly' }).eq('app_id', APP_NAME_STATS_MODE)

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS_MODE) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'app_crash'
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS_MODE)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(200)

    const { count, error } = await supabase
      .from('stats')
      .select('*', { count: 'exact', head: true })
      .eq('app_id', APP_NAME_STATS_MODE)
      .eq('device_id', uuid)

    expect(error).toBeNull()
    expect(count).toBe(0)

    await supabase.from('apps').update({ stats_mode: 'all' }).eq('app_id', APP_NAME_STATS_MODE)
  })
})
