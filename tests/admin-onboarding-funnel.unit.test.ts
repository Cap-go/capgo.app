import type { Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  buildAdminOnboardingInstallSourceQuery,
  buildAdminOnboardingProductionDeviceQuery,
  buildAdminOnboardingUpdateDownloadQuery,
  getAdminOnboardingTelemetry,
  isAdminOnboardingTelemetryWithinRetention,
} from '../supabase/functions/_backend/utils/cloudflare.ts'
import { buildAdminOnboardingWizardDropoff, getAdminOnboardingActivationMetrics } from '../supabase/functions/_backend/utils/onboardingFunnel.ts'

vi.mock('hono/adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hono/adapter')>()
  return {
    ...actual,
    env: vi.fn((c: Context) => (c as Context & { env?: Record<string, string | undefined> }).env ?? {}),
  }
})

describe('admin onboarding activation telemetry', () => {
  it.concurrent('uses the Analytics Engine retention boundary', () => {
    const now = new Date('2026-07-13T12:00:00.000Z')

    expect(isAdminOnboardingTelemetryWithinRetention('2026-04-13T12:00:00.000Z', now)).toBe(true)
    expect(isAdminOnboardingTelemetryWithinRetention('2026-04-13T11:59:59.000Z', now)).toBe(false)
    expect(isAdminOnboardingTelemetryWithinRetention('not-a-date', now)).toBe(false)
  })

  it.concurrent('keeps onboarding Analytics Engine SQL under the 10k character limit', () => {
    const windows = Array.from({ length: 100 }, (_, index) => ({
      app_id: `com.customer.very.long.app.identifier.${index}`,
      start_at: '2026-07-01T00:00:00.000Z',
      end_at: '2026-07-08T00:00:00.000Z',
    }))

    // Legacy fixed batches of 100 windows overflow Cloudflare's SQL body limit.
    expect(buildAdminOnboardingProductionDeviceQuery(windows).length).toBeGreaterThan(10_000)
    expect(buildAdminOnboardingUpdateDownloadQuery(windows).length).toBeGreaterThan(10_000)
    expect(buildAdminOnboardingInstallSourceQuery(windows).length).toBeGreaterThan(10_000)

    const safeWindows = windows.slice(0, 40)
    expect(buildAdminOnboardingProductionDeviceQuery(safeWindows).length).toBeLessThanOrEqual(9_000)
    expect(buildAdminOnboardingUpdateDownloadQuery(safeWindows).length).toBeLessThanOrEqual(9_000)
    expect(buildAdminOnboardingInstallSourceQuery(safeWindows).length).toBeLessThanOrEqual(9_000)
  })

  it.concurrent('builds bounded first-event queries for production devices and completed downloads', () => {
    const windows = [{
      app_id: "com.example.o'hara",
      start_at: '2026-07-01T00:00:00.000Z',
      end_at: '2026-07-08T00:00:00.000Z',
    }]

    const productionDeviceQuery = buildAdminOnboardingProductionDeviceQuery(windows)
    expect(productionDeviceQuery).toContain('FROM device_info')
    expect(productionDeviceQuery).toContain("index1 = 'com.example.o''hara'")
    expect(productionDeviceQuery).toContain('double2 = 1')
    expect(productionDeviceQuery).toContain('double3 = 0')
    expect(productionDeviceQuery).toContain("blob3 != ''")
    expect(productionDeviceQuery).toContain('min(timestamp) AS first_at')

    const updateDownloadQuery = buildAdminOnboardingUpdateDownloadQuery(windows)
    expect(updateDownloadQuery).toContain('FROM app_log')
    expect(updateDownloadQuery).toContain("blob2 IN ('download_complete', 'download_manifest_complete', 'download_zip_complete')")
    expect(updateDownloadQuery).toContain('min(timestamp) AS first_at')

    const installSourceQuery = buildAdminOnboardingInstallSourceQuery(windows)
    expect(installSourceQuery).toContain('FROM device_info')
    expect(installSourceQuery).toContain("blob9 IN ('app_store', 'testflight')")
    expect(installSourceQuery).toContain('blob9 AS install_source')
    expect(installSourceQuery).toContain("index1 = 'com.example.o''hara'")
    expect(installSourceQuery).toContain('GROUP BY index1, blob9')
  })

  it('preserves prior batch telemetry when a later Analytics Engine query fails', async () => {
    const windows = Array.from({ length: 101 }, (_, index) => ({
      app_id: 'com.example.' + index,
      start_at: '2026-07-01T00:00:00.000Z',
      end_at: '2026-07-08T00:00:00.000Z',
    }))
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const query = String(init?.body ?? '')
      if (query.includes("index1 = 'com.example.100'") && query.includes('FROM device_info'))
        throw new Error('later batch failed')

      return new Response(JSON.stringify({
        meta: [
          { name: 'app_id', type: 'String' },
          { name: 'first_at', type: 'DateTime' },
        ],
        data: [{
          app_id: 'com.example.0',
          first_at: query.includes('FROM device_info')
            ? '2026-07-02T00:00:00.000Z'
            : '2026-07-03T00:00:00.000Z',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    try {
      const telemetry = await getAdminOnboardingTelemetry({
        env: {
          APP_LOG: {},
          DEVICE_INFO: {},
          CF_ANALYTICS_TOKEN: 'token',
          CF_ACCOUNT_ANALYTICS_ID: 'account',
        },
        get: vi.fn((key: string) => key === 'requestId' ? 'test-request' : undefined),
      } as unknown as Context, windows, '2026-07-01T00:00:00.000Z', new Date('2026-07-13T12:00:00.000Z'))

      expect(telemetry.available).toBe(true)
      expect(telemetry.first_production_device_at_by_app.get('com.example.0')).toEqual(new Date('2026-07-02T00:00:00.000Z'))
      expect(telemetry.first_update_download_at_by_app.get('com.example.0')).toEqual(new Date('2026-07-03T00:00:00.000Z'))
      expect(fetchMock).toHaveBeenCalledTimes(6)
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it.concurrent('counts nested activation funnel stages once within each seven-day window', () => {
    const metrics = getAdminOnboardingActivationMetrics([
      {
        org_id: 'org-alpha',
        app_id: 'app-alpha',
        created_at: '2026-07-01T00:00:00.000Z',
        activation_window_end: '2026-07-08T00:00:00.000Z',
      },
      {
        org_id: 'org-alpha',
        app_id: 'app-alpha-second',
        created_at: '2026-07-01T00:00:00.000Z',
        activation_window_end: '2026-07-08T00:00:00.000Z',
      },
      {
        org_id: 'org-beta',
        app_id: 'app-beta',
        created_at: '2026-07-02T00:00:00.000Z',
        activation_window_end: '2026-07-09T00:00:00.000Z',
      },
      {
        org_id: 'org-gamma',
        app_id: 'app-gamma-device',
        created_at: '2026-07-03T00:00:00.000Z',
        activation_window_end: '2026-07-10T00:00:00.000Z',
      },
      {
        org_id: 'org-gamma',
        app_id: 'app-gamma-download',
        created_at: '2026-07-03T00:00:00.000Z',
        activation_window_end: '2026-07-10T00:00:00.000Z',
      },
    ], {
      available: true,
      first_production_device_at_by_app: new Map([
        ['app-alpha', new Date('2026-07-02T00:00:00.000Z')],
        ['app-alpha-second', new Date('2026-07-03T00:00:00.000Z')],
        ['app-beta', new Date('2026-07-09T00:00:00.000Z')],
        ['app-gamma-device', new Date('2026-07-04T00:00:00.000Z')],
      ]),
      first_update_download_at_by_app: new Map([
        ['app-alpha', new Date('2026-07-04T00:00:00.000Z')],
        ['app-alpha-second', new Date('2026-07-10T00:00:00.000Z')],
        ['app-beta', new Date('2026-07-08T00:00:00.000Z')],
        ['app-gamma-download', new Date('2026-07-05T00:00:00.000Z')],
      ]),
      first_store_live_at_by_app: new Map(),
      first_testflight_at_by_app: new Map(),
    })

    expect(metrics.orgs_with_production_device).toBe(2)
    expect(metrics.orgs_with_update_download).toBe(1)
    expect(metrics.orgs_with_store_live).toBe(0)
    expect(metrics.orgs_with_testflight).toBe(0)
    expect(metrics.trend_by_date.get('2026-07-01')).toEqual({
      orgs_with_production_device: 1,
      orgs_with_update_download: 1,
      orgs_with_testflight: 0,
      orgs_with_store_live: 0,
    })
    expect(metrics.trend_by_date.get('2026-07-02')).toBeUndefined()
    expect(metrics.trend_by_date.get('2026-07-03')).toEqual({
      orgs_with_production_device: 1,
      orgs_with_update_download: 0,
      orgs_with_testflight: 0,
      orgs_with_store_live: 0,
    })
  })

  it.concurrent('counts App Store and TestFlight from Analytics Engine install_source, not Postgres', () => {
    const metrics = getAdminOnboardingActivationMetrics([
      {
        org_id: 'org-store',
        app_id: 'app-store',
        created_at: '2026-07-01T00:00:00.000Z',
        activation_window_end: '2026-07-08T00:00:00.000Z',
      },
      {
        org_id: 'org-both',
        app_id: 'app-both-testflight',
        created_at: '2026-07-01T00:00:00.000Z',
        activation_window_end: '2026-07-08T00:00:00.000Z',
      },
      {
        org_id: 'org-both',
        app_id: 'app-both-store',
        created_at: '2026-07-01T00:00:00.000Z',
        activation_window_end: '2026-07-08T00:00:00.000Z',
      },
      {
        org_id: 'org-testflight',
        app_id: 'app-testflight',
        created_at: '2026-07-02T00:00:00.000Z',
        activation_window_end: '2026-07-09T00:00:00.000Z',
      },
      {
        org_id: 'org-late',
        app_id: 'app-late',
        created_at: '2026-07-03T00:00:00.000Z',
        activation_window_end: '2026-07-10T00:00:00.000Z',
      },
    ], {
      available: true,
      first_production_device_at_by_app: new Map(),
      first_update_download_at_by_app: new Map(),
      first_store_live_at_by_app: new Map([
        ['app-store', new Date('2026-07-02T00:00:00.000Z')],
        ['app-both-store', new Date('2026-07-04T00:00:00.000Z')],
        ['app-late', new Date('2026-07-10T00:00:00.000Z')],
      ]),
      first_testflight_at_by_app: new Map([
        ['app-both-testflight', new Date('2026-07-03T00:00:00.000Z')],
        ['app-testflight', new Date('2026-07-05T00:00:00.000Z')],
      ]),
    })

    expect(metrics.orgs_with_store_live).toBe(2)
    expect(metrics.orgs_with_testflight).toBe(1)
    expect(metrics.trend_by_date.get('2026-07-01')).toEqual({
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
      orgs_with_testflight: 0,
      orgs_with_store_live: 2,
    })
    expect(metrics.trend_by_date.get('2026-07-02')).toEqual({
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
      orgs_with_testflight: 1,
      orgs_with_store_live: 0,
    })
    expect(metrics.trend_by_date.get('2026-07-03')).toBeUndefined()
  })

  it.concurrent('does not report activation data when telemetry is unavailable', () => {
    const metrics = getAdminOnboardingActivationMetrics([], {
      available: false,
      first_production_device_at_by_app: new Map(),
      first_update_download_at_by_app: new Map(),
      first_store_live_at_by_app: new Map(),
      first_testflight_at_by_app: new Map(),
    })

    expect(metrics).toEqual({
      orgs_with_production_device: 0,
      orgs_with_update_download: 0,
      orgs_with_testflight: 0,
      orgs_with_store_live: 0,
      trend_by_date: new Map(),
    })
  })
})

describe('admin onboarding wizard drop-off', () => {
  it.concurrent('fills every wizard bucket and folds unknown steps into not_started', () => {
    expect(buildAdminOnboardingWizardDropoff([
      { step: 'details', count: 4 },
      { step: 'completed', count: 2 },
      { step: 'mystery', count: 1 },
      { step: 'details', count: 3 },
    ])).toEqual([
      { step: 'not_started', count: 1 },
      { step: 'intent', count: 0 },
      { step: 'details', count: 7 },
      { step: 'organization', count: 0 },
      { step: 'choice', count: 0 },
      { step: 'install', count: 0 },
      { step: 'setup', count: 0 },
      { step: 'completed', count: 2 },
      { step: 'abandoned', count: 0 },
    ])
  })
})
