import type { Database } from '../src/types/supabase.types.ts'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALLOWED_STATS_ACTIONS } from '../supabase/functions/_backend/plugin_runtime/plugins/stats_actions.ts'
import { APP_NAME, createAppVersions, getBaseData, getSupabaseClient, getVersionFromAction, headers, ORG_ID, PLUGIN_BASE_URL, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats, USER_ID } from './test-utils.ts'

const id = randomUUID()
const APP_NAME_STATS = `${APP_NAME}.${id}`

// Check if we're using Cloudflare Workers (which serializes some test paths)
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

interface StatsRes {
  error?: string
  message?: string
  status?: string
}

type StatsAction = Database['public']['Enums']['stats_action']

interface StatsPayload extends ReturnType<typeof getBaseData> {
  action: StatsAction
  install_source?: string
  metadata?: Record<string, string>
}

async function postStats(data: object) {
  const response = await fetch(`${PLUGIN_BASE_URL}/stats`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
  return response
}

async function expectNoPrimaryStatsRows(appId: string, deviceIds: string[]) {
  const { count: deviceCount, error: deviceError } = await getSupabaseClient()
    .from('devices')
    .select('*', { count: 'exact', head: true })
    .eq('app_id', appId)
    .in('device_id', deviceIds)
  expect(deviceError).toBeNull()
  expect(deviceCount).toBe(0)

  const { count: statsCount, error: statsError } = await getSupabaseClient()
    .from('stats')
    .select('*', { count: 'exact', head: true })
    .eq('app_id', appId)
    .in('device_id', deviceIds)
  expect(statsError).toBeNull()
  expect(statsCount).toBe(0)
}

describe.skipIf(!USE_CLOUDFLARE)('[POST] /stats Cloudflare write guard', () => {
  it('returns ok without primary device or stats writes', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })
    await expectNoPrimaryStatsRows(APP_NAME_STATS, [uuid])
  })

  it('returns batch ok without primary device or stats writes', async () => {
    const uuid1 = randomUUID().toLowerCase()
    const uuid2 = randomUUID().toLowerCase()
    const baseData1 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData1.device_id = uuid1
    baseData1.action = 'get'
    baseData1.version_build = getVersionFromAction('get')
    const version1 = await createAppVersions(baseData1.version_build, APP_NAME_STATS)
    baseData1.version_name = version1.name

    const baseData2 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData2.device_id = uuid2
    baseData2.action = 'set'
    baseData2.version_build = getVersionFromAction('set')
    const version2 = await createAppVersions(baseData2.version_build, APP_NAME_STATS)
    baseData2.version_name = version2.name

    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)
    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toHaveLength(2)
    expect(responseData.results![0].status).toBe('ok')
    expect(responseData.results![1].status).toBe('ok')
    await expectNoPrimaryStatsRows(APP_NAME_STATS, [uuid1, uuid2])
  })
})

beforeAll(async () => {
  await resetAndSeedAppData(APP_NAME_STATS)
  await resetAndSeedAppDataStats(APP_NAME_STATS)
})

afterAll(async () => {
  await resetAppData(APP_NAME_STATS)
  await resetAppDataStats(APP_NAME_STATS)
})

