import type { Database } from '../src/types/supabase.types.ts'
import { randomUUID } from 'node:crypto'
import { env } from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALLOWED_STATS_ACTIONS } from '../supabase/functions/_backend/plugin_runtime/plugins/stats_actions.ts'
import { createAppVersions, fetchTestRequest, getBaseData, getSupabaseClient, getVersionFromAction, headers, PLUGIN_BASE_URL, resetAndSeedAppData, resetAndSeedAppDataStats, resetAppData, resetAppDataStats } from './test-utils.ts'

const id = randomUUID().substring(0, 8)
const APP_NAME_DOWNLOAD_STATS = `com.download.${id}`
// Skip tests that expect primary database writes when running under Cloudflare Workers.
const USE_CLOUDFLARE = env.USE_CLOUDFLARE_WORKERS === 'true'

interface StatsRes {
  error?: string
  message?: string
  status?: string
}

type StatsAction = Database['public']['Enums']['stats_action']

interface StatsPayload extends ReturnType<typeof getBaseData> {
  action: StatsAction
}

async function postStats(data: object) {
  const response = await fetchTestRequest(`${PLUGIN_BASE_URL}/stats`, {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
  })
  return response
}

async function expectNoPrimaryDownloadStatsRows(deviceId: string) {
  const { count: deviceCount, error: deviceError } = await getSupabaseClient()
    .from('devices')
    .select('*', { count: 'exact', head: true })
    .eq('app_id', APP_NAME_DOWNLOAD_STATS)
    .eq('device_id', deviceId)
  expect(deviceError).toBeNull()
  expect(deviceCount).toBe(0)

  const { count: statsCount, error: statsError } = await getSupabaseClient()
    .from('stats')
    .select('*', { count: 'exact', head: true })
    .eq('app_id', APP_NAME_DOWNLOAD_STATS)
    .eq('device_id', deviceId)
  expect(statsError).toBeNull()
  expect(statsCount).toBe(0)
}

describe.skipIf(!USE_CLOUDFLARE)('download Stats Actions Cloudflare write guard', () => {
  it('accepts composite download stats without primary device or stats writes', async () => {
    const uuid = randomUUID().toLowerCase()
    const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
    baseData.device_id = uuid
    baseData.action = 'download_manifest_file_fail'
    baseData.version_build = getVersionFromAction('download_manifest_file_fail')
    const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
    baseData.version_name = `${version.name}:main.js`

    const response = await postStats(baseData)
    expect(response.status).toBe(200)
    expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })
    await expectNoPrimaryDownloadStatsRows(uuid)
  })
})

beforeAll(async () => {
  await resetAndSeedAppData(APP_NAME_DOWNLOAD_STATS)
  await resetAndSeedAppDataStats(APP_NAME_DOWNLOAD_STATS)
})

afterAll(async () => {
  await resetAppData(APP_NAME_DOWNLOAD_STATS)
  await resetAppDataStats(APP_NAME_DOWNLOAD_STATS)
})

