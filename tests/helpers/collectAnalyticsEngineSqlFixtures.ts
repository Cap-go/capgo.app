import type { Context } from 'hono'
import {
  buildReadDevicesCFQuery,
  buildNativeObservePluginTotalDevicesCFQuery,
  buildNativeObservePluginVersionsCFQuery,
  buildUpdateDeliveryTimingEventsCFQuery,
  countDevicesCF,
  countInstallSourcesCF,
  countUpdatesFromLogsCF,
  countUpdatesFromLogsExternalCF,
  getAdminAppsTrend,
  getAdminBandwidthTrend,
  getAdminBundlesTrend,
  getAdminDistributionMetrics,
  getAdminFailureMetrics,
  getAdminMauTrend,
  getAdminOnboardingTelemetry,
  getAdminOrgMetrics,
  getAdminPlatformOverview,
  getAdminStorageTrend,
  getAdminSuccessRate,
  getAdminSuccessRateTrend,
  getAdminUploadMetrics,
  getPluginBreakdownCF,
  getPublicLiveUpdateMetricsCF,
  getUpdateStatsCF,
  readActiveAppsCF,
  readBandwidthUsageCF,
  readDevicesCF,
  readDeviceUsageCF,
  readDeviceVersionCountsCF,
  readLastMonthDevicesByPlatformCF,
  readLastMonthDevicesCF,
  readLastMonthUpdatesCF,
  readNativeVersionUsageCF,
  readStatsCF,
  readStatsVersionCF,
  readUpdateDeliveryTimingEventsCF,
} from '../../supabase/functions/_backend/utils/cloudflare.ts'
import {
  buildGlobalNotificationStatsQuery,
  buildNotificationStatsQuery,
} from '../../supabase/functions/_backend/utils/nativeNotifications.ts'

export interface AnalyticsEngineSqlFixture {
  name: string
  query: string
}

const SAMPLE_APP_ID = 'com.example.app'
const SAMPLE_DEVICE_ID = '11111111-1111-4111-8111-111111111111'
const SAMPLE_START = '2026-06-01 00:00:00'
const SAMPLE_END = '2026-07-01 00:00:00'
const SAMPLE_REFERENCE_DATE = new Date('2026-07-01T00:00:00.000Z')