describe('stats Action Types', () => {
  it('test ALL_STATS_ACTIONS should contain all possible stats actions', () => {
    // Verify each action is unique
    const uniqueActions = new Set(ALLOWED_STATS_ACTIONS)
    expect(uniqueActions.size).toBe(ALLOWED_STATS_ACTIONS.length)

    // Verify version generation is unique and valid semver
    const versions = ALLOWED_STATS_ACTIONS.map(action => getVersionFromAction(action))
    const uniqueVersions = new Set(versions)
    expect(uniqueVersions.size).toBe(ALLOWED_STATS_ACTIONS.length)
    // Verify all versions match semver pattern
    expect(versions.every(_v => /^\d+\.\d+\.\d+(-[0-9A-Z-]+)?$/i)).toBe(true)
    type StatsActionEnum = Database['public']['Enums']['stats_action']
    const assertEqual = <T extends readonly StatsActionEnum[]>(value: T) => value
    assertEqual(ALLOWED_STATS_ACTIONS)
  })
})
describe.skipIf(USE_CLOUDFLARE)('test valid and invalid cases of version_build', () => {
  it('test valid and invalid cases of version_build', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'

    // Test valid version_build
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    let response = await postStats(baseData)
    if (response.status !== 200) {
      console.log('stats error', await response.text())
    }
    expect(response.status).toBe(200)
    let responseData = await response.json<StatsRes>()
    expect(responseData.status).toBe('ok')

    // Check version_build
    const { error: deviceError, data: deviceData } = await getSupabaseClient().from('devices').select().eq('device_id', uuid).eq('app_id', APP_NAME_STATS).single()
    expect(deviceError).toBeNull()
    expect(deviceData).toBeTruthy()
    expect(deviceData?.version_build).toBe(baseData.version_build)

    // Test invalid version_build
    baseData.version_build = 'invalid_version'

    //  count devices
    const deviceCountData = await getSupabaseClient()
      .from('devices')
      .select('*', { count: 'exact' })
      .eq('app_id', APP_NAME_STATS)
      .then((v) => {
        // console.log({ v })
        return v.count
      })
    baseData.device_id = randomUUID().toLowerCase()
    response = await postStats(baseData)
    expect(response.status).toBe(400)
    responseData = await response.json<StatsRes>()
    expect(responseData.error).toBe('semver_error')
    const deviceCountData2 = await getSupabaseClient()
      .from('devices')
      .select('*', { count: 'exact' })
      .eq('app_id', APP_NAME_STATS)
      .then((v) => {
        // console.log({ v })
        return v.count
      })
    expect(deviceCountData2).toBe(deviceCountData)

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })
})

