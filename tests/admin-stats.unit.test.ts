import { describe, expect, it } from 'vitest'
import { adminStatsBodySchema, MAX_ADMIN_STATS_LIMIT, MAX_ADMIN_STATS_OFFSET } from '../supabase/functions/_backend/private/admin_stats.ts'
import { safeParseSchema } from '../supabase/functions/_backend/utils/schema_validation.ts'
import { buildPluginBreakdownResult, normalizeAnalyticsLimit } from '../supabase/functions/_backend/utils/cloudflare.ts'

describe('admin stats validation', () => {
  const baseBody = {
    metric_category: 'org_metrics',
    start_date: '2025-01-01T00:00:00.000Z',
    end_date: '2025-01-31T00:00:00.000Z',
  }

  it.each([
    ['sql injection string limit', { limit: '1 UNION SELECT 1' }],
    ['decimal limit', { limit: 1.5 }],
    ['negative offset', { offset: -1 }],
    ['oversized limit', { limit: MAX_ADMIN_STATS_LIMIT + 1 }],
    ['oversized offset', { offset: MAX_ADMIN_STATS_OFFSET + 1 }],
  ])('rejects %s', (_label, body) => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      ...body,
    })

    expect(parsed.success).toBe(false)
  })

  it('accepts bounded integer pagination', () => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      limit: 250,
      offset: 10,
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success)
      return

    expect(parsed.data.limit).toBe(250)
    expect(parsed.data.offset).toBe(10)
  })

  it('accepts the customer country breakdown metric', () => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      metric_category: 'customer_country_breakdown',
    })

    expect(parsed.success).toBe(true)
  })

  it.concurrent('accepts the trial plan breakdown metric', () => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      metric_category: 'trial_plan_breakdown',
    })

    expect(parsed.success).toBe(true)
  })

  it.concurrent('accepts organization insights filters', () => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      metric_category: 'organization_insights',
      plan_name: 'Solo',
      billing_type: 'monthly',
      paid_only: true,
      search: 'admin stats',
      limit: 50,
      offset: 0,
    })

    expect(parsed.success).toBe(true)
    if (!parsed.success)
      return

    expect(parsed.data.plan_name).toBe('Solo')
    expect(parsed.data.billing_type).toBe('monthly')
    expect(parsed.data.paid_only).toBe(true)
    expect(parsed.data.search).toBe('admin stats')
  })

  it.each([
    ['plain date start', { start_date: '2025-01-01' }],
    ['plain date end', { end_date: '2025-01-31' }],
    ['offset datetime start', { start_date: '2025-01-01T01:00:00+01:00' }],
    ['offset datetime end', { end_date: '2025-01-31T01:00:00+01:00' }],
  ])('rejects non-UTC ISO datetimes for %s', (_label, body) => {
    const parsed = safeParseSchema(adminStatsBodySchema, {
      ...baseBody,
      ...body,
    })

    expect(parsed.success).toBe(false)
  })
})

describe('normalizeAnalyticsLimit', () => {
  it.each([
    ['string injection', '1 UNION SELECT 1', 100],
    ['negative number', -10, 100],
    ['zero', 0, 100],
    ['decimal', 12.8, 12],
    ['oversized', 99_999_999, 50_000],
  ])('normalizes %s', (_label, input, expected) => {
    expect(normalizeAnalyticsLimit(input, 100)).toBe(expected)
  })
})

describe('buildPluginBreakdownResult', () => {
  it.concurrent('aggregates plugin versions with major breakdown and top app IDs', () => {
    const result = buildPluginBreakdownResult([
      { plugin_version: '8.1.0', app_id: 'com.capgo.first', device_count: '8' },
      { plugin_version: '8.1.0', app_id: 'com.capgo.second', device_count: 4 },
      { plugin_version: '7.5.1', app_id: 'com.capgo.third', device_count: 4 },
      { plugin_version: '', app_id: 'com.capgo.empty', device_count: 10 },
      { plugin_version: '8.1.0', app_id: '', device_count: 10 },
    ])

    expect(result.version_breakdown).toEqual({
      '8.1.0': 75,
      '7.5.1': 25,
    })
    expect(result.major_breakdown).toEqual({
      8: 75,
      7: 25,
    })
    expect(result.version_ladder).toEqual([
      {
        version: '8.1.0',
        device_count: 12,
        percent: 75,
        top_apps: [
          { app_id: 'com.capgo.first', device_count: 8, share: 66.67 },
          { app_id: 'com.capgo.second', device_count: 4, share: 33.33 },
        ],
      },
      {
        version: '7.5.1',
        device_count: 4,
        percent: 25,
        top_apps: [
          { app_id: 'com.capgo.third', device_count: 4, share: 100 },
        ],
      },
    ])
  })
})

import { normalizeAdminStatsDate } from '../supabase/functions/_backend/utils/pg.ts'

describe('normalizeAdminStatsDate', () => {
  it.concurrent('normalizes Date objects and ISO timestamps to YYYY-MM-DD', () => {
    expect(normalizeAdminStatsDate(new Date('2026-06-20T15:30:00.000Z'))).toBe('2026-06-20')
    expect(normalizeAdminStatsDate('2026-06-20T00:00:00.000Z')).toBe('2026-06-20')
    expect(normalizeAdminStatsDate('2026-06-20')).toBe('2026-06-20')
  })
})
