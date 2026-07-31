import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_GLOBAL_STATS_SHARDS } from '../supabase/functions/_backend/utils/global_stats.ts'

const mocks = vi.hoisted(() => {
  const maybeSingle = vi.fn()
  const limit = vi.fn(() => ({ maybeSingle }))
  const order = vi.fn(() => ({ limit }))
  const contains = vi.fn(() => ({ order }))
  const lte = vi.fn(() => ({ contains }))
  const select = vi.fn(() => ({ lte }))
  const from = vi.fn(() => ({ select }))

  return {
    cloudlog: vi.fn(),
    cloudlogErr: vi.fn(),
    contains,
    from,
    getPublicLiveUpdateMetricsCF: vi.fn(),
    limit,
    lte,
    maybeSingle,
    order,
    select,
    serializeError: vi.fn(error => error),
    supabaseAdmin: vi.fn(() => ({ from })),
  }
})

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: mocks.cloudlog,
  cloudlogErr: mocks.cloudlogErr,
  serializeError: mocks.serializeError,
}))

vi.mock('../supabase/functions/_backend/utils/supabase.ts', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}))

vi.mock('../supabase/functions/_backend/utils/cloudflare.ts', () => ({
  getPublicLiveUpdateMetricsCF: mocks.getPublicLiveUpdateMetricsCF,
}))

const { app, getLatestCompletedGlobalStatsDateId, sanitizePublicLiveUpdateMetrics } = await import('../supabase/functions/_backend/private/public_stats.ts')

describe('public stats endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the latest completed UTC day for stats lookup', () => {
    expect(getLatestCompletedGlobalStatsDateId(new Date('2026-05-11T00:06:17.122Z'))).toBe('2026-05-10')
  })

  it('reads the latest completed global stats snapshot', async () => {
    mocks.maybeSingle.mockResolvedValueOnce({
      data: {
        apps: 42,
        stars: 9,
        updates: 100,
        updates_external: 5,
      },
      error: null,
    })

    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      apps: 42,
      stars: 9,
      updates: 105,
    })
    expect(mocks.from).toHaveBeenCalledWith('global_stats')
    expect(mocks.lte).toHaveBeenCalledWith('date_id', '2026-05-10')
    expect(mocks.contains).toHaveBeenCalledWith('completed_shards', [...REQUIRED_GLOBAL_STATS_SHARDS])
    expect(mocks.order).toHaveBeenCalledWith('date_id', { ascending: false })
    expect(mocks.limit).toHaveBeenCalledWith(1)
  })

  it('serves runtime live update metrics with browser CORS', async () => {
    mocks.getPublicLiveUpdateMetricsCF.mockResolvedValueOnce({
      success_rate: 97.5,
      daily: [{ date: '2026-05-10', success_rate: 97.5 }],
      failures: [{ reason: 'download_fail', share: 100 }],
      platforms: [
        { key: 'android', share: 66.7, success_rate: 80, top_failure: { reason: 'download_fail', share: 100 } },
        { key: 'ios', share: 25, success_rate: 90, top_failure: null },
        { key: 'electron', share: 8.3, success_rate: null, top_failure: null },
      ],
      countries: [
        { key: 'US', share: 55, success_rate: 92, top_failure: null },
        { key: 'IQ', share: 10, success_rate: 48, top_failure: { reason: 'download_fail', share: 80 } },
      ],
      updater_versions: [
        { key: '8.1.0', share: 60, success_rate: 93, top_failure: null },
      ],
    })

    const res = await app.request('http://localhost/live_updates', {
      headers: { Origin: 'https://capgo.app' },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://capgo.app')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, s-maxage=300, stale-while-revalidate=600')
    expect(await res.json()).toEqual({
      period_days: 30,
      updated_at: '2026-05-11T12:00:00.000Z',
      success_rate: 97.5,
      daily: [{ date: '2026-05-10', success_rate: 97.5 }],
      failures: [{ reason: 'download_fail', share: 100 }],
      platforms: [
        { key: 'android', share: 66.7, success_rate: 80, top_failure: { reason: 'download_fail', share: 100 } },
        { key: 'ios', share: 25, success_rate: 90, top_failure: null },
        { key: 'electron', share: 8.3, success_rate: null, top_failure: null },
      ],
      countries: [
        { key: 'US', share: 55, success_rate: 92, top_failure: null },
        { key: 'IQ', share: 10, success_rate: 48, top_failure: { reason: 'download_fail', share: 80 } },
      ],
      updater_versions: [
        { key: '8.1.0', share: 60, success_rate: 93, top_failure: null },
      ],
    })
    expect(mocks.getPublicLiveUpdateMetricsCF).toHaveBeenCalledOnce()
  })

  it('does not cache an unavailable live metric query as zero data', async () => {
    const error = new Error('Analytics Engine query failed')
    mocks.getPublicLiveUpdateMetricsCF.mockRejectedValueOnce(error)

    const res = await app.request('http://localhost/live_updates', {
      headers: { Origin: 'https://capgo.app' },
    })

    expect(res.status).toBe(503)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://capgo.app')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ error: 'Live update metrics are temporarily unavailable' })
    expect(mocks.getPublicLiveUpdateMetricsCF).toHaveBeenCalledOnce()
    expect(mocks.cloudlogErr).toHaveBeenCalledWith({
      error,
      message: 'Public live update metrics are unavailable',
      requestId: undefined,
    })
  })

  it('sanitizes public live update metrics to rounded percentages only', () => {
    const dirty = {
      success_rate: 84.246,
      daily: [{ date: '2026-05-10', success_rate: 91.999 }],
      failures: [{ reason: 'download_fail', share: 37.94 }],
      platforms: [
        { key: 'ios', share: 66.666, success_rate: 90.04, top_failure: { reason: 'download_fail', share: 55.55 } },
      ],
      countries: [
        { key: 'US', share: 34.21, success_rate: 93.14, top_failure: null },
      ],
      updater_versions: [
        { key: '8.1.0', share: 22.19, success_rate: 94.21, top_failure: null },
      ],
      devices: 12345,
    }
    const sanitized = sanitizePublicLiveUpdateMetrics(dirty as typeof dirty & { devices: number })

    expect(sanitized).toEqual({
      success_rate: 84.2,
      daily: [{ date: '2026-05-10', success_rate: 92 }],
      failures: [{ reason: 'download_fail', share: 37.9 }],
      platforms: [
        { key: 'ios', share: 66.7, success_rate: 90, top_failure: { reason: 'download_fail', share: 55.5 } },
      ],
      countries: [
        { key: 'US', share: 34.2, success_rate: 93.1, top_failure: null },
      ],
      updater_versions: [
        { key: '8.1.0', share: 22.2, success_rate: 94.2, top_failure: null },
      ],
    })
    expect(sanitized).not.toHaveProperty('devices')
  })

  it('keeps the fallback counters when no completed stats row exists', async () => {
    const error = { code: 'PGRST116', message: 'The result contains 0 rows' }
    mocks.maybeSingle.mockResolvedValueOnce({
      data: null,
      error,
    })

    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      apps: 1688,
      stars: 595,
      updates: 1862788600,
    })
    expect(mocks.cloudlog).toHaveBeenCalledWith({
      error,
      latestCompletedDateId: '2026-05-10',
      message: 'Missing completed global_stats row',
      requestId: undefined,
    })
  })
})