describe.skipIf(USE_CLOUDFLARE)('[POST] /stats', () => {
  it('create new device and log stats action', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.install_source = 'app_store'
    baseData.version_build = getVersionFromAction('set')

    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name
    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    // Check device creation
    const { error: deviceError, data: deviceData } = await getSupabaseClient().from('devices').select().eq('device_id', uuid).eq('app_id', APP_NAME_STATS).single()
    expect(deviceError).toBeNull()
    expect(deviceData).toBeTruthy()
    expect(deviceData?.app_id).toBe(baseData.app_id)
    expect(deviceData?.version_name).toBe(version.name)
    expect(deviceData?.install_source).toBe('app_store')

    // Check stats log
    const { error: statsError, data: statsData } = await getSupabaseClient().from('stats').select().eq('device_id', uuid).eq('app_id', APP_NAME_STATS).single()
    expect(statsError).toBeNull()
    expect(statsData).toBeTruthy()
    expect(statsData?.action).toBe('set')
    expect(statsData?.device_id).toBe(uuid)

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  it('attributes version usage stats to the channel device override', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.stats.override.${shortId}`
    const deviceId = randomUUID().toLowerCase()
    const overrideChannelName = `beta-${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)
    const supabase = getSupabaseClient()

    try {
      const baseData = getBaseData(appId) as StatsPayload
      baseData.device_id = deviceId
      baseData.action = 'set'
      baseData.defaultChannel = 'production'
      baseData.channel = 'production'
      baseData.version_build = getVersionFromAction('set')
      const version = await createAppVersions(baseData.version_build, appId)
      baseData.version_name = version.name

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: appId,
          name: overrideChannelName,
          version: version.id,
          created_by: USER_ID,
          owner_org: ORG_ID,
        })
        .select('id')
        .single()
      expect(channelError).toBeNull()
      expect(channel).toBeTruthy()

      await supabase
        .from('channel_devices')
        .insert({
          app_id: appId,
          channel_id: channel!.id,
          device_id: deviceId,
          owner_org: ORG_ID,
        })
        .throwOnError()

      await supabase
        .from('apps')
        .update({ channel_device_count: 1 })
        .eq('app_id', appId)
        .throwOnError()

      const response = await postStats(baseData)
      expect(response.status).toBe(200)
      expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

      const { data: usage, error: usageError } = await supabase
        .from('version_usage')
        .select('channel_id, channel_name')
        .eq('app_id', appId)
        .eq('version_name', version.name)
        .eq('action', 'install')
        .single()

      expect(usageError).toBeNull()
      expect(usage?.channel_id).toBe(channel!.id)
      expect(usage?.channel_name).toBe(overrideChannelName)
    }
    finally {
      await resetAppData(appId)
      await resetAppDataStats(appId)
    }
  })

  it('does not trust client-supplied channel for version usage stats', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.stats.spoof.${shortId}`
    const deviceId = randomUUID().toLowerCase()
    const spoofedChannelName = `private-${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)
    const supabase = getSupabaseClient()

    try {
      const baseData = getBaseData(appId) as StatsPayload
      baseData.device_id = deviceId
      baseData.action = 'set'
      delete baseData.defaultChannel
      baseData.channel = spoofedChannelName
      baseData.version_build = getVersionFromAction('set')
      const version = await createAppVersions(baseData.version_build, appId)
      baseData.version_name = version.name

      const { error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: appId,
          name: spoofedChannelName,
          version: version.id,
          created_by: USER_ID,
          owner_org: ORG_ID,
        })
      expect(channelError).toBeNull()

      const response = await postStats(baseData)
      expect(response.status).toBe(200)
      expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

      const { data: usage, error: usageError } = await supabase
        .from('version_usage')
        .select('channel_name')
        .eq('app_id', appId)
        .eq('version_name', version.name)
        .eq('action', 'install')
        .single()

      expect(usageError).toBeNull()
      expect(usage?.channel_name).toBe('production')
      expect(usage?.channel_name).not.toBe(spoofedChannelName)
    }
    finally {
      await resetAppData(appId)
      await resetAppDataStats(appId)
    }
  })

  it('stores metadata for app and WebView health stats', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'webview_javascript_error'
    baseData.version_build = getVersionFromAction('webview_javascript_error')
    baseData.metadata = {
      error_type: 'javascript_error',
      message: 'boom',
      href: 'capacitor://localhost/index.html',
    }

    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name
    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    const { error: statsError, data: statsData } = await getSupabaseClient()
      .from('stats')
      .select('action, metadata')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(statsError).toBeNull()
    expect(statsData?.action).toBe('webview_javascript_error')
    expect(statsData?.metadata).toEqual(baseData.metadata)

    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  it.concurrent('does not recreate unknown placeholder rows for missing versions', async () => {
    const uuid = randomUUID().toLowerCase()
    const appId = `${APP_NAME}.deleted.unknown.${randomUUID().split('-')[0]}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)

    try {
      const baseData = getBaseData(appId) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'set'
      baseData.version_build = '1.0.0-missing.1'
      baseData.version_name = '1.0.0-missing.1'

      const response = await postStats(baseData)
      expect(response.status).toBe(200)
      expect(await response.json<StatsRes>()).toMatchObject({ error: 'version_not_found' })

      const { count, error } = await getSupabaseClient()
        .from('app_versions')
        .select('id', { count: 'exact', head: true })
        .eq('app_id', appId)
        .eq('name', 'unknown')

      expect(error).toBeNull()
      expect(count).toBe(0)
    }
    finally {
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', appId)
      await resetAppData(appId)
      await resetAppDataStats(appId)
    }
  })

  it('should ignore custom_id when app disables allow_device_custom_id and emit customIdBlocked stat', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.cidb.${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)

    // Disable device-supplied custom_id persistence for this app
    const { error: appUpdateError } = await getSupabaseClient()
      .from('apps')
      .update({ allow_device_custom_id: false })
      .eq('app_id', appId)
    expect(appUpdateError).toBeNull()

    const { error: appReadError, data: appData } = await getSupabaseClient()
      .from('apps')
      .select('allow_device_custom_id')
      .eq('app_id', appId)
      .single()
    expect(appReadError).toBeNull()
    expect(appData?.allow_device_custom_id).toBe(false)

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(appId) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.version_build = getVersionFromAction('set')

    const version = await createAppVersions(baseData.version_build, appId)
    baseData.version_name = version.name
    baseData.custom_id = 'POISON-TEST'

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    // Verify device exists but custom_id was not persisted (DB default is empty string)
    const { error: deviceError, data: deviceData } = await getSupabaseClient()
      .from('devices')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', appId)
      .single()

    expect(deviceError).toBeNull()
    expect(deviceData).toBeTruthy()
    expect(deviceData?.custom_id).toBe('')

    // Verify server-side stat was emitted
    const { error: blockedError, data: blockedStat } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', appId)
      .eq('action', 'customIdBlocked')
      .single()

    expect(blockedError).toBeNull()
    expect(blockedStat).toBeTruthy()

    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  it('should trim custom_id before persisting', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.cidt.${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(appId) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.version_build = getVersionFromAction('set')

    const version = await createAppVersions(baseData.version_build, appId)
    baseData.version_name = version.name
    baseData.custom_id = '  TRIM-ME  '

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    const { error: deviceError, data: deviceData } = await getSupabaseClient()
      .from('devices')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', appId)
      .single()

    expect(deviceError).toBeNull()
    expect(deviceData?.custom_id).toBe('TRIM-ME')

    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  it('should block trimmed custom_id when app disables allow_device_custom_id', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.cidt2.${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)

    const { error: appUpdateError } = await getSupabaseClient()
      .from('apps')
      .update({ allow_device_custom_id: false })
      .eq('app_id', appId)
    expect(appUpdateError).toBeNull()

    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(appId) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'set'
    baseData.version_build = getVersionFromAction('set')

    const version = await createAppVersions(baseData.version_build, appId)
    baseData.version_name = version.name
    baseData.custom_id = '  BLOCK-ME  '

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

    const { error: deviceError, data: deviceData } = await getSupabaseClient()
      .from('devices')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', appId)
      .single()

    expect(deviceError).toBeNull()
    expect(deviceData?.custom_id).toBe('')

    const { error: blockedError, data: blockedStat } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', appId)
      .eq('action', 'customIdBlocked')
      .single()

    expect(blockedError).toBeNull()
    expect(blockedStat).toBeTruthy()

    await resetAppData(appId)
    await resetAppDataStats(appId)
  })

  // Concurrent action matrix only: each case gets an isolated app so parallel
  // creates cannot race shared APP_NAME_STATS into intermittent PGRST116 misses.
  // Do not reuse actionIt for tests that still mutate APP_NAME_STATS.
  const actionDescribe = USE_CLOUDFLARE ? describe : describe.concurrent
  const actionIt = USE_CLOUDFLARE ? it : it.concurrent

  actionDescribe('test all possible stats actions', () => {
    for (const [actionIndex, action] of ALLOWED_STATS_ACTIONS.entries()) {
      actionIt(`should handle ${action} action`, async () => {
        // Keep app_id <= varchar(50): action names are too long to embed.
        const appId = `${APP_NAME}.sa.${actionIndex}.${randomUUID().slice(0, 8)}`
        await resetAndSeedAppData(appId)
        await resetAndSeedAppDataStats(appId)
        try {
          const uuid = randomUUID().toLowerCase()
          const baseData = getBaseData(appId) as StatsPayload
          baseData.device_id = uuid
          baseData.action = action
          if (action === 'download_fail')
            baseData.plugin_version = '7.17.0'
          baseData.version_build = getVersionFromAction(action)

          const version = await createAppVersions(baseData.version_build, appId)
          baseData.version_name = version.name
          baseData.version_code = '2'
          baseData.version_os = '16.1'
          baseData.custom_id = 'test2'

          const response = await postStats(baseData)
          const responseData = await response.json<StatsRes>()
          expect(response.status).toBe(200)
          expect(responseData.status).toBe('ok')

          // Verify stats entry
          const { error: statsError, data: statsData } = await getSupabaseClient()
            .from('stats')
            .select()
            .eq('device_id', uuid)
            .eq('app_id', appId)
            .eq('action', action)
            .single()

          expect(statsError).toBeNull()
          expect(statsData).toBeTruthy()
          expect(statsData?.action).toBe(action)
          expect(statsData?.device_id).toBe(uuid)

          // Verify device state - fail actions should NOT create/update device records
          // because the version_name in fail requests is the failed version, not the actual running version
          if (!action.endsWith('_fail')) {
            const { error: deviceError, data: deviceData } = await getSupabaseClient()
              .from('devices')
              .select()
              .eq('device_id', uuid)
              .eq('app_id', appId)
              .single()

            expect(deviceError).toBeNull()
            expect(deviceData).toBeTruthy()
            expect(deviceData?.version_build).toBe(baseData.version_build)
            expect(deviceData?.version_name).toBe(version.name)
            expect(deviceData?.os_version).toBe('16.1')
            expect(deviceData?.plugin_version).toBe('7.0.0')
            expect(deviceData?.custom_id).toBe('test2')
          }
        }
        finally {
          await resetAppData(appId)
          await resetAppDataStats(appId)
        }
      })
    }
  })

  it('filters legacy download_fail before saved stats and logs', async () => {
    const cases = [
      { pluginVersion: '7.16.9', shouldRecord: false, createVersion: true },
      { pluginVersion: '7.16.9', shouldRecord: false, createVersion: false },
      { pluginVersion: '7.17.0', shouldRecord: true, createVersion: true },
      { pluginVersion: '6.14.24', shouldRecord: false, createVersion: true },
      { pluginVersion: '6.14.25', shouldRecord: true, createVersion: true },
      { pluginVersion: 'not-a-version', shouldRecord: false, createVersion: true },
    ]

    for (const [caseIndex, testCase] of cases.entries()) {
      const uuid = randomUUID().toLowerCase()
      const caseId = randomUUID().slice(0, 8)
      const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_fail'
      baseData.plugin_version = testCase.pluginVersion
      baseData.version_build = `1.0.0-download-fail-${caseIndex}-${caseId}-${testCase.pluginVersion.replace(/\./g, '-')}-${testCase.createVersion ? 'existing' : 'missing'}`
      const versionName = testCase.createVersion
        ? (await createAppVersions(baseData.version_build, APP_NAME_STATS)).name
        : baseData.version_build
      baseData.version_name = versionName

      const response = await postStats(baseData)
      const responseData = await response.json<StatsRes>()
      expect(response.status).toBe(200)
      expect(responseData.status).toBe('ok')

      const { error: statsError, count: statsCount } = await getSupabaseClient()
        .from('stats')
        .select('*', { count: 'exact', head: true })
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_STATS)
        .eq('action', 'download_fail')

      expect(statsError).toBeNull()
      expect(statsCount).toBe(testCase.shouldRecord ? 1 : 0)

      const { error: versionUsageError, count: versionUsageCount } = await getSupabaseClient()
        .from('version_usage')
        .select('*', { count: 'exact', head: true })
        .eq('app_id', APP_NAME_STATS)
        .eq('version_name', versionName)
        .eq('action', 'fail')

      expect(versionUsageError).toBeNull()
      expect(versionUsageCount).toBe(testCase.shouldRecord ? 1 : 0)
    }
  })

  it('app that does not exist', async () => {
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.app_id = 'does.not.exist'
    baseData.action = 'get'
    baseData.version_build = getVersionFromAction('get')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(429)
    const json = await response.json<StatsRes>()
    // console.log({ json })
    expect(json.error).toBe('on_premise_app')
  })

  it('invalid action should fail', async () => {
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.action = 'invalid_action' as StatsAction
    baseData.version_build = getVersionFromAction('invalid_action')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(400)
    const json = await response.json<StatsRes>()
    expect(json.error).toBeTruthy()
  })

  it('saves default_channel when provided', async () => {
    const uuid = randomUUID().toLowerCase()
    const testDefaultChannel = 'dev'

    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.action = 'set'
    baseData.device_id = uuid
    baseData.defaultChannel = testDefaultChannel
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    const response = await postStats(baseData)
    expect(response.status).toBe(200)

    // Wait for data to be written

    // Verify default_channel was saved
    const { error, data } = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(error).toBeNull()
    expect(data).toBeTruthy()
    expect(data?.default_channel).toBe(testDefaultChannel)

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  it('updates default_channel when changed', async () => {
    const uuid = randomUUID().toLowerCase()
    const initialChannel = 'staging'
    const updatedChannel = 'production'

    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.action = 'set'
    baseData.device_id = uuid
    baseData.defaultChannel = initialChannel
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    // First request with initial channel
    let response = await postStats(baseData)
    expect(response.status).toBe(200)

    // Verify initial channel was saved
    let result = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(result.error).toBeNull()
    expect(result.data?.default_channel).toBe(initialChannel)

    // Second request with updated channel
    baseData.defaultChannel = updatedChannel
    response = await postStats(baseData)
    expect(response.status).toBe(200)

    // Verify channel was updated
    result = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(result.error).toBeNull()
    expect(result.data?.default_channel).toBe(updatedChannel)

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  it('unsets default_channel when not provided', async () => {
    const uuid = randomUUID().toLowerCase()
    const initialChannel = 'beta'

    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.action = 'set'
    baseData.device_id = uuid
    baseData.defaultChannel = initialChannel
    baseData.version_build = getVersionFromAction('set')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    // First request with channel set
    let response = await postStats(baseData)
    expect(response.status).toBe(200)

    // Verify channel was saved
    let result = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(result.error).toBeNull()
    expect(result.data?.default_channel).toBe(initialChannel)

    // Second request without defaultChannel (undefined)
    delete baseData.defaultChannel
    response = await postStats(baseData)
    expect(response.status).toBe(200)

    // Verify channel was unset (should be null)
    result = await getSupabaseClient()
      .from('devices')
      .select('default_channel')
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .single()

    expect(result.error).toBeNull()
    expect(result.data?.default_channel).toBeNull()

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })
})

describe('rollout trigger metadata', () => {
  it.skipIf(USE_CLOUDFLARE)('records version usage failures only for production devices', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.rollout.failcohort.${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)
    const supabase = getSupabaseClient()

    try {
      const version = await createAppVersions(`1.0.0-failcohort-${shortId}.1`, appId)
      const cases = [
        { deviceId: randomUUID().toLowerCase(), isEmulator: true, isProd: true },
        { deviceId: randomUUID().toLowerCase(), isEmulator: false, isProd: false },
        { deviceId: randomUUID().toLowerCase(), isEmulator: false, isProd: true },
      ]

      for (const item of cases) {
        const baseData = getBaseData(appId) as StatsPayload
        baseData.action = 'update_fail'
        baseData.device_id = item.deviceId
        baseData.version_build = version.name
        baseData.version_name = version.name
        baseData.is_emulator = item.isEmulator
        baseData.is_prod = item.isProd

        const response = await postStats(baseData)
        const responseData = await response.json<StatsRes>()
        expect(response.status, JSON.stringify(responseData)).toBe(200)
        expect(responseData).toEqual({ status: 'ok' })
      }

      const { data, error } = await supabase
        .from('version_usage')
        .select('action')
        .eq('app_id', appId)
        .eq('version_name', version.name)
        .eq('action', 'fail')

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    }
    finally {
      await resetAppData(appId)
      await resetAppDataStats(appId)
    }
  })
  it('preserves explicit auto-pause rollback metadata when clearing rollout version', async () => {
    const shortId = randomUUID().split('-')[0]
    const appId = `${APP_NAME}.rollout.trigger.${shortId}`
    await resetAndSeedAppData(appId)
    await resetAndSeedAppDataStats(appId)
    const supabase = getSupabaseClient()

    try {
      const stableVersion = await createAppVersions(`1.0.0-stable-${shortId}.1`, appId)
      const rolloutVersion = await createAppVersions(`1.0.0-rollout-${shortId}.1`, appId)

      const { data: channel, error: channelError } = await supabase
        .from('channels')
        .insert({
          app_id: appId,
          name: `production-${shortId}`,
          version: stableVersion.id,
          rollout_version: rolloutVersion.id,
          rollout_enabled: true,
          rollout_percentage_bps: 5000,
          created_by: USER_ID,
          owner_org: ORG_ID,
        })
        .select('id')
        .single()
      expect(channelError).toBeNull()
      expect(channel).toBeTruthy()

      const triggeredAt = new Date().toISOString()
      const reason = `Auto-pause rollback test ${shortId}`
      await supabase
        .from('channels')
        .update({
          rollout_version: null,
          rollout_enabled: false,
          rollout_percentage_bps: 0,
          rollout_paused_at: null,
          rollout_pause_reason: reason,
          auto_pause_last_triggered_at: triggeredAt,
        })
        .eq('id', channel!.id)
        .throwOnError()

      const { data: updatedChannel, error: updatedError } = await supabase
        .from('channels')
        .select('rollout_version, rollout_paused_at, rollout_pause_reason, auto_pause_last_triggered_at')
        .eq('id', channel!.id)
        .single()

      expect(updatedError).toBeNull()
      expect(updatedChannel?.rollout_version).toBeNull()
      expect(updatedChannel?.rollout_paused_at).toBeNull()
      expect(updatedChannel?.rollout_pause_reason).toBe(reason)
      expect(new Date(updatedChannel!.auto_pause_last_triggered_at!).toISOString()).toBe(triggeredAt)
    }
    finally {
      await resetAppData(appId)
      await resetAppDataStats(appId)
    }
  })
})

interface BatchStatsRes {
  status: string
  results?: Array<{
    status: 'ok' | 'error'
    error?: string
    message?: string
    index?: number
  }>
}

// Test batch operations - concurrent for Supabase, sequential for Cloudflare
const batchTestDescribe = USE_CLOUDFLARE ? describe.skip : describe.concurrent
const batchTestIt = USE_CLOUDFLARE ? it : it.concurrent

batchTestDescribe('[POST] /stats batch operations', () => {
  batchTestIt('should handle batch of events', async () => {
    const uuid1 = randomUUID().toLowerCase()
    const uuid2 = randomUUID().toLowerCase()

    const baseData1 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData1.device_id = uuid1
    baseData1.action = 'get'
    baseData1.version_build = getVersionFromAction('get')
    const version1 = await createAppVersions(baseData1.version_build, APP_NAME_STATS)
    baseData1.version_name = version1.name

    const baseData2 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData2.device_id = uuid2
    baseData2.action = 'set'
    baseData2.version_build = getVersionFromAction('set')
    const version2 = await createAppVersions(baseData2.version_build, APP_NAME_STATS)
    baseData2.version_name = version2.name

    // Send batch request
    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)

    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toBeDefined()
    expect(responseData.results).toHaveLength(2)
    expect(responseData.results![0].status).toBe('ok')
    expect(responseData.results![0].index).toBe(0)
    expect(responseData.results![1].status).toBe('ok')
    expect(responseData.results![1].index).toBe(1)

    // Verify both stats entries were created
    const { error: statsError1, data: statsData1 } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid1)
      .eq('app_id', APP_NAME_STATS)
      .eq('action', 'get')
      .single()
    expect(statsError1).toBeNull()
    expect(statsData1).toBeTruthy()

    const { error: statsError2, data: statsData2 } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid2)
      .eq('app_id', APP_NAME_STATS)
      .eq('action', 'set')
      .single()
    expect(statsError2).toBeNull()
    expect(statsData2).toBeTruthy()

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid1).eq('app_id', APP_NAME_STATS)
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid2).eq('app_id', APP_NAME_STATS)
  })

  batchTestIt('should handle batch with partial failures', async () => {
    const uuid1 = randomUUID().toLowerCase()
    const uuid2 = randomUUID().toLowerCase()

    const baseData1 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData1.device_id = uuid1
    baseData1.action = 'get'
    baseData1.version_build = getVersionFromAction('get')
    const version1 = await createAppVersions(baseData1.version_build, APP_NAME_STATS)
    baseData1.version_name = version1.name

    // Second event has invalid action
    const baseData2 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData2.device_id = uuid2
    baseData2.action = 'invalid_action_xyz' as StatsAction
    baseData2.version_build = getVersionFromAction('set')

    // Send batch request
    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)

    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toBeDefined()
    expect(responseData.results).toHaveLength(2)

    // First event should succeed
    expect(responseData.results![0].status).toBe('ok')
    expect(responseData.results![0].index).toBe(0)

    // Second event should fail
    expect(responseData.results![1].status).toBe('error')
    expect(responseData.results![1].index).toBe(1)
    expect(responseData.results![1].error).toBeTruthy()

    // Verify first stats entry was created
    const { error: statsError1, data: statsData1 } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid1)
      .eq('app_id', APP_NAME_STATS)
      .eq('action', 'get')
      .single()
    expect(statsError1).toBeNull()
    expect(statsData1).toBeTruthy()

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid1).eq('app_id', APP_NAME_STATS)
  })

  batchTestIt('should handle empty batch', async () => {
    const response = await postStats([])
    expect(response.status).toBe(200)

    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toBeDefined()
    expect(responseData.results).toHaveLength(0)
  })

  batchTestIt('single event should still return simple response for backward compatibility', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'get'
    baseData.version_build = getVersionFromAction('get')
    const version = await createAppVersions(baseData.version_build, APP_NAME_STATS)
    baseData.version_name = version.name

    // Send single event (not in array)
    const response = await postStats(baseData)
    expect(response.status).toBe(200)

    const responseData = await response.json<StatsRes>()
    // Should return simple { status: 'ok' } not batch format
    expect(responseData.status).toBe('ok')
    expect((responseData as BatchStatsRes).results).toBeUndefined()

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  batchTestIt('should handle batch with same device multiple actions', async () => {
    const uuid = randomUUID().toLowerCase()

    const baseData1 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData1.device_id = uuid
    baseData1.action = 'get'
    baseData1.version_build = getVersionFromAction('get')
    const version1 = await createAppVersions(baseData1.version_build, APP_NAME_STATS)
    baseData1.version_name = version1.name

    const baseData2 = { ...baseData1 }
    baseData2.action = 'set'
    baseData2.version_build = getVersionFromAction('set')
    const version2 = await createAppVersions(baseData2.version_build, APP_NAME_STATS)
    baseData2.version_name = version2.name

    // Send batch with same device, different actions
    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)

    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toHaveLength(2)
    expect(responseData.results![0].status).toBe('ok')
    expect(responseData.results![1].status).toBe('ok')

    // Verify both stats entries were created
    const { error: statsError, data: statsData } = await getSupabaseClient()
      .from('stats')
      .select()
      .eq('device_id', uuid)
      .eq('app_id', APP_NAME_STATS)
      .order('created_at', { ascending: true })
    expect(statsError).toBeNull()
    expect(statsData).toBeTruthy()
    expect(statsData).toHaveLength(2)
    expect(statsData![0].action).toBe('get')
    expect(statsData![1].action).toBe('set')

    // Clean up
    await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_STATS)
  })

  batchTestIt('should reject batch with mixed app_ids', async () => {
    const uuid1 = randomUUID().toLowerCase()
    const uuid2 = randomUUID().toLowerCase()

    const baseData1 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData1.device_id = uuid1
    baseData1.action = 'get'
    baseData1.version_build = getVersionFromAction('get')
    const version1 = await createAppVersions(baseData1.version_build, APP_NAME_STATS)
    baseData1.version_name = version1.name

    // Second event has different app_id
    const baseData2 = getBaseData(APP_NAME_STATS) as StatsPayload
    baseData2.device_id = uuid2
    baseData2.app_id = 'com.different.app'
    baseData2.action = 'get'
    baseData2.version_build = getVersionFromAction('get')
    baseData2.version_name = version1.name

    // Send batch request with mixed app_ids
    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)

    const responseData = await response.json<StatsRes>()
    expect(responseData.error).toBe('mixed_app_ids')
    expect(responseData.message).toBe('All events in a batch must have the same app_id')
  })

  batchTestIt('should return on_premise_app error for batch with non-existent app', async () => {
    const uuid1 = randomUUID().toLowerCase()
    const uuid2 = randomUUID().toLowerCase()

    // Use app_id that doesn't exist in the system (triggers onprem detection)
    const baseData1: StatsPayload = {
      app_id: 'does.not.exist',
      device_id: uuid1,
      platform: 'ios',
      version_name: '1.0.0',
      version_os: '14.0',
      is_emulator: false,
      is_prod: true,
      action: 'get',
      version_build: '1.0.0',
      plugin_version: '7.0.0',
    }

    const baseData2: StatsPayload = {
      ...baseData1,
      device_id: uuid2,
    }

    // Send batch request with non-existent app
    const response = await postStats([baseData1, baseData2])
    expect(response.status).toBe(200)

    const responseData = await response.json<BatchStatsRes>()
    expect(responseData.status).toBe('ok')
    expect(responseData.results).toBeDefined()
    expect(responseData.results).toHaveLength(2)

    // Both events should return on_premise_app error
    expect(responseData.results![0].status).toBe('error')
    expect(responseData.results![0].error).toBe('on_premise_app')
    expect(responseData.results![1].status).toBe('error')
    expect(responseData.results![1].error).toBe('on_premise_app')
  })
})
