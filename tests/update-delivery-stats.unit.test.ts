import { describe, expect, it } from 'vitest'
import { updateDeliveryStatsTestUtils } from '../supabase/functions/_backend/private/update_delivery_stats.ts'
import {
  hasAnalyticsEngineLiveValidationConfig,
  lintAnalyticsEngineSql,
  validateAnalyticsEngineSqlLive,
} from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import {
  buildPlatformUpdateDeliveryDailyCFQuery,
  buildPlatformUpdateDeliveryDeviceCountCFQuery,
  buildPlatformUpdateDeliveryOverviewCFQuery,
  buildUpdateDeliveryTimingEventsCFQuery,
  mergePlatformUpdateDeliveryDailyRows,
  mergePlatformUpdateDeliveryOverviewRows,
  PLATFORM_DELIVERY_CF_CHUNK_DAYS,
  splitPlatformUpdateDeliveryStatsParams,
} from '../supabase/functions/_backend/utils/cloudflare.ts'

describe('update delivery stats helpers', () => {
  it.concurrent('normalizes bounded period days', () => {
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(undefined)).toBe(7)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(1)).toBe(1)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(3)).toBe(3)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(7)).toBe(7)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(30)).toBe(30)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(2)).toBe(2)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(365)).toBe(365)
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(0)).toBeNull()
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(366)).toBeNull()
    expect(updateDeliveryStatsTestUtils.normalizePeriodDays(7.5)).toBeNull()
  })

  it.concurrent('builds platform AE queries that keep the row budget on timed completes', () => {
    const query = buildUpdateDeliveryTimingEventsCFQuery({
      start_date: '2026-07-01T00:00:00.000Z',
      end_date: '2026-07-02T00:00:00.000Z',
      actions: ['download_complete', 'download_zip_complete'],
      require_duration: true,
      limit: 50_000,
    })

    expect(query).toContain('blob2 IN (\'download_complete\', \'download_zip_complete\')')
    expect(query).toContain('AND (double1 > 0 OR position(\'duration\' IN blob4) > 0)')
    expect(query).not.toContain('AND index1 =')
  })

  it.concurrent('aggregates platform delivery latency in AE instead of scanning raw rows', () => {
    const params = {
      query_start: '2026-07-01T22:00:00.000Z',
      period_start: '2026-07-02T00:00:00.000Z',
      end_date: '2026-10-01T00:00:00.000Z',
    }
    const daily = buildPlatformUpdateDeliveryDailyCFQuery(params)
    const overview = buildPlatformUpdateDeliveryOverviewCFQuery(params)

    expect(daily).toContain('quantileExactWeighted(0.50)(duration_ms, sample_weight)')
    expect(daily).toContain('quantileExactWeighted(0.99)(duration_ms, sample_weight)')
    expect(daily).toContain('blob2 IN (\'download_complete\', \'download_zip_complete\', \'download_0\', \'download_zip_start\', \'download_manifest_start\')')
    expect(daily).toContain('max(if(blob2 IN (\'download_complete\', \'download_zip_complete\') AND double1 > 0, double1, 0.0))')
    expect(daily).toContain('toDateTime(\'2100-01-01 00:00:00\')')
    expect(daily).toContain('* 1000.0')
    expect(daily).not.toContain('avgIf(')
    expect(daily).not.toContain('sumIf(')
    expect(daily).not.toContain('countIf(')
    expect(daily).not.toContain(', NULL)')
    expect(daily).not.toContain(', 0)')
    expect(daily).toContain('format(\'{}:{}\', index1, blob1) AS app_device')
    expect(daily).toContain('COUNT(DISTINCT app_device) AS devices')
    expect(daily).toContain('GROUP BY day')
    expect(daily).not.toContain('LIMIT')
    expect(overview).toContain('quantileExactWeighted(0.50)(duration_ms, sample_weight)')
    expect(overview).toContain('COUNT(DISTINCT app_device) AS devices')
    expect(overview).not.toContain('GROUP BY day')
    expect(overview).toContain('AND day >= \'2026-07-02\'')
    expect(overview).toContain('max(if(blob2 IN (\'download_complete\', \'download_zip_complete\') AND double1 > 0, double1, 0.0))')
    expect(overview).not.toContain('avgIf(')
    expect(overview).not.toContain(', NULL)')
    expect(lintAnalyticsEngineSql(daily)).toEqual([])
    expect(lintAnalyticsEngineSql(overview)).toEqual([])
  })

  it('parses platform delivery queries against live Analytics Engine', async () => {
    if (!hasAnalyticsEngineLiveValidationConfig()) {
      console.warn('Skipping live AE check: CF_ANALYTICS_TOKEN / CF_ACCOUNT_ANALYTICS_ID not set')
      return
    }

    const params = {
      query_start: '2026-08-31T22:00:00.000Z',
      period_start: '2026-09-01T00:00:00.000Z',
      end_date: '2026-09-02T00:00:00.000Z',
    }
    const accountId = process.env.CF_ACCOUNT_ANALYTICS_ID!
    const token = process.env.CF_ANALYTICS_TOKEN!
    const queries = [
      ['daily', buildPlatformUpdateDeliveryDailyCFQuery(params)],
      ['overview', buildPlatformUpdateDeliveryOverviewCFQuery(params)],
      ['devices', buildPlatformUpdateDeliveryDeviceCountCFQuery(params)],
    ] as const

    const results = await Promise.all(queries.map(async ([name, query]) => {
      const result = await validateAnalyticsEngineSqlLive(accountId, token, query)
      return [name, result] as const
    }))
    for (const [name, result] of results) {
      expect(result, `${name} ${JSON.stringify(result)}`).toEqual({ ok: true })
    }
  }, 60_000)

  it.concurrent('splits long platform windows into bounded AE chunks', () => {
    const params = {
      query_start: '2026-05-28T22:00:00.000Z',
      period_start: '2026-05-29T00:00:00.000Z',
      end_date: '2026-08-27T00:00:00.000Z',
    }
    const chunks = splitPlatformUpdateDeliveryStatsParams(params, PLATFORM_DELIVERY_CF_CHUNK_DAYS)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.period_start).toBe('2026-05-29T00:00:00.000Z')
    expect(chunks.at(-1)?.end_date).toBe('2026-08-27T00:00:00.000Z')
    for (const chunk of chunks) {
      const spanMs = Date.parse(chunk.end_date) - Date.parse(chunk.period_start)
      expect(spanMs).toBeLessThanOrEqual(PLATFORM_DELIVERY_CF_CHUNK_DAYS * 24 * 60 * 60 * 1000)
      expect(Date.parse(chunk.query_start)).toBe(Date.parse(chunk.period_start) - 2 * 60 * 60 * 1000)
    }
  })

  it.concurrent('merges chunked platform daily rows and overview percentiles', () => {
    const mergedDaily = mergePlatformUpdateDeliveryDailyRows([
      { day: '2026-07-02', samples: 5, devices: 4, p50_ms: 400, p75_ms: 500, p95_ms: 900, p99_ms: 1000 },
      { day: '2026-07-01', samples: 10, devices: 8, p50_ms: 100, p75_ms: 150, p95_ms: 300, p99_ms: 400 },
      { day: '2026-07-02', samples: 20, devices: 12, p50_ms: 200, p75_ms: 250, p95_ms: 500, p99_ms: 700 },
    ])
    expect(mergedDaily).toHaveLength(2)
    expect(mergedDaily[0]?.day).toBe('2026-07-01')
    expect(mergedDaily[1]).toMatchObject({ day: '2026-07-02', samples: 25, devices: 16 })
    expect(mergedDaily[1]?.p50_ms).toBeCloseTo(240, 2)

    const overview = mergePlatformUpdateDeliveryOverviewRows([
      { samples: 10, devices: 8, p50_ms: 100, p75_ms: 150, p95_ms: 300, p99_ms: 400 },
      { samples: 20, devices: 12, p50_ms: 200, p75_ms: 250, p95_ms: 500, p99_ms: 700 },
    ])
    expect(overview.samples).toBe(30)
    expect(overview.devices).toBe(20)
    expect(overview.p50_ms).toBeCloseTo(166.666, 2)
  })

  it.concurrent('builds a full-window platform device count query for chunked reads', () => {
    const params = {
      query_start: '2026-05-28T22:00:00.000Z',
      period_start: '2026-05-29T00:00:00.000Z',
      end_date: '2026-08-27T00:00:00.000Z',
    }
    const query = buildPlatformUpdateDeliveryDeviceCountCFQuery(params)
    expect(query).toContain('COUNT(DISTINCT app_device) AS devices')
    expect(query).not.toContain('GROUP BY day')
    expect(query).toContain('AND day >= \'2026-05-29\'')
  })

  it.concurrent('caps platform delivery period days at 90', () => {
    expect(updateDeliveryStatsTestUtils.normalizePlatformPeriodDays(30)).toBe(30)
    expect(updateDeliveryStatsTestUtils.normalizePlatformPeriodDays(90)).toBe(90)
    expect(updateDeliveryStatsTestUtils.normalizePlatformPeriodDays(365)).toBe(90)
  })

  it.concurrent('builds an empty platform response instead of failing the chart', () => {
    const response = updateDeliveryStatsTestUtils.buildEmptyUpdateDeliveryResponse({
      labels: ['2026-07-01', '2026-07-02'],
      days: 7,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-02T23:59:59.999Z',
      scope: 'platform',
    })
    expect(response.scope).toBe('platform')
    expect(response.overview.samples).toBe(0)
    expect(response.daily.samples).toEqual([0, 0])
    expect(response.daily.p50_ms).toEqual([null, null])
  })

  it.concurrent('keeps pairing AE queries unfiltered so start events remain available', () => {
    const query = buildUpdateDeliveryTimingEventsCFQuery({
      start_date: '2026-07-01T00:00:00.000Z',
      end_date: '2026-07-02T00:00:00.000Z',
      actions: ['download_complete', 'download_0'],
      app_ids: ['com.demo.app'],
      require_duration: false,
      limit: 10,
    })

    expect(query).toContain('AND index1 = \'com.demo.app\'')
    expect(query).not.toContain('position(\'duration\' IN blob4)')
  })

  it.concurrent('normalizes supported scopes', () => {
    expect(updateDeliveryStatsTestUtils.normalizeScope(undefined)).toBe('app')
    expect(updateDeliveryStatsTestUtils.normalizeScope('app')).toBe('app')
    expect(updateDeliveryStatsTestUtils.normalizeScope('org')).toBe('org')
    expect(updateDeliveryStatsTestUtils.normalizeScope('platform')).toBe('platform')
    expect(updateDeliveryStatsTestUtils.normalizeScope('unknown')).toBeNull()
  })

  it.concurrent('generates inclusive UTC day labels', () => {
    expect(updateDeliveryStatsTestUtils.generateDateLabels(
      new Date('2026-07-01T18:00:00Z'),
      new Date('2026-07-03T02:00:00Z'),
    )).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  it('builds overview and daily percentile series', () => {
    const response = updateDeliveryStatsTestUtils.buildUpdateDeliveryResponse({
      labels: ['2026-07-01', '2026-07-02'],
      days: 7,
      start: '2026-07-01T00:00:00.000Z',
      end: '2026-07-02T23:59:59.999Z',
      scope: 'app',
      dailyRows: [
        { day: '2026-07-01', samples: 12, p50_ms: 820.4, p75_ms: 1100, p95_ms: 2400.2, p99_ms: 4100 },
        { day: '2026-07-02', samples: 8, p50_ms: 900, p75_ms: 1300, p95_ms: 2800, p99_ms: 5000 },
      ],
      overviewRow: {
        samples: 20,
        devices: 9,
        p50_ms: 860.2,
        p75_ms: 1200,
        p95_ms: 2600.8,
        p99_ms: 4500,
      },
    })

    expect(response.scope).toBe('app')
    expect(response.overview).toMatchObject({
      samples: 20,
      devices: 9,
      p50_ms: 860,
      p75_ms: 1200,
      p95_ms: 2601,
      p99_ms: 4500,
    })
    expect(response.daily.samples).toEqual([12, 8])
    expect(response.daily.p50_ms).toEqual([820, 900])
    expect(response.daily.p75_ms).toEqual([1100, 1300])
    expect(response.daily.p95_ms).toEqual([2400, 2800])
    expect(response.daily.p99_ms).toEqual([4100, 5000])
  })

  it('keeps null percentiles as null', () => {
    expect(updateDeliveryStatsTestUtils.toMetric(null)).toBeNull()
    expect(updateDeliveryStatsTestUtils.toMetric(undefined)).toBeNull()
    expect(updateDeliveryStatsTestUtils.toMetric('')).toBeNull()
    expect(updateDeliveryStatsTestUtils.toMetric(12.4)).toBe(12)
  })

  it.concurrent('parses duration metadata strings', () => {
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration_ms: '1250.5' })).toBe(1250.5)
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration_ms: 800 })).toBe(800)
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration_ms: '0' })).toBe(0)
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration: '900' })).toBe(900)
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration_ms: '0' })).toBe(0)
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs({ duration_ms: 'nope' })).toBeNull()
    expect(updateDeliveryStatsTestUtils.parseMetaDurationMs(null)).toBeNull()
  })

  it('pairs start/complete events when metadata duration is missing', () => {
    const periodStartMs = Date.parse('2026-07-02T00:00:00.000Z')
    const samples = updateDeliveryStatsTestUtils.buildDeliveriesFromEvents([
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_0',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-02T10:00:00.000Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-02T10:00:01.500Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-2',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: { duration_ms: '2200' },
        duration_ms: null,
        created_at: '2026-07-02T11:00:00.000Z',
      },
    ], { periodStartMs, allowPairing: true })

    expect(samples).toEqual([
      {
        day: '2026-07-02',
        app_id: 'com.demo.app',
        device_id: 'device-1',
        duration_ms: 1500,
      },
      {
        day: '2026-07-02',
        app_id: 'com.demo.app',
        device_id: 'device-2',
        duration_ms: 2200,
      },
    ])
  })

  it('skips pairing for platform-style metadata-only mode', () => {
    const periodStartMs = Date.parse('2026-07-02T00:00:00.000Z')
    const samples = updateDeliveryStatsTestUtils.buildDeliveriesFromEvents([
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_0',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-02T10:00:00.000Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-02T10:00:01.500Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-2',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: { duration_ms: '2200' },
        duration_ms: null,
        created_at: '2026-07-02T11:00:00.000Z',
      },
    ], { periodStartMs, allowPairing: false })

    expect(samples).toEqual([
      {
        day: '2026-07-02',
        app_id: 'com.demo.app',
        device_id: 'device-2',
        duration_ms: 2200,
      },
    ])
  })

  it.concurrent('uses Analytics Engine double1 when metadata is empty', () => {
    expect(updateDeliveryStatsTestUtils.resolveEventDurationMs({
      app_id: 'a',
      device_id: 'd',
      action: 'download_complete',
      version_name: '1.0.0',
      metadata: null,
      duration_ms: 1200,
      created_at: '2026-07-01T00:00:00.000Z',
    })).toBe(1200)
  })

  it('builds samples from double1 without pairing', () => {
    const periodStartMs = Date.parse('2026-07-02T00:00:00.000Z')
    const samples = updateDeliveryStatsTestUtils.buildDeliveriesFromEvents([
      {
        app_id: 'com.demo.app',
        device_id: 'device-9',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: 900,
        created_at: '2026-07-02T12:00:00.000Z',
      },
    ], { periodStartMs, allowPairing: false })
    expect(samples).toEqual([
      { day: '2026-07-02', app_id: 'com.demo.app', device_id: 'device-9', duration_ms: 900 },
    ])
  })

  it('aggregates daily and overview percentiles from samples', () => {
    const { dailyRows, overviewRow } = updateDeliveryStatsTestUtils.aggregateDeliverySamples([
      { day: '2026-07-01', app_id: 'a', device_id: 'd1', duration_ms: 100 },
      { day: '2026-07-01', app_id: 'a', device_id: 'd2', duration_ms: 300 },
      { day: '2026-07-02', app_id: 'a', device_id: 'd1', duration_ms: 200 },
    ])

    expect(dailyRows).toHaveLength(2)
    expect(dailyRows[0]).toMatchObject({ day: '2026-07-01', samples: 2, p50_ms: 200 })
    expect(overviewRow.samples).toBe(3)
    expect(overviewRow.devices).toBe(2)
    expect(overviewRow.p50_ms).toBe(200)
    expect(updateDeliveryStatsTestUtils.percentileCont([100, 200, 300], 0.5)).toBe(200)
  })
})
