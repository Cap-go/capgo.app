import type { Context } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPublicLiveUpdateMetricsCF } from '../supabase/functions/_backend/utils/cloudflare.ts'

interface AnalyticsColumn { name: string, type: string }

function analyticsResponse(meta: AnalyticsColumn[], data: Array<Record<string, string>>) {
  return new Response(JSON.stringify({
    meta,
    data,
    rows: data.length,
    rows_before_limit_at_least: data.length,
  }), { headers: { 'content-type': 'application/json' } })
}

function createContext() {
  return {
    env: {
      APP_LOG: {},
      DEVICE_USAGE: {},
      DEVICE_INFO: {},
      CF_ANALYTICS_TOKEN: 'analytics-token',
      CF_ACCOUNT_ANALYTICS_ID: 'analytics-account',
    },
    req: {
      url: 'http://localhost/private/website_stats/live_updates',
      raw: { headers: new Headers() },
    },
    get: () => 'public-live-update-metrics-test',
  } as unknown as Context
}

describe('public live update metrics', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('returns usage shares plus dimensional success when denormalized log fields exist', async () => {
    const queries: string[] = []
    vi.stubEnv('CF_ANALYTICS_TOKEN', 'analytics-token')
    vi.stubEnv('CF_ACCOUNT_ANALYTICS_ID', 'analytics-account')
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const query = String(init?.body ?? '')
      queries.push(query)

      if (query.includes('SELECT date, sum(succeeded) AS successes') && query.includes('GROUP BY date')) {
        return analyticsResponse(
          [
            { name: 'date', type: 'String' },
            { name: 'successes', type: 'UInt64' },
            { name: 'failures', type: 'UInt64' },
          ],
          [{ date: '2026-06-30', successes: '90', failures: '10' }],
        )
      }

      if (query.includes('SELECT action, count() AS devices') && !query.includes('AS key')) {
        return analyticsResponse(
          [
            { name: 'action', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [{ action: 'download_fail', devices: '3' }],
        )
      }

      if (query.includes('FROM device_usage')) {
        return analyticsResponse(
          [
            { name: 'platform', type: 'Float64' },
            { name: 'devices', type: 'UInt64' },
          ],
          [
            { platform: '0', devices: '80' },
            { platform: '1', devices: '30' },
            { platform: '2', devices: '10' },
          ],
        )
      }

      if (query.includes('platform AS key') && query.includes('sum(succeeded)')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'successes', type: 'UInt64' },
            { name: 'failures', type: 'UInt64' },
          ],
          [
            { key: 'ios', successes: '80', failures: '5' },
            { key: 'android', successes: '40', failures: '20' },
          ],
        )
      }

      if (query.includes('platform AS key') && query.includes('action, count()')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'action', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [
            { key: 'android', action: 'download_fail', devices: '12' },
            { key: 'ios', action: 'checksum_fail', devices: '2' },
          ],
        )
      }

      if (query.includes('FROM device_info') && query.includes('blob10')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [
            { key: 'US', devices: '70' },
            { key: 'IQ', devices: '20' },
            { key: 'DE', devices: '10' },
          ],
        )
      }

      if (query.includes('country AS key') && query.includes('sum(succeeded)')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'successes', type: 'UInt64' },
            { name: 'failures', type: 'UInt64' },
          ],
          [
            { key: 'US', successes: '90', failures: '5' },
            { key: 'IQ', successes: '20', failures: '40' },
          ],
        )
      }

      if (query.includes('country AS key') && query.includes('action, count()')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'action', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [
            { key: 'IQ', action: 'download_fail', devices: '30' },
            { key: 'US', action: 'unzip_fail', devices: '2' },
          ],
        )
      }

      if (query.includes('FROM device_info') && query.includes('blob3')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [
            { key: '8.1.0', devices: '60' },
            { key: '7.34.2', devices: '40' },
          ],
        )
      }

      if (query.includes('plugin_version AS key') && query.includes('sum(succeeded)')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'successes', type: 'UInt64' },
            { name: 'failures', type: 'UInt64' },
          ],
          [
            { key: '8.1.0', successes: '70', failures: '5' },
            { key: '7.34.2', successes: '30', failures: '20' },
          ],
        )
      }

      if (query.includes('plugin_version AS key') && query.includes('action, count()')) {
        return analyticsResponse(
          [
            { name: 'key', type: 'String' },
            { name: 'action', type: 'String' },
            { name: 'devices', type: 'UInt64' },
          ],
          [{ key: '7.34.2', action: 'download_fail', devices: '15' }],
        )
      }

      return analyticsResponse([], [])
    }))

    const metrics = await getPublicLiveUpdateMetricsCF(
      createContext(),
      new Date('2026-07-01T00:00:00.000Z'),
    )

    expect(metrics.success_rate).toBe(90)
    expect(metrics.failures).toEqual([{ reason: 'download_fail', share: 100 }])
    expect(metrics.platforms.map(row => row.key)).toEqual(['android', 'ios', 'electron'])
    expect(metrics.platforms.find(row => row.key === 'android')?.success_rate).toBe(66.7)
    expect(metrics.platforms.find(row => row.key === 'android')?.top_failure).toEqual({
      reason: 'download_fail',
      share: 100,
    })
    expect(metrics.countries[0]).toMatchObject({ key: 'US', share: 70 })
    expect(metrics.countries.find(row => row.key === 'US')?.success_rate).toBe(94.7)
    expect(metrics.countries.find(row => row.key === 'IQ')?.success_rate).toBe(33.3)
    expect(metrics.updater_versions[0]).toMatchObject({ key: '8.1.0', share: 60 })
    expect(metrics.updater_versions.find(row => row.key === '8.1.0')?.success_rate).toBe(93.3)
    expect(queries.length).toBe(11)
    expect(queries.join('\n')).toContain('blob6')
    expect(queries.join('\n')).toContain('blob7')
    expect(queries.join('\n')).toContain('blob10')
  })
})
