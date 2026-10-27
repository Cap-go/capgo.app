import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  cloudlog: vi.fn(),
  cloudlogErr: vi.fn(),
  countAllApps: vi.fn(),
  countAllUpdates: vi.fn(),
  countAllUpdatesExternal: vi.fn(),
  getPublicLiveUpdateMetricsCF: vi.fn(),
  serializeError: vi.fn(error => error),
}))

vi.mock('../supabase/functions/_backend/utils/logging.ts', () => ({
  cloudlog: mocks.cloudlog,
  cloudlogErr: mocks.cloudlogErr,
  serializeError: mocks.serializeError,
}))

vi.mock('../supabase/functions/_backend/utils/stats.ts', () => ({
  countAllApps: mocks.countAllApps,
  countAllUpdates: mocks.countAllUpdates,
  countAllUpdatesExternal: mocks.countAllUpdatesExternal,
}))

vi.mock('../supabase/functions/_backend/utils/public_live_update_metrics.ts', () => ({
  getPublicLiveUpdateMetricsCF: mocks.getPublicLiveUpdateMetricsCF,
}))

const { app, sanitizePublicLiveUpdateMetrics, WEBSITE_STATS_FALLBACK } = await import('../supabase/functions/_backend/private/public_stats.ts')

describe('public stats endpoint', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-11T12:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('computes the website counters from live sources', async () => {
    mocks.countAllApps.mockResolvedValueOnce(42)
    mocks.countAllUpdates.mockResolvedValueOnce(100)
    mocks.countAllUpdatesExternal.mockResolvedValueOnce(5)
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ stargazers_count: 9 })))
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400')
    expect(await res.json()).toEqual({
      apps: 42,
      stars: 9,
      updates: 105,
    })
    expect(fetchMock).toHaveBeenCalledWith('https://api.github.com/repos/Cap-go/capacitor-updater', expect.anything())
  })

  it('serves runtime live update metrics with browser CORS', async () => {
    mocks.getPublicLiveUpdateMetricsCF.mockResolvedValueOnce({
      period_days: 30,
      daily_window_days: 90,
      updated_at: '2026-05-11T12:00:00.000Z',
      success_rate: 97.5,
      first_try_rate: 91.2,
      first_day_rate: 38.4,
      first_day_success_rate: 88.1,
      rollback_rate: 2.6,
      zip_success_rate: 79.4,
      delta_success_rate: 93.8,
      daily: [{ date: '2026-05-10', success_rate: 97.5 }],
      daily_platforms: [{ date: '2026-05-10', ios: 98.5, android: null }],
      daily_platforms_sparkline: [{ date: '2026-05-10', ios: 98.5, android: null }],
      hourly_platforms: [{ date: '2026-05-10 23:00', ios: 97, android: 96 }],
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
      daily_window_days: 90,
      updated_at: '2026-05-11T12:00:00.000Z',
      success_rate: 97.5,
      first_try_rate: 91.2,
      first_day_rate: 38.4,
      first_day_success_rate: 88.1,
      rollback_rate: 2.6,
      zip_success_rate: 79.4,
      delta_success_rate: 93.8,
      daily: [{ date: '2026-05-10', success_rate: 97.5 }],
      daily_platforms: [{ date: '2026-05-10', ios: 98.5, android: null }],
      daily_platforms_sparkline: [{ date: '2026-05-10', ios: 98.5, android: null }],
      hourly_platforms: [{ date: '2026-05-10 23:00', ios: 97, android: 96 }],
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
      first_try_rate: 88.16,
      first_day_rate: 41.04,
      first_day_success_rate: 76.66,
      rollback_rate: 2.14,
      zip_success_rate: 80.04,
      delta_success_rate: 95.55,
      period_days: 30,
      daily_window_days: 90,
      updated_at: '2026-05-11T12:00:00.000Z',
      daily: [{ date: '2026-05-10', success_rate: 91.999 }],
      daily_platforms: [{ date: '2026-05-10', ios: 98.456, android: null }],
      daily_platforms_sparkline: [{ date: '2026-05-10', ios: 98.456, android: null }],
      hourly_platforms: [{ date: '2026-05-10 23:00', ios: 97.04, android: 95.96 }],
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
      first_try_rate: 88.2,
      first_day_rate: 41,
      first_day_success_rate: 76.7,
      rollback_rate: 2.1,
      zip_success_rate: 80,
      delta_success_rate: 95.5,
      period_days: 30,
      daily_window_days: 90,
      updated_at: '2026-05-11T12:00:00.000Z',
      daily: [{ date: '2026-05-10', success_rate: 92 }],
      daily_platforms: [{ date: '2026-05-10', ios: 98.5, android: null }],
      daily_platforms_sparkline: [{ date: '2026-05-10', ios: 98.5, android: null }],
      hourly_platforms: [{ date: '2026-05-10 23:00', ios: 97, android: 96 }],
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

  it('keeps missing reliability rates as null', () => {
    const sanitized = sanitizePublicLiveUpdateMetrics({
      success_rate: 80,
      first_try_rate: null,
      first_day_rate: null,
      first_day_success_rate: null,
      rollback_rate: null,
      zip_success_rate: null,
      delta_success_rate: null,
        period_days: 30,
        daily_window_days: 90,
        updated_at: '2026-05-11T12:00:00.000Z',
      daily: [],
      daily_platforms: [],
      daily_platforms_sparkline: [],
      hourly_platforms: [],
      failures: [],
      platforms: [],
      countries: [],
      updater_versions: [],
    })

    expect(sanitized.first_try_rate).toBeNull()
    expect(sanitized.first_day_rate).toBeNull()
    expect(sanitized.first_day_success_rate).toBeNull()
    expect(sanitized.rollback_rate).toBeNull()
    expect(sanitized.zip_success_rate).toBeNull()
    expect(sanitized.delta_success_rate).toBeNull()
  })

  it('falls back per counter when a source is unavailable', async () => {
    mocks.countAllApps.mockResolvedValueOnce(42)
    mocks.countAllUpdates.mockResolvedValueOnce(0)
    mocks.countAllUpdatesExternal.mockResolvedValueOnce(5)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('rate limited', { status: 403 })))

    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await res.json()).toEqual({
      apps: 42,
      stars: WEBSITE_STATS_FALLBACK.stars,
      updates: WEBSITE_STATS_FALLBACK.updates,
    })
    expect(mocks.cloudlog).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Website stats source unavailable, using fallback counters',
    }))
  })

  it('keeps the hardcoded fallback counters when every source fails', async () => {
    mocks.countAllApps.mockRejectedValueOnce(new Error('db down'))
    mocks.countAllUpdates.mockRejectedValueOnce(new Error('analytics down'))
    mocks.countAllUpdatesExternal.mockRejectedValueOnce(new Error('analytics down'))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network down')))

    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      apps: 1688,
      stars: 595,
      updates: 1862788600,
    })
  })
})