describe.skipIf(USE_CLOUDFLARE)('download Stats Actions', () => {
  it('should verify test app is created properly', async () => {
    const supabase = getSupabaseClient()
    const { data, error } = await supabase
      .from('apps')
      .select('app_id, owner_org')
      .eq('app_id', APP_NAME_DOWNLOAD_STATS)
      .single()

    console.log('Test app check:', { app_id: APP_NAME_DOWNLOAD_STATS, data, error })
    expect(error).toBeNull()
    expect(data).toBeTruthy()
  })

  it('should verify all download stats actions are in ALLOWED_STATS_ACTIONS', () => {
    const downloadActions = [
      'download_manifest_start',
      'download_manifest_complete',
      'download_zip_start',
      'download_zip_complete',
      'download_manifest_file_fail',
      'download_manifest_checksum_fail',
      'download_manifest_brotli_fail',
    ]

    for (const action of downloadActions) {
      expect(ALLOWED_STATS_ACTIONS).toContain(action)
    }
  })

  describe('success Download Stats', () => {
    const successActions: StatsAction[] = [
      'download_manifest_start',
      'download_manifest_complete',
      'download_zip_start',
      'download_zip_complete',
    ]

    for (const action of successActions) {
      it(`should log ${action} with regular version format`, async () => {
        const uuid = randomUUID().toLowerCase()
        const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
        baseData.device_id = uuid
        baseData.action = action
        baseData.version_build = getVersionFromAction(action)

        const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
        baseData.version_name = version.name

        const response = await postStats(baseData)
        if (response.status !== 200) {
          const errorBody = await response.json()
          console.error(`Error for action ${action}:`, errorBody)
        }
        expect(response.status).toBe(200)
        expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

        // Verify stats entry
        const { error: statsError, data: statsData } = await getSupabaseClient()
          .from('stats')
          .select()
          .eq('device_id', uuid)
          .eq('app_id', APP_NAME_DOWNLOAD_STATS)
          .eq('action', action)
          .single()

        expect(statsError).toBeNull()
        expect(statsData).toBeTruthy()
        expect(statsData?.action).toBe(action)
        expect(statsData?.device_id).toBe(uuid)
        expect(statsData?.version_name).toBe(version.name)
        // Regular format: no colon in version_name
        expect(statsData?.version_name).not.toContain(':')

        // Clean up
        await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
        await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      })
    }

    it('should handle complete download flow (start -> complete)', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.version_build = '1.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
      baseData.version_name = version.name

      // Log start
      baseData.action = 'download_manifest_start'
      let response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Log complete
      baseData.action = 'download_manifest_complete'
      response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Verify both stats entries exist
      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .in('action', ['download_manifest_start', 'download_manifest_complete'])

      expect(error).toBeNull()
      expect(statsData).toBeTruthy()
      expect(statsData?.length).toBe(2)

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })
  })

  describe('failure Download Stats with Composite Format', () => {
    const failureActions: StatsAction[] = [
      'download_manifest_file_fail',
      'download_manifest_checksum_fail',
      'download_manifest_brotli_fail',
    ]

    for (const action of failureActions) {
      it(`should log ${action} with composite version:filename format`, async () => {
        const uuid = randomUUID().toLowerCase()
        const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
        baseData.device_id = uuid
        baseData.action = action
        baseData.version_build = getVersionFromAction(action)

        const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
        // Use composite format: version:filename
        const filename = 'main.js'
        baseData.version_name = `${version.name}:${filename}`

        const response = await postStats(baseData)
        expect(response.status).toBe(200)
        expect(await response.json<StatsRes>()).toEqual({ status: 'ok' })

        // Verify stats entry
        const { error: statsError, data: statsData } = await getSupabaseClient()
          .from('stats')
          .select()
          .eq('device_id', uuid)
          .eq('app_id', APP_NAME_DOWNLOAD_STATS)
          .eq('action', action)
          .single()

        expect(statsError).toBeNull()
        expect(statsData).toBeTruthy()
        expect(statsData?.action).toBe(action)
        expect(statsData?.device_id).toBe(uuid)
        // Composite format: version:filename
        expect(statsData?.version_name).toBe(`${version.name}:${filename}`)
        expect(statsData?.version_name).toContain(':')

        // Clean up
        await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
        await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      })
    }

    it('should handle various file paths in composite format', async () => {
      const testCases = [
        { filename: 'main.js', description: 'simple filename' },
        { filename: 'assets/logo.png', description: 'nested path' },
        { filename: 'dist/bundle.min.js', description: 'nested with extension' },
        { filename: 'components/Header/index.tsx', description: 'deeply nested' },
      ]

      for (const testCase of testCases) {
        const uuid = randomUUID().toLowerCase()
        const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
        baseData.device_id = uuid
        baseData.action = 'download_manifest_file_fail'
        baseData.version_build = '2.0.0'

        const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
        baseData.version_name = `${version.name}:${testCase.filename}`

        const response = await postStats(baseData)
        expect(response.status).toBe(200)

        // Verify stats entry
        const { error, data: statsData } = await getSupabaseClient()
          .from('stats')
          .select()
          .eq('device_id', uuid)
          .eq('app_id', APP_NAME_DOWNLOAD_STATS)
          .single()

        expect(error).toBeNull()
        expect(statsData?.version_name).toBe(`${version.name}:${testCase.filename}`)

        // Clean up
        await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
        await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      }
    })

    it('should store multiple failures for different files of same version', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_manifest_file_fail'
      baseData.version_build = '3.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)

      const files = ['main.js', 'vendor.js', 'styles.css']

      for (const file of files) {
        baseData.version_name = `${version.name}:${file}`
        const response = await postStats(baseData)
        expect(response.status).toBe(200)
      }

      // Verify all stats entries
      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .eq('action', 'download_manifest_file_fail')

      expect(error).toBeNull()
      expect(statsData).toBeTruthy()
      expect(statsData?.length).toBe(3)

      // Verify each file is logged
      for (const file of files) {
        const fileStats = statsData?.find(s => s.version_name === `${version.name}:${file}`)
        expect(fileStats).toBeTruthy()
      }

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })
  })

  describe('version Name Parsing and Search', () => {
    it('should support searching by version prefix for composite format', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_manifest_checksum_fail'
      baseData.version_build = '4.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
      baseData.version_name = `${version.name}:test.js`

      const response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Search by version prefix (should match composite format)
      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .ilike('version_name', `${version.name}%`)

      expect(error).toBeNull()
      expect(statsData).toBeTruthy()
      expect(statsData?.length).toBeGreaterThanOrEqual(1)
      expect(statsData?.[0]?.version_name).toContain(version.name)

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })

    it('should support searching by filename suffix for composite format', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_manifest_brotli_fail'
      baseData.version_build = '5.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
      const filename = 'unique-test-file.js'
      baseData.version_name = `${version.name}:${filename}`

      const response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Search by filename suffix (should match composite format)
      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .ilike('version_name', `%:${filename}`)

      expect(error).toBeNull()
      expect(statsData).toBeTruthy()
      expect(statsData?.length).toBeGreaterThanOrEqual(1)
      expect(statsData?.[0]?.version_name).toContain(filename)

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })

    it('should distinguish between regular and composite version formats', async () => {
      const uuid1 = randomUUID().toLowerCase()
      const uuid2 = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.version_build = '6.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)

      // Regular format
      baseData.device_id = uuid1
      baseData.action = 'download_manifest_complete'
      baseData.version_name = version.name
      let response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Composite format
      baseData.device_id = uuid2
      baseData.action = 'download_manifest_file_fail'
      baseData.version_name = `${version.name}:error.js`
      response = await postStats(baseData)
      expect(response.status).toBe(200)

      // Verify both entries exist with different formats
      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .in('device_id', [uuid1, uuid2])
        .order('created_at', { ascending: true })

      expect(error).toBeNull()
      expect(statsData).toBeTruthy()
      expect(statsData?.length).toBe(2)

      // First entry should be regular format (no colon)
      expect(statsData?.[0]?.version_name).toBe(version.name)
      expect(statsData?.[0]?.version_name).not.toContain(':')

      // Second entry should be composite format (with colon)
      expect(statsData?.[1]?.version_name).toBe(`${version.name}:error.js`)
      expect(statsData?.[1]?.version_name).toContain(':')

      // Clean up
      await getSupabaseClient().from('devices').delete().in('device_id', [uuid1, uuid2]).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().in('device_id', [uuid1, uuid2]).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })
  })

  describe('edge Cases', () => {
    it('should handle version_name with multiple colons gracefully', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_manifest_file_fail'
      baseData.version_build = '7.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
      // Edge case: filename with colon (e.g., Windows paths)
      baseData.version_name = `${version.name}:C:/path/to/file.js`

      const response = await postStats(baseData)
      expect(response.status).toBe(200)

      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .single()

      expect(error).toBeNull()
      expect(statsData?.version_name).toBe(`${version.name}:C:/path/to/file.js`)

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })

    it('should handle special characters in filenames', async () => {
      const specialFilenames = [
        'file with spaces.js',
        'file-with-dashes.js',
        'file_with_underscores.js',
        'file@2x.png',
        'file[1].js',
      ]

      for (const filename of specialFilenames) {
        const uuid = randomUUID().toLowerCase()
        const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
        baseData.device_id = uuid
        baseData.action = 'download_manifest_file_fail'
        baseData.version_build = '8.0.0'

        const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
        baseData.version_name = `${version.name}:${filename}`

        const response = await postStats(baseData)
        expect(response.status).toBe(200)

        const { error, data: statsData } = await getSupabaseClient()
          .from('stats')
          .select()
          .eq('device_id', uuid)
          .eq('app_id', APP_NAME_DOWNLOAD_STATS)
          .single()

        expect(error).toBeNull()
        expect(statsData?.version_name).toBe(`${version.name}:${filename}`)

        // Clean up
        await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
        await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      }
    })

    it('should handle empty filename in composite format', async () => {
      const uuid = randomUUID().toLowerCase()
      const baseData = getBaseData(APP_NAME_DOWNLOAD_STATS) as StatsPayload
      baseData.device_id = uuid
      baseData.action = 'download_manifest_file_fail'
      baseData.version_build = '9.0.0'

      const version = await createAppVersions(baseData.version_build, APP_NAME_DOWNLOAD_STATS)
      // Edge case: colon but empty filename
      baseData.version_name = `${version.name}:`

      const response = await postStats(baseData)
      expect(response.status).toBe(200)

      const { error, data: statsData } = await getSupabaseClient()
        .from('stats')
        .select()
        .eq('device_id', uuid)
        .eq('app_id', APP_NAME_DOWNLOAD_STATS)
        .single()

      expect(error).toBeNull()
      expect(statsData?.version_name).toBe(`${version.name}:`)

      // Clean up
      await getSupabaseClient().from('devices').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
      await getSupabaseClient().from('stats').delete().eq('device_id', uuid).eq('app_id', APP_NAME_DOWNLOAD_STATS)
    })
  })
})