function createAnalyticsEngineSqlResponse(query: string) {
  const lowerQuery = query.toLowerCase()
  const fields = new Set<string>()

  for (const match of query.matchAll(/\bAS\s+(\w+)\b/g)) {
    fields.add(match[1])
  }

  const scalarDefaults: Record<string, string> = {
    count: '0',
    total: '0',
    mau: '0',
    installs: '0',
    fails: '0',
    failures: '0',
    bandwidth: '0',
    updates: '0',
    apps_count: '0',
    active_apps: '0',
    total_bandwidth: '0',
    android_devices: '0',
    ios_devices: '0',
    electron_devices: '0',
    total_devices: '0',
    active_orgs: '0',
    success_rate: '0',
    failure_rate: '0',
    total_actions: '0',
    device_count: '0',
    failed: '0',
    set: '0',
    get: '0',
    downloads: '0',
    storage_bytes: '0',
    bandwidth_bytes: '0',
    bundles_created: '0',
    apps_created: '0',
    uploads: '0',
    date: '2026-01-01',
    app_id: 'com.example.app',
    org_id: 'org-id',
    device_id: '11111111-1111-4111-8111-111111111111',
    version_name: '1.0.0',
    install_source: 'app_store',
    plugin_version: '8.0.0',
    platform: 'android',
    version_build: '1',
    action: 'get',
    metadata: '{}',
    first_at: '2026-06-01 00:00:00',
    created_at: '2026-01-01 00:00:00',
  }

  for (const name of Object.keys(scalarDefaults)) {
    if (lowerQuery.includes(name))
      fields.add(name)
  }

  if (fields.size === 0)
    fields.add('count')

  const row: Record<string, string> = {}
  const meta = [...fields].map((name) => {
    row[name] = scalarDefaults[name] ?? '0'
    const stringField = name.includes('id')
      || name.includes('source')
      || name.includes('name')
      || name.includes('version')
      || name.includes('date')
      || name.includes('platform')
      || name.includes('action')
      || name.includes('metadata')
      || name.includes('created_at')
      || name.includes('app_id')
      || name.includes('org_id')
    return { name, type: name === 'first_at' ? 'DateTime' : stringField ? 'String' : 'UInt64' }
  })

  return new Response(JSON.stringify({
    meta,
    data: [row],
    rows: 1,
    rows_before_limit_at_least: 1,
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function createMockContext() {
  return {
    env: {
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      CF_ANALYTICS_TOKEN: 'cf-analytics-token',
      CF_ACCOUNT_ANALYTICS_ID: 'cf-account-id',
      DEVICE_INFO: {},
      DEVICE_USAGE: {},
      BANDWIDTH_USAGE: {},
      VERSION_USAGE: {},
      APP_LOG: {},
      APP_LOG_EXTERNAL: {},
    },
    req: {
      url: 'http://localhost/private/devices',
      raw: { cf: { country: 'US' }, headers: new Headers() },
    },
    get: (key: string) => key === 'requestId' ? 'analytics-sql-fixture' : undefined,
  } as unknown as Context
}

export interface AnalyticsEngineSqlCapture {
  fixtures: AnalyticsEngineSqlFixture[]
  setPendingName: (name: string) => void
  restore: () => void
}

export function installAnalyticsEngineSqlCapture(): AnalyticsEngineSqlCapture {
  const fixtures: AnalyticsEngineSqlFixture[] = []
  const pendingCounts = new Map<string, number>()
  const state = { pendingName: 'unknown' }
  const originalFetch = globalThis.fetch
  const originalCaches = globalThis.caches

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const query = String(init?.body ?? '').trim()
    if (query) {
      const count = pendingCounts.get(state.pendingName) ?? 0
      pendingCounts.set(state.pendingName, count + 1)
      const name = count === 0 ? state.pendingName : `${state.pendingName}[${count}]`
      fixtures.push({ name, query })
    }
    return createAnalyticsEngineSqlResponse(query)
  }) as typeof fetch

  globalThis.caches = {
    open: async () => ({
      match: async () => null,
      put: async () => undefined,
    }),
  } as unknown as CacheStorage

  return {
    fixtures,
    setPendingName: (name: string) => {
      state.pendingName = name
    },
    restore: () => {
      globalThis.fetch = originalFetch
      globalThis.caches = originalCaches
    },
  }
}

export async function collectAnalyticsEngineSqlFixtures(): Promise<AnalyticsEngineSqlFixture[]> {
  const capture = installAnalyticsEngineSqlCapture()
  const previousAnalyticsToken = process.env.CF_ANALYTICS_TOKEN
  const previousAnalyticsAccountId = process.env.CF_ACCOUNT_ANALYTICS_ID
  process.env.CF_ANALYTICS_TOKEN = 'cf-analytics-token'
  process.env.CF_ACCOUNT_ANALYTICS_ID = 'cf-account-id'

  try {
    const context = createMockContext()

    async function captureCall(name: string, fn: () => Promise<unknown>) {
      capture.setPendingName(name)
      await fn()
    }

    const staticFixtures: AnalyticsEngineSqlFixture[] = [
      {
        name: 'buildNotificationStatsQuery.app',
        query: buildNotificationStatsQuery({
          dataset: 'notification_events',
          appId: SAMPLE_APP_ID,
          days: 7,
          now: SAMPLE_REFERENCE_DATE,
        }),
      },
      {
        name: 'buildNotificationStatsQuery.orgApps',
        query: buildNotificationStatsQuery({
          dataset: 'notification_events',
          appIds: [SAMPLE_APP_ID, 'com.example.app2'],
          days: 7,
          now: SAMPLE_REFERENCE_DATE,
        }),
      },
      {
        name: 'buildGlobalNotificationStatsQuery.dayWindow',
        query: buildGlobalNotificationStatsQuery({
          dataset: 'notification_events',
          since: new Date('2026-06-30T00:00:00.000Z'),
          until: SAMPLE_REFERENCE_DATE,
        }),
      },
      {
        name: 'buildUpdateDeliveryTimingEventsCFQuery.app',
        query: buildUpdateDeliveryTimingEventsCFQuery({
          start_date: SAMPLE_START,
          end_date: SAMPLE_END,
          actions: ['download_complete', 'download_0'],
          app_ids: [SAMPLE_APP_ID],
          limit: 10,
        }),
      },
      {
        name: 'buildUpdateDeliveryTimingEventsCFQuery.platformRequireDuration',
        query: buildUpdateDeliveryTimingEventsCFQuery({
          start_date: SAMPLE_START,
          end_date: SAMPLE_END,
          actions: ['download_complete', 'download_zip_complete'],
          require_duration: true,
          limit: 50_000,
        }),
      },
      {
        name: 'buildNativeObservePluginVersionsCFQuery.default',
        query: buildNativeObservePluginVersionsCFQuery(SAMPLE_APP_ID, 12),
      },

      {
        name: 'buildReadDevicesCFQuery.default',
        query: buildReadDevicesCFQuery({ app_id: SAMPLE_APP_ID, limit: 10 }, false),
      },
      {
        name: 'buildNativeObservePluginTotalDevicesCFQuery.default',
        query: buildNativeObservePluginTotalDevicesCFQuery(SAMPLE_APP_ID),
      },

      {
        name: 'buildReadDevicesCFQuery.installSources',
        query: buildReadDevicesCFQuery({
          app_id: SAMPLE_APP_ID,
          installSources: ['app_store', 'testflight'],
          cursor: `${SAMPLE_START}|${SAMPLE_DEVICE_ID}`,
          limit: 10,
        }, false),
      },
      {
        name: 'buildReadDevicesCFQuery.customIdMode',
        query: buildReadDevicesCFQuery({
          app_id: SAMPLE_APP_ID,
          search: 'demo',
          version_name: '1.0.0',
          deviceIds: [SAMPLE_DEVICE_ID],
          order: [{ key: 'updated_at', sortable: 'desc' }],
          limit: 10,
        }, true),
      },
      {
        name: 'buildReadDevicesCFQuery.customIds',
        query: buildReadDevicesCFQuery({
          app_id: SAMPLE_APP_ID,
          customIds: ['user-123'],
          order: [{ key: 'updated_at', sortable: 'desc' }],
          limit: 10,
        }, false),
      },
    ]

    await captureCall('readDeviceUsageCF', () => readDeviceUsageCF(context, SAMPLE_APP_ID, SAMPLE_START, SAMPLE_END))
    await captureCall('readBandwidthUsageCF', () => readBandwidthUsageCF(context, SAMPLE_APP_ID, SAMPLE_START, SAMPLE_END))
    await captureCall('readStatsVersionCF', () => readStatsVersionCF(context, SAMPLE_APP_ID, SAMPLE_START, SAMPLE_END))
    await captureCall('readNativeVersionUsageCF', () => readNativeVersionUsageCF(context, SAMPLE_APP_ID, SAMPLE_START, SAMPLE_END))
    await captureCall('readDeviceVersionCountsCF', () => readDeviceVersionCountsCF(context, SAMPLE_APP_ID, 'production'))
    await captureCall('countInstallSourcesCF', () => countInstallSourcesCF(context, SAMPLE_APP_ID))
    await captureCall('countDevicesCF', () => countDevicesCF(context, SAMPLE_APP_ID, false, [SAMPLE_DEVICE_ID], '1.0.0', 'demo'))
    await captureCall('readDevicesCF', () => readDevicesCF(context, {
      app_id: SAMPLE_APP_ID,
      installSources: ['app_store'],
      search: 'demo',
      limit: 10,
    }, false))
    await captureCall('readUpdateDeliveryTimingEventsCF', () => readUpdateDeliveryTimingEventsCF(context, {
      start_date: SAMPLE_START,
      end_date: SAMPLE_END,
      actions: ['download_complete', 'download_0', 'download_zip_start'],
      app_ids: [SAMPLE_APP_ID],
      limit: 10,
    }))
    await captureCall('readStatsCF', () => readStatsCF(context, {
      app_id: SAMPLE_APP_ID,
      start_date: SAMPLE_START,
      end_date: SAMPLE_END,
      search: 'demo',
      actions: ['get', 'set'],
      deviceIds: [SAMPLE_DEVICE_ID],
      order: [{ key: 'created_at', sortable: 'desc' }],
      limit: 10,
    }))
    await captureCall('countUpdatesFromLogsCF', () => countUpdatesFromLogsCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('countUpdatesFromLogsExternalCF', () => countUpdatesFromLogsExternalCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('readActiveAppsCF', () => readActiveAppsCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('readLastMonthUpdatesCF', () => readLastMonthUpdatesCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('readLastMonthDevicesCF', () => readLastMonthDevicesCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('readLastMonthDevicesByPlatformCF', () => readLastMonthDevicesByPlatformCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('getUpdateStatsCF', () => getUpdateStatsCF(context))
    await captureCall('getAdminOnboardingTelemetry', () => getAdminOnboardingTelemetry(context, [{
      app_id: SAMPLE_APP_ID,
      start_at: SAMPLE_START,
      end_at: SAMPLE_END,
    }], SAMPLE_START, SAMPLE_REFERENCE_DATE))
    await captureCall('getAdminUploadMetrics', () => getAdminUploadMetrics(context, SAMPLE_START, SAMPLE_END, SAMPLE_APP_ID))
    await captureCall('getAdminDistributionMetrics', () => getAdminDistributionMetrics(context, SAMPLE_START, SAMPLE_END, SAMPLE_APP_ID))
    await captureCall('getAdminFailureMetrics', () => getAdminFailureMetrics(context, SAMPLE_START, SAMPLE_END, SAMPLE_APP_ID))
    await captureCall('getAdminSuccessRate', () => getAdminSuccessRate(context, SAMPLE_START, SAMPLE_END, SAMPLE_APP_ID))
    await captureCall('getAdminPlatformOverview', () => getAdminPlatformOverview(context, SAMPLE_START, SAMPLE_END, 'org-id'))
    await captureCall('getAdminOrgMetrics', () => getAdminOrgMetrics(context, SAMPLE_START, SAMPLE_END, 10))
    await captureCall('getAdminMauTrend', () => getAdminMauTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getAdminSuccessRateTrend', () => getAdminSuccessRateTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getAdminAppsTrend', () => getAdminAppsTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getAdminBundlesTrend', () => getAdminBundlesTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getAdminStorageTrend', () => getAdminStorageTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getAdminBandwidthTrend', () => getAdminBandwidthTrend(context, SAMPLE_START, SAMPLE_END))
    await captureCall('getPluginBreakdownCF', () => getPluginBreakdownCF(context, SAMPLE_REFERENCE_DATE))
    await captureCall('getPublicLiveUpdateMetricsCF', () => getPublicLiveUpdateMetricsCF(context, SAMPLE_REFERENCE_DATE))

    return [...staticFixtures, ...capture.fixtures]
  }
  finally {
    if (previousAnalyticsToken === undefined)
      delete process.env.CF_ANALYTICS_TOKEN
    else process.env.CF_ANALYTICS_TOKEN = previousAnalyticsToken
    if (previousAnalyticsAccountId === undefined)
      delete process.env.CF_ACCOUNT_ANALYTICS_ID
    else process.env.CF_ACCOUNT_ANALYTICS_ID = previousAnalyticsAccountId
    capture.restore()
  }
}
