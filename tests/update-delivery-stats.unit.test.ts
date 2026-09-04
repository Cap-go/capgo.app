import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import { describe, expect, it } from 'vitest'
import { updateDeliveryStatsTestUtils } from '../supabase/functions/_backend/private/update_delivery_stats.ts'
import {
  hasAnalyticsEngineLiveValidationConfig,
  lintAnalyticsEngineSql,
  validateAnalyticsEngineSqlLive,
} from '../supabase/functions/_backend/utils/analyticsEngineSqlLint.ts'
import { buildUpdateDeliveryTimingEventsCFQuery } from '../supabase/functions/_backend/utils/cloudflare.ts'

dayjs.extend(utc)

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

  it.concurrent('builds an unfiltered pairing query for platform (same actions as app/org)', () => {
    const query = buildUpdateDeliveryTimingEventsCFQuery({
      start_date: '2026-07-01T00:00:00.000Z',
      end_date: '2026-07-02T00:00:00.000Z',
      actions: [
        'download_complete',
        'download_zip_complete',
        'download_0',
        'download_zip_start',
        'download_manifest_start',
      ],
      limit: 50_000,
    })

    expect(query).toContain('blob2 IN (\'download_complete\', \'download_zip_complete\', \'download_0\', \'download_zip_start\', \'download_manifest_start\')')
    expect(query).not.toContain('AND index1 =')
    expect(query).not.toContain('position(\'duration\' IN blob4)')
    expect(query).toContain('LIMIT 50000')
    expect(lintAnalyticsEngineSql(query)).toEqual([])
  })

  it('parses the shared delivery event query against live Analytics Engine', async () => {
    if (!hasAnalyticsEngineLiveValidationConfig()) {
      console.warn('Skipping live AE check: CF_ANALYTICS_TOKEN / CF_ACCOUNT_ANALYTICS_ID not set')
      return
    }

    const query = buildUpdateDeliveryTimingEventsCFQuery({
      start_date: '2026-09-01T00:00:00.000Z',
      end_date: '2026-09-02T00:00:00.000Z',
      actions: [
        'download_complete',
        'download_zip_complete',
        'download_0',
        'download_zip_start',
        'download_manifest_start',
      ],
      limit: 50_000,
    })
    const result = await validateAnalyticsEngineSqlLive(
      process.env.CF_ACCOUNT_ANALYTICS_ID!,
      process.env.CF_ANALYTICS_TOKEN!,
      query,
    )
    expect(result, JSON.stringify(result)).toEqual({ ok: true })
  }, 60_000)

  it.concurrent('splits platform windows into UTC day chunks', () => {
    const chunks = updateDeliveryStatsTestUtils.buildDeliveryDayChunks(
      dayjs.utc('2026-07-01T00:00:00.000Z'),
      dayjs.utc('2026-07-31T00:00:00.000Z'),
    )
    expect(chunks).toHaveLength(30)
    expect(chunks[0]?.start.toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(chunks[0]?.end.toISOString()).toBe('2026-07-02T00:00:00.000Z')
    expect(chunks.at(-1)?.end.toISOString()).toBe('2026-07-31T00:00:00.000Z')
    for (const chunk of chunks) {
      const spanMs = chunk.end.valueOf() - chunk.start.valueOf()
      expect(spanMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    }
  })

  it.concurrent('pairs midnight-crossing deliveries the same way for platform and app', () => {
    const periodStartMs = Date.parse('2026-07-02T00:00:00.000Z')
    const samples = updateDeliveryStatsTestUtils.buildDeliveriesFromEvents([
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_0',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-01T23:59:00.000Z',
      },
      {
        app_id: 'com.demo.app',
        device_id: 'device-1',
        action: 'download_complete',
        version_name: '1.2.3',
        metadata: null,
        duration_ms: null,
        created_at: '2026-07-02T00:00:01.500Z',
      },
    ], { periodStartMs, allowPairing: true })

    expect(samples).toEqual([
      {
        day: '2026-07-02',
        app_id: 'com.demo.app',
        device_id: 'device-1',
        duration_ms: 1500 + 60_000,
      },
    ])
  })

  it.concurrent('swallows partial chunk failures only for platform, and never caches them', () => {
    const partial = [new Error('chunk-2')]
    expect(updateDeliveryStatsTestUtils.resolveDeliveryChunkFailures(partial, 3, true)).toBe(1)
    expect(() => updateDeliveryStatsTestUtils.resolveDeliveryChunkFailures(partial, 3, false))
      .toThrow('chunk-2')

    const allFailed = [new Error('a'), new Error('b')]
    expect(() => updateDeliveryStatsTestUtils.resolveDeliveryChunkFailures(allFailed, 2, true))
      .toThrow('a')
    expect(() => updateDeliveryStatsTestUtils.resolveDeliveryChunkFailures(allFailed, 2, false))
      .toThrow('a')

    expect(updateDeliveryStatsTestUtils.shouldCacheUpdateDeliveryStats(10, 0)).toBe(true)
    expect(updateDeliveryStatsTestUtils.shouldCacheUpdateDeliveryStats(10, 1)).toBe(false)
    expect(updateDeliveryStatsTestUtils.shouldCacheUpdateDeliveryStats(0, 0)).toBe(false)
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

  it('can skip pairing when allowPairing is false', () => {
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
